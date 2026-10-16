// Shapes of the mdshare server API (see server/src/server.rs) and of the
// app's own records.

export type AddrKind = 'lan' | 'tailscale';

export interface Addr {
  host: string;
  kind: AddrKind;
}

/** A share running on a laptop. Each `mdshare` process serves one, on its own port. */
export interface ShareInfo {
  share_id: string;
  name: string;
  kind: 'file' | 'folder';
  port: number;
}

export interface Ping {
  app: 'mdshare';
  version: number;
  server_id: string;
  name: string;
  host: string;
  // Missing from laptops running an older mdshare.
  share_id?: string;
  kind?: 'file' | 'folder';
  port?: number;
  /** The laptop's other shares running right now. */
  shares?: ShareInfo[];
}

export interface Info {
  app: 'mdshare';
  version: number;
  server_id: string;
  share_id?: string;
  name: string;
  kind: 'file' | 'folder';
  entry: string | null;
  host: string;
  port: number;
  addrs: Addr[];
  expires_at: number | null;
}

export interface PairResponse {
  token: string;
  device_id: string;
  server_id: string;
  share_id?: string;
  host: string;
  port: number;
  addrs: Addr[];
}

export type TreeNode =
  | { kind: 'dir'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file'; name: string; path: string; size: number; mtime: number; markdown: boolean };

export interface SearchHit {
  path: string;
  /** 1-based; 0 means the file name matched. */
  line: number;
  text: string;
}

export interface ChangeEvent {
  paths: string[];
  tree: boolean;
  /** Set by the app (not the server) after reconnecting: anything may have
   * changed while the connection was down. */
  resync?: boolean;
}

/** A laptop this phone has paired with. The token lives in SecureStore. */
export interface Laptop {
  serverId: string;
  /** The laptop's hostname. */
  host: string;
  /** Addresses to try, LAN first then Tailscale. */
  hosts: string[];
  port: number;
  /** The address that worked last time; tried first. */
  lastHost?: string;
  /** Name of the last share seen from this laptop. */
  shareName?: string;
  /** Every share seen from this laptop, by share id. */
  shares?: Record<string, KnownShare>;
  deviceId: string;
  pairedAt: number;
  lastSeen?: number;
}

export interface KnownShare {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  /** Port it ran on last time; it can change when shares start in another order. */
  port: number;
  lastSeen: number;
}

/** A folder on this phone opened through the system folder picker. */
export interface LocalFolder {
  id: string;
  uri: string;
  name: string;
  addedAt: number;
}

/** A single file opened with "Open with" or the file picker. */
export interface LocalFile {
  id: string;
  uri: string;
  name: string;
  addedAt: number;
}

export interface Recent {
  sourceId: string;
  path: string;
  title: string;
  openedAt: number;
  progress: number;
}
