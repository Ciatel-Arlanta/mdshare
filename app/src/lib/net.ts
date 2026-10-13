// Talking to a laptop: probing addresses, pairing, and the authenticated API.

import EventSource from 'react-native-sse';

import type { ChangeEvent, Info, Laptop, PairResponse, Ping, SearchHit, TreeNode } from './types';

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

export async function ping(host: string, port: number, ms = 3000): Promise<Ping> {
  const res = await fetchWithTimeout(`${baseUrl(host, port)}/api/ping`, {}, ms);
  if (!res.ok) throw await errorFrom(res);
  const body = (await res.json()) as Ping;
  if (body.app !== 'mdshare') throw new Error('Not an mdshare server');
  return body;
}

export interface Candidate {
  host: string;
  port: number;
}

/**
 * Probes all candidates at once and resolves with the first that answers as
 * the expected laptop. LAN addresses usually win; Tailscale ones answer when
 * the phone is away from home.
 */
export function firstReachable(
  candidates: Candidate[],
  serverId?: string,
  ms = 4000,
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
    for (const candidate of unique) {
      ping(candidate.host, candidate.port, ms)
        .then((p) => {
          if (done) return;
          if (serverId && p.server_id !== serverId) throw new Error('A different laptop answered');
          done = true;
          resolve({ candidate, ping: p });
        })
        .catch(() => {
          pending -= 1;
          if (!pending && !done) reject(new Error("Couldn't reach the laptop"));
        });
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

/** Addresses to try for a paired laptop, best first. */
export function candidatesFor(laptop: Laptop, nearby?: Candidate[]): Candidate[] {
  const list: Candidate[] = [...(nearby ?? [])];
  if (laptop.lastHost) list.push({ host: laptop.lastHost, port: laptop.port });
  for (const host of laptop.hosts) list.push({ host, port: laptop.port });
  return list;
}
