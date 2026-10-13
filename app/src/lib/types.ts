// Shapes of the mdshare server API (see server/src/server.rs) and of the
// app's own records.

export type AddrKind = 'lan' | 'tailscale';

export interface Addr {
  host: string;
  kind: AddrKind;
}

export interface Ping {
  app: 'mdshare';
  version: number;
  server_id: string;
  name: string;
  host: string;
}

export interface Info {
  app: 'mdshare';
  version: number;
  server_id: string;
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
  deviceId: string;
  pairedAt: number;
  lastSeen?: number;
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
