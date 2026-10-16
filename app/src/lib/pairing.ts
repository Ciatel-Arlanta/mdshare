import * as Device from 'expo-device';

import { type Candidate, firstReachable, pair, sharesIn } from './net';
import { getSource, forgetSource } from './sources';
import { laptopSourceId, laptopSourceIds, tokens, useStore } from './store';
import type { PairResponse, Ping } from './types';

function deviceName(): string {
  return Device.deviceName || Device.modelName || 'Android phone';
}

async function save(res: PairResponse, used: Candidate, ping: Ping): Promise<string> {
  await tokens.set(res.server_id, res.token);
  const hosts = res.addrs.map((a) => a.host);
  const store = useStore.getState();
  store.upsertLaptop({
    serverId: res.server_id,
    host: res.host,
    hosts: hosts.length ? hosts : [used.host],
    port: res.port,
    lastHost: used.host,
    deviceId: res.device_id,
    pairedAt: Date.now(),
    lastSeen: Date.now(),
    // Pairing again keeps the shares seen before.
    shares: store.laptops[res.server_id]?.shares,
  });
  store.seeShares(res.server_id, sharesIn(ping));
  // Drop any stale connection from an earlier pairing with this laptop.
  for (const old of laptopSourceIds(useStore.getState().laptops[res.server_id])) forgetSource(old);
  const id = laptopSourceId(res.server_id, res.share_id);
  getSource(id);
  return id;
}

/** Pairs using the secret from the QR code. Tries every address in it. */
export async function pairWithSecret(
  hosts: string[],
  port: number,
  serverId: string,
  secret: string,
): Promise<string> {
  const { candidate, ping } = await firstReachable(
    hosts.map((host) => ({ host, port })),
    serverId,
    5000,
  );
  const res = await pair(candidate, { secret, device_name: deviceName() });
  return save(res, candidate, ping);
}

/** Pairs using the 6-digit code shown in the laptop's terminal. */
export async function pairWithCode(candidates: Candidate[], code: string, serverId?: string): Promise<string> {
  const { candidate, ping } = await firstReachable(candidates, serverId, 5000);
  const res = await pair(candidate, { code, device_name: deviceName() });
  return save(res, candidate, ping);
}

export async function unpair(serverId: string) {
  await tokens.remove(serverId);
  const laptop = useStore.getState().laptops[serverId];
  for (const id of laptop ? laptopSourceIds(laptop) : [laptopSourceId(serverId)]) forgetSource(id);
  useStore.getState().removeLaptop(serverId);
}

/** Forgets a share that isn't running any more, with its saved copies. */
export function forgetShare(serverId: string, shareId: string) {
  forgetSource(laptopSourceId(serverId, shareId));
  useStore.getState().removeShare(serverId, shareId);
}
