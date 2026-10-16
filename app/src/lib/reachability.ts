// Whether each paired laptop is sharing right now, and what, for the home
// screen. mDNS answers instantly on the same Wi-Fi; other laptops get a ping on
// every address we know (which covers Tailscale). Any share that answers also
// lists the laptop's other running shares.

import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useNearby } from './discovery';
import { candidatesFor, firstReachable, sharesIn } from './net';
import { tokens, useStore } from './store';
import type { ShareInfo } from './types';

export interface Reach {
  online: boolean;
  /** Name of the share that answered (older laptops report only one). */
  shareName?: string;
  /** Shares running right now; empty for laptops on an older mdshare. */
  shares: ShareInfo[];
  via?: 'Wi-Fi' | 'Tailscale';
}

const POLL_MS = 20000;

const TAILSCALE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

function merge(a: ShareInfo[], b: ShareInfo[]): ShareInfo[] {
  const out = [...a];
  for (const s of b) if (!out.some((o) => o.share_id === s.share_id)) out.push(s);
  return out;
}

export function useReachability(): Record<string, Reach> {
  const laptops = useStore((s) => s.laptops);
  // Probing records the shares it finds, which changes `laptops`; restart the
  // polling only when the set of laptops changes.
  const laptopIds = Object.keys(laptops).sort().join(',');
  const nearby = useNearby((s) => s.byId);
  const [probed, setProbed] = useState<Record<string, Reach>>({});

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const probe = () => {
        for (const laptop of Object.values(useStore.getState().laptops)) {
          tokens
            .get(laptop.serverId)
            .then((token) =>
              firstReachable(candidatesFor(laptop, { anyPort: true }), {
                serverId: laptop.serverId,
                token: token ?? undefined,
                ms: 3500,
              }),
            )
            .then(({ candidate, ping }) => {
              if (cancelled) return;
              const shares = sharesIn(ping);
              useStore.getState().seeShares(laptop.serverId, shares);
              const tailscale = TAILSCALE.test(candidate.host) || candidate.host.endsWith('.ts.net');
              setProbed((p) => ({
                ...p,
                [laptop.serverId]: {
                  online: true,
                  shareName: ping.name,
                  shares,
                  via: tailscale ? 'Tailscale' : 'Wi-Fi',
                },
              }));
            })
            .catch(() => {
              if (!cancelled) setProbed((p) => ({ ...p, [laptop.serverId]: { online: false, shares: [] } }));
            });
        }
      };
      probe();
      const timer = setInterval(probe, POLL_MS);
      return () => {
        cancelled = true;
        clearInterval(timer);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [laptopIds]),
  );

  const out: Record<string, Reach> = { ...probed };
  for (const n of Object.values(nearby)) {
    if (!laptops[n.serverId]) continue;
    const seen: ShareInfo[] = n.shareId
      ? [{ share_id: n.shareId, name: n.shareName, kind: n.kind, port: n.port }]
      : [];
    const cur = out[n.serverId];
    out[n.serverId] = {
      online: true,
      shareName: cur?.online ? cur.shareName : n.shareName,
      shares: merge(cur?.online ? cur.shares : [], seen),
      via: cur?.online ? cur.via : 'Wi-Fi',
    };
  }
  return out;
}
