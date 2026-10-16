// LAN discovery of running shares (mDNS `_mdshare._tcp`). Paired laptops are
// matched by the permanent server id in the TXT record, so the app finds them
// even after their Wi-Fi address changed. One laptop can run several shares,
// so entries are keyed by share, not by laptop.

import { useEffect } from 'react';
import { AppState } from 'react-native';
import Zeroconf, { type Service } from 'react-native-zeroconf';
import { create } from 'zustand';

export interface Nearby {
  serverId: string;
  /** Missing from laptops running an older mdshare. */
  shareId?: string;
  /** Name of the share being served right now. */
  shareName: string;
  /** Laptop hostname. */
  host: string;
  kind: 'file' | 'folder';
  addresses: string[];
  port: number;
  /** mDNS instance name, used to drop the entry when it goes away. */
  instance: string;
  seenAt: number;
}

interface NearbyState {
  /** Keyed by `nearbyKey`. */
  byId: Record<string, Nearby>;
  scanning: boolean;
}

const nearbyKey = (n: Nearby) => `${n.serverId}~${n.shareId ?? n.port}`;

export const useNearby = create<NearbyState>(() => ({ byId: {}, scanning: false }));

function fromService(s: Service): Nearby | null {
  const txt = s.txt ?? {};
  const serverId = txt.id;
  if (!serverId) return null;
  const ipv4 = s.ipv4?.length ? s.ipv4 : s.addresses.filter((a) => !a.includes(':'));
  if (!ipv4.length) return null;
  return {
    serverId,
    shareId: txt.share || undefined,
    shareName: txt.name || s.name,
    host: txt.host || s.host.replace(/\.local\.?$/, ''),
    kind: txt.kind === 'file' ? 'file' : 'folder',
    addresses: ipv4,
    port: s.port,
    instance: s.name,
    seenAt: Date.now(),
  };
}

let zeroconf: Zeroconf | null = null;

function start() {
  if (zeroconf) return;
  try {
    zeroconf = new Zeroconf();
  } catch {
    // Native module missing (e.g. Expo Go); discovery is optional.
    return;
  }
  zeroconf.on('start', () => useNearby.setState({ scanning: true }));
  zeroconf.on('stop', () => useNearby.setState({ scanning: false }));
  zeroconf.on('resolved', (service) => {
    const n = fromService(service);
    if (n) useNearby.setState((s) => ({ byId: { ...s.byId, [nearbyKey(n)]: n } }));
  });
  zeroconf.on('remove', (name) => {
    useNearby.setState((s) => {
      const byId = Object.fromEntries(Object.entries(s.byId).filter(([, n]) => n.instance !== name));
      return { byId };
    });
  });
  zeroconf.on('error', () => {});
  zeroconf.scan('mdshare', 'tcp', 'local.');
}

function stop() {
  if (!zeroconf) return;
  try {
    zeroconf.stop();
    zeroconf.removeDeviceListeners();
    zeroconf.removeAllListeners();
  } catch {}
  zeroconf = null;
  useNearby.setState({ byId: {}, scanning: false });
}

/** Scans while the app is in the foreground. Mount once, near the root. */
export function useDiscovery() {
  useEffect(() => {
    start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') start();
      else stop();
    });
    return () => {
      sub.remove();
      stop();
    };
  }, []);
}

export function rescan() {
  stop();
  start();
}
