// Talking to a laptop: probing addresses, pairing, and the authenticated API.

import EventSource from 'react-native-sse';

import type { ChangeEvent, Info, Laptop, PairResponse, Ping, SearchHit, ShareInfo, TreeNode } from './types';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const baseUrl = (host: string, port: number) =>
  // Bracket IPv6 literals.
  `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 4000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function errorFrom(res: Response): Promise<HttpError> {
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.error) message = body.error;
  } catch {}
  return new HttpError(res.status, message);
}

/** With a paired phone's token, the answer also lists the laptop's other shares. */
export async function ping(host: string, port: number, ms = 3000, token?: string): Promise<Ping> {
  const init = token ? { headers: { authorization: `Bearer ${token}` } } : {};
  const res = await fetchWithTimeout(`${baseUrl(host, port)}/api/ping`, init, ms);
  if (!res.ok) throw await errorFrom(res);
  const body = (await res.json()) as Ping;
  if (body.app !== 'mdshare') throw new Error('Not an mdshare server');
  return body;
}

export interface Candidate {
  host: string;
  port: number;
}

export interface ProbeOptions {
  /** Only accept this laptop. */
  serverId?: string;
  /** Prefer this share on it. */
  shareId?: string;
  /** This phone's token, so answers list the laptop's other shares. */
  token?: string;
  ms?: number;
}

/**
 * Probes all candidates at once and resolves with the first that answers as
 * the expected laptop. LAN addresses usually win; Tailscale ones answer when
 * the phone is away from home. With `shareId`, an answer from that share wins;
 * failing that, any share on the laptop (its `shares` say where the wanted one
 * runs now).
 */
export function firstReachable(
  candidates: Candidate[],
  { serverId, shareId, token, ms = 4000 }: ProbeOptions = {},
): Promise<{ candidate: Candidate; ping: Ping }> {
  const unique = candidates.filter(
    (c, i) => candidates.findIndex((d) => d.host === c.host && d.port === c.port) === i,
  );
  return new Promise((resolve, reject) => {
    if (!unique.length) {
      reject(new Error('No address to try'));
      return;
    }
    let pending = unique.length;
    let done = false;
    let fallback: { candidate: Candidate; ping: Ping } | null = null;
    const settle = () => {
      pending -= 1;
      if (pending || done) return;
      if (fallback) resolve(fallback);
      else reject(new Error("Couldn't reach the laptop"));
    };
    for (const candidate of unique) {
      ping(candidate.host, candidate.port, ms, token)
        .then((p) => {
          if (done) return;
          if (serverId && p.server_id !== serverId) throw new Error('A different laptop answered');
          if (shareId && p.share_id && p.share_id !== shareId) {
            if (p.shares) {
              // It knows whether (and where) the wanted share runs; don't
              // wait for the other addresses to time out.
              done = true;
              resolve({ candidate, ping: p });
              return;
            }
            fallback ??= { candidate, ping: p };
            settle();
            return;
          }
          done = true;
          resolve({ candidate, ping: p });
        })
        .catch(settle);
    }
  });
}

export async function pair(
  candidate: Candidate,
  body: { secret?: string; code?: string; device_name: string },
): Promise<PairResponse> {
  const res = await fetchWithTimeout(
    `${baseUrl(candidate.host, candidate.port)}/api/pair`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    8000,
  );
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as PairResponse;
}

/** Parses the QR code link printed by `mdshare <path>`. */
export function parsePairLink(
  link: string,
): { serverId: string; secret: string; port: number; hosts: string[] } | null {
  const m = /^mdshare:\/\/pair\/?\?(.*)$/i.exec(link.trim());
  if (!m) return null;
  const params = new Map<string, string>();
  for (const kv of m[1].split('&')) {
    const [k, ...v] = kv.split('=');
    params.set(decodeURIComponent(k), decodeURIComponent(v.join('=')));
  }
  const serverId = params.get('id');
  const secret = params.get('s');
  const port = Number(params.get('p'));
  const hosts = (params.get('h') ?? '').split(',').filter(Boolean);
  if (!serverId || !secret || !port || !hosts.length) return null;
  return { serverId, secret, port, hosts };
}

/** Authenticated client for one reachable laptop. */
export class Client {
  readonly base: string;

  constructor(
    readonly host: string,
    readonly port: number,
    private readonly token: string,
  ) {
    this.base = baseUrl(host, port);
  }

  private async get(path: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
    const res = await fetchWithTimeout(
      `${this.base}${path}`,
      { ...init, headers: { ...(init.headers as object), authorization: `Bearer ${this.token}` } },
      ms,
    );
    if (!res.ok && res.status !== 304) throw await errorFrom(res);
    return res;
  }

  async info(): Promise<Info> {
    return (await this.get('/api/info')).json();
  }

  async tree(): Promise<TreeNode> {
    return (await this.get('/api/tree', {}, 15000)).json();
  }

  /** Returns `null` when the cached copy (matching `etag`) is still current. */
  async file(path: string, etag?: string): Promise<{ text: string; etag: string | null } | null> {
    const res = await this.get(
      `/api/file?path=${encodeURIComponent(path)}`,
      etag ? { headers: { 'if-none-match': etag } } : {},
      15000,
    );
    if (res.status === 304) return null;
    return { text: await res.text(), etag: res.headers.get('etag') };
  }

  async search(q: string): Promise<SearchHit[]> {
    const res = await this.get(`/api/search?q=${encodeURIComponent(q)}&limit=200`, {}, 15000);
    return (await res.json()).hits;
  }

  /** URL prefix for images; the reader appends the encoded path. */
  get assetBase(): string {
    return `${this.base}/api/file?t=${encodeURIComponent(this.token)}&path=`;
  }

  /**
   * Live reload stream. Reconnects on its own; `onState` reports whether the
   * stream is currently open.
   */
  events(onChange: (e: ChangeEvent) => void, onState: (live: boolean) => void): () => void {
    const es = new EventSource<'hello' | 'change'>(`${this.base}/api/events`, {
      headers: { authorization: `Bearer ${this.token}` },
      pollingInterval: 4000,
      timeoutBeforeConnection: 0,
    });
    es.addEventListener('hello', () => onState(true));
    es.addEventListener('change', (e) => {
      try {
        if (e.data) onChange(JSON.parse(e.data));
      } catch {}
    });
    es.addEventListener('error', () => onState(false));
    es.addEventListener('close', () => onState(false));
    return () => {
      es.removeAllEventListeners();
      es.close();
    };
  }
}

/** Ports mdshare picks from when none is given (see server/src/main.rs). */
const DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 7878 + i);

/**
 * Addresses to try for a paired laptop (or one share on it), best first.
 * `anyPort` adds the ports a share started since we last looked may be on.
 */
export function candidatesFor(
  laptop: Laptop,
  { nearby, shareId, anyPort }: { nearby?: Candidate[]; shareId?: string; anyPort?: boolean } = {},
): Candidate[] {
  const ports = [
    shareId ? laptop.shares?.[shareId]?.port : undefined,
    laptop.port,
    ...Object.values(laptop.shares ?? {}).map((s) => s.port),
    ...(anyPort ? DEFAULT_PORTS : []),
  ].filter((p, i, all): p is number => !!p && all.indexOf(p) === i);
  const hosts = laptop.lastHost ? [laptop.lastHost, ...laptop.hosts] : laptop.hosts;
  const list: Candidate[] = [...(nearby ?? [])];
  for (const port of ports) for (const host of hosts) list.push({ host, port });
  return list;
}

/** The shares a ping says are running: the one that answered and its siblings. */
export function sharesIn(p: Ping): ShareInfo[] {
  const own: ShareInfo[] =
    p.share_id && p.port ? [{ share_id: p.share_id, name: p.name, kind: p.kind ?? 'folder', port: p.port }] : [];
  return [...own, ...(p.shares ?? [])];
}
