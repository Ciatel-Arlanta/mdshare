// A "source" is anything the reader can browse: a paired laptop, a folder on
// the phone, or a single file opened with "Open with". Screens only talk to
// this interface.

import { Directory, File } from 'expo-file-system';
import { create } from 'zustand';

import { cache } from './cache';
import { useNearby } from './discovery';
import { Client, HttpError, candidatesFor, firstReachable } from './net';
import { isImage, isMarkdown, mimeFor } from './paths';
import { tokens, useStore } from './store';
import type { ChangeEvent, SearchHit, TreeNode } from './types';

export type Status = 'connecting' | 'online' | 'offline' | 'unpaired' | 'local';

export interface SourceState {
  status: Status;
  /** Live reload stream connected. */
  live: boolean;
  /** Which address answered, e.g. "Wi-Fi" or "Tailscale". */
  via?: string;
  error?: string;
}

export const useSourceStates = create<Record<string, SourceState>>(() => ({}));

function setState(id: string, patch: Partial<SourceState>) {
  useSourceStates.setState((s) => ({
    [id]: { ...(s[id] ?? { status: 'connecting', live: false }), ...patch },
  }));
}

export interface ReadResult {
  text: string;
  /** Served from the offline copy because the laptop isn't reachable. */
  offline: boolean;
}

export interface Source {
  readonly id: string;
  readonly kind: 'laptop' | 'folder' | 'file';
  title(): string;
  /** For single-file sources, the one document to open. */
  entry(): string | undefined;
  tree(): Promise<{ tree: TreeNode; offline: boolean }>;
  read(path: string): Promise<ReadResult>;
  /** URL prefix for images, if the reader can load them directly. */
  assetBase(): string | undefined;
  /** Image as a data URI, for sources without `assetBase`. */
  asset(path: string): Promise<string | null>;
  search(q: string): Promise<SearchHit[]>;
  /** Change notifications (live reload). Returns an unsubscribe function. */
  subscribe(fn: (e: ChangeEvent) => void): () => void;
  /** Try to (re)connect now. */
  refresh(): void;
  /** Stop all network activity; the source is being removed. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Laptop.

const RECONNECT_MS = 5000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;

class LaptopSource implements Source {
  readonly kind = 'laptop' as const;
  private client: Client | null = null;
  private connecting: Promise<Client | null> | null = null;
  private lastAttempt = 0;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private stopEvents: (() => void) | null = null;
  private entryPath: string | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = RETRY_MIN_MS;
  /** The live stream dropped; tell listeners to reload once it's back. */
  private needsResync = false;
  private disposed = false;

  constructor(
    readonly id: string,
    private readonly serverId: string,
  ) {}

  private laptop() {
    return useStore.getState().laptops[this.serverId];
  }

  title() {
    const l = this.laptop();
    return l?.shareName ?? l?.host ?? 'Laptop';
  }

  entry() {
    return this.entryPath;
  }

  refresh() {
    this.lastAttempt = 0;
    this.client = null;
    this.stopEvents?.();
    this.stopEvents = null;
    this.retryDelay = RETRY_MIN_MS;
    void this.connect();
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
    this.stopEvents?.();
    this.stopEvents = null;
    this.client = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private connect(): Promise<Client | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    if (Date.now() - this.lastAttempt < RECONNECT_MS) return Promise.resolve(null);
    this.lastAttempt = Date.now();
    setState(this.id, { status: 'connecting', error: undefined });

    this.connecting = (async () => {
      const laptop = this.laptop();
      const token = await tokens.get(this.serverId);
      if (!laptop || !token) {
        setState(this.id, { status: 'unpaired', live: false, error: 'This laptop is no longer paired.' });
        return null;
      }
      const nearby = useNearby.getState().byId[this.serverId];
      const fromMdns = nearby?.addresses.map((host) => ({ host, port: nearby.port })) ?? [];
      try {
        const { candidate } = await firstReachable(candidatesFor(laptop, fromMdns), this.serverId);
        const client = new Client(candidate.host, candidate.port, token);
        const info = await client.info();
        this.entryPath = info.kind === 'file' ? (info.entry ?? undefined) : undefined;
        const tailscale = info.addrs.some((a) => a.host === candidate.host && a.kind === 'tailscale');
        useStore.getState().updateLaptop(this.serverId, {
          hosts: info.addrs.length ? info.addrs.map((a) => a.host) : laptop.hosts,
          port: info.port,
          lastHost: candidate.host,
          shareName: info.name,
          host: info.host,
          lastSeen: Date.now(),
        });
        if (this.disposed) return null;
        this.client = client;
        setState(this.id, { status: 'online', via: tailscale ? 'Tailscale' : 'Wi-Fi', error: undefined });
        this.startEvents();
        return client;
      } catch (e) {
        if (this.disposed) return null;
        const unpaired = e instanceof HttpError && e.status === 401;
        setState(this.id, {
          status: unpaired ? 'unpaired' : 'offline',
          live: false,
          error: unpaired
            ? 'This laptop no longer recognises this phone. Pair it again.'
            : 'Not sharing right now, or out of reach.',
        });
        return null;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private emit(e: ChangeEvent) {
    this.listeners.forEach((fn) => fn(e));
  }

  private startEvents() {
    if (!this.client || this.stopEvents || !this.listeners.size) return;
    this.stopEvents = this.client.events(
      (e) => this.emit(e),
      (live) => {
        if (!live) {
          this.lost();
          return;
        }
        setState(this.id, { live: true });
        this.retryDelay = RETRY_MIN_MS;
        if (this.needsResync) {
          this.needsResync = false;
          this.emit({ paths: [], tree: true, resync: true });
        }
      },
    );
  }

  /**
   * The connection dropped (laptop asleep, Wi-Fi changed, share stopped).
   * The SSE library doesn't retry network errors itself, so reconnect from
   * scratch: that re-probes every address, which also handles moving between
   * Wi-Fi and Tailscale.
   */
  private lost() {
    this.stopEvents?.();
    this.stopEvents = null;
    this.client = null;
    this.needsResync = true;
    const status = useSourceStates.getState()[this.id]?.status;
    setState(this.id, {
      live: false,
      ...(status === 'online' ? { status: 'offline' as const, error: 'Lost the connection.' } : {}),
    });
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.retryTimer || this.disposed || !this.listeners.size) return;
    if (useSourceStates.getState()[this.id]?.status === 'unpaired') return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.lastAttempt = 0;
      void this.connect().then((client) => {
        if (!client) {
          this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
          this.scheduleRetry();
        }
      });
    }, this.retryDelay);
  }

  private failed(e: unknown) {
    if (e instanceof HttpError && e.status === 401) {
      setState(this.id, { status: 'unpaired', live: false, error: 'This laptop no longer recognises this phone.' });
    } else if (!(e instanceof HttpError)) {
      // Network failure: drop the client so the next call reconnects.
      this.lost();
    }
  }

  async tree() {
    const client = await this.connect();
    if (client) {
      try {
        const tree = await client.tree();
        cache.saveTree(this.id, tree);
        return { tree, offline: false };
      } catch (e) {
        this.failed(e);
      }
    }
    const cached = cache.tree(this.id);
    if (cached) return { tree: cached, offline: true };
    throw new Error(useSourceStates.getState()[this.id]?.error ?? "Couldn't reach the laptop.");
  }

  async read(path: string): Promise<ReadResult> {
    const cached = cache.doc(this.id, path);
    const client = await this.connect();
    if (client) {
      try {
        const res = await client.file(path, cached?.meta.etag ?? undefined);
        if (res === null && cached) return { text: cached.text, offline: false };
        if (res) {
          cache.saveDoc(this.id, path, res.text, res.etag);
          return { text: res.text, offline: false };
        }
      } catch (e) {
        this.failed(e);
        if (e instanceof HttpError && e.status === 404) throw new Error('This file is no longer shared.');
      }
    }
    if (cached) return { text: cached.text, offline: true };
    throw new Error("The laptop isn't reachable and there's no saved copy of this file.");
  }

  assetBase() {
    return this.client?.assetBase;
  }

  async asset() {
    return null;
  }

  async search(q: string) {
    const client = await this.connect();
    if (!client) throw new Error("Search needs the laptop to be sharing.");
    return client.search(q);
  }

  subscribe(fn: (e: ChangeEvent) => void) {
    this.listeners.add(fn);
    if (this.client) this.startEvents();
    else
      void this.connect().then((client) => {
        if (!client) this.scheduleRetry();
      });
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) {
        this.stopEvents?.();
        this.stopEvents = null;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        if (!this.disposed) setState(this.id, { live: false });
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Folder on the phone (Storage Access Framework).

const SKIP = new Set(['.git', 'node_modules', 'target', '.venv', '__pycache__', '.next', '.expo', '.gradle']);
const MAX_LOCAL_FILES = 5000;

class FolderSource implements Source {
  readonly kind = 'folder' as const;
  private uris = new Map<string, string>();

  constructor(
    readonly id: string,
    private readonly folderId: string,
  ) {
    setState(id, { status: 'local', live: false });
  }

  private folder() {
    return useStore.getState().folders[this.folderId];
  }

  title() {
    return this.folder()?.name ?? 'Folder';
  }

  entry() {
    return undefined;
  }

  refresh() {}

  async tree() {
    const folder = this.folder();
    if (!folder) throw new Error('This folder was removed.');
    this.uris.clear();
    let budget = MAX_LOCAL_FILES;
    const walk = (dir: Directory, prefix: string, depth: number): TreeNode[] => {
      if (depth > 12) return [];
      let items: (Directory | File)[];
      try {
        items = dir.list();
      } catch {
        return [];
      }
      items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      const dirs: TreeNode[] = [];
      const files: TreeNode[] = [];
      for (const item of items) {
        if (budget <= 0) break;
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (item instanceof Directory) {
          if (SKIP.has(item.name)) continue;
          const children = walk(item, path, depth + 1);
          if (children.length) dirs.push({ kind: 'dir', name: item.name, path, children });
        } else if (isMarkdown(item.name) || isImage(item.name)) {
          budget -= 1;
          this.uris.set(path, item.uri);
          files.push({
            kind: 'file',
            name: item.name,
            path,
            size: item.size ?? 0,
            mtime: Math.floor((item.modificationTime ?? 0) / 1000),
            markdown: isMarkdown(item.name),
          });
        }
      }
      return [...dirs, ...files];
    };
    try {
      const root = new Directory(folder.uri);
      const children = walk(root, '', 0);
      return { tree: { kind: 'dir', name: folder.name, path: '', children } as TreeNode, offline: false };
    } catch {
      throw new Error("Can't open this folder any more. Remove it and pick it again.");
    }
  }

  private async uriFor(path: string): Promise<string | undefined> {
    if (!this.uris.size) await this.tree();
    return this.uris.get(path);
  }

  async read(path: string) {
    const uri = await this.uriFor(path);
    if (!uri) throw new Error('File not found in this folder.');
    return { text: await new File(uri).text(), offline: false };
  }

  assetBase() {
    return undefined;
  }

  async asset(path: string) {
    const uri = await this.uriFor(path);
    if (!uri) return null;
    try {
      return `data:${mimeFor(path)};base64,${await new File(uri).base64()}`;
    } catch {
      return null;
    }
  }

  async search(q: string) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    if (!this.uris.size) await this.tree();
    const hits: SearchHit[] = [];
    for (const [path, uri] of this.uris) {
      if (!isMarkdown(path)) continue;
      if (path.toLowerCase().includes(needle)) hits.push({ path, line: 0, text: '' });
      let text: string;
      try {
        text = await new File(uri).text();
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < 200; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ path, line: i + 1, text: lines[i].trim().slice(0, 160) });
        }
      }
      if (hits.length >= 200) break;
    }
    return hits;
  }

  subscribe() {
    return () => {};
  }

  dispose() {}
}

// ---------------------------------------------------------------------------
// A single file.

class FileSource implements Source {
  readonly kind = 'file' as const;

  constructor(
    readonly id: string,
    private readonly fileId: string,
  ) {
    setState(id, { status: 'local', live: false });
  }

  private file() {
    return useStore.getState().files[this.fileId];
  }

  title() {
    return this.file()?.name ?? 'Document';
  }

  entry() {
    return this.file()?.name;
  }

  refresh() {}

  async tree() {
    const f = this.file();
    if (!f) throw new Error('This file was removed.');
    return {
      tree: {
        kind: 'dir',
        name: f.name,
        path: '',
        children: [{ kind: 'file', name: f.name, path: f.name, size: 0, mtime: 0, markdown: true }],
      } as TreeNode,
      offline: false,
    };
  }

  async read() {
    const f = this.file();
    if (!f) throw new Error('This file was removed.');
    try {
      const text = await new File(f.uri).text();
      cache.saveDoc(this.id, f.name, text, null);
      return { text, offline: false };
    } catch {
      // Permission to a shared content:// URI can lapse; fall back to the copy.
      const cached = cache.doc(this.id, f.name);
      if (cached) return { text: cached.text, offline: true };
      throw new Error("Can't open this file any more. Open it again from your file manager.");
    }
  }

  assetBase() {
    return undefined;
  }

  async asset() {
    return null;
  }

  async search() {
    return [];
  }

  subscribe() {
    return () => {};
  }

  dispose() {}
}

// ---------------------------------------------------------------------------

const sources = new Map<string, Source>();

export function getSource(id: string): Source | null {
  const existing = sources.get(id);
  if (existing) return existing;
  const [prefix, rest] = [id.slice(0, 2), id.slice(2)];
  const s = useStore.getState();
  let source: Source | null = null;
  if (prefix === 'l-' && s.laptops[rest]) source = new LaptopSource(id, rest);
  else if (prefix === 'f-' && s.folders[rest]) source = new FolderSource(id, rest);
  else if (prefix === 'd-' && s.files[rest]) source = new FileSource(id, rest);
  if (source) sources.set(id, source);
  return source;
}

export function forgetSource(id: string) {
  sources.get(id)?.dispose();
  sources.delete(id);
  cache.clear(id);
  useSourceStates.setState((s) => {
    const { [id]: _, ...rest } = s;
    return rest;
  }, true);
}

/** Flattens a tree into its markdown files, in tree order. */
export function markdownFiles(tree: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.kind === 'dir') n.children.forEach(walk);
    else if (n.markdown) out.push(n.path);
  };
  walk(tree);
  return out;
}
