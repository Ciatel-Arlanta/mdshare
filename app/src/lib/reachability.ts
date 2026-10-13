// Whether each paired laptop is sharing right now, for the home screen.
// mDNS answers instantly on the same Wi-Fi; other laptops get a ping on every
// address we know (which covers Tailscale).

import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useNearby } from './discovery';
import { candidatesFor, firstReachable } from './net';
import { useStore } from './store';

export interface Reach {
  online: boolean;
  shareName?: string;
  via?: 'Wi-Fi' | 'Tailscale';
}

const POLL_MS = 20000;

export function useReachability(): Record<string, Reach> {
  const laptops = useStore((s) => s.laptops);
  const nearby = useNearby((s) => s.byId);
  const [probed, setProbed] = useState<Record<string, Reach>>({});

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const probe = () => {
        for (const laptop of Object.values(laptops)) {
          firstReachable(candidatesFor(laptop), laptop.serverId, 3500)
            .then(({ candidate, ping }) => {
              if (cancelled) return;
              const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(candidate.host) || candidate.host.endsWith('.ts.net');
              setProbed((p) => ({
                ...p,
                [laptop.serverId]: { online: true, shareName: ping.name, via: tailscale ? 'Tailscale' : 'Wi-Fi' },
              }));
            })
            .catch(() => {
              if (!cancelled) setProbed((p) => ({ ...p, [laptop.serverId]: { online: false } }));
            });
        }
      };
      probe();
      const timer = setInterval(probe, POLL_MS);
      return () => {
        cancelled = true;
        clearInterval(timer);
      };
    }, [laptops]),
  );

  const out: Record<string, Reach> = { ...probed };
  for (const [id, n] of Object.entries(nearby)) {
    if (laptops[id]) out[id] = { online: true, shareName: n.shareName, via: 'Wi-Fi' };
  }
  return out;
}
