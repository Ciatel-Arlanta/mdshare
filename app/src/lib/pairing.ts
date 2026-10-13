import * as Device from 'expo-device';

import { type Candidate, firstReachable, pair } from './net';
import { getSource, forgetSource } from './sources';
import { laptopSourceId, tokens, useStore } from './store';
import type { PairResponse } from './types';

function deviceName(): string {
  return Device.deviceName || Device.modelName || 'Android phone';
}

async function save(res: PairResponse, used: Candidate): Promise<string> {
  await tokens.set(res.server_id, res.token);
  const hosts = res.addrs.map((a) => a.host);
  useStore.getState().upsertLaptop({
    serverId: res.server_id,
    host: res.host,
    hosts: hosts.length ? hosts : [used.host],
    port: res.port,
    lastHost: used.host,
    deviceId: res.device_id,
    pairedAt: Date.now(),
    lastSeen: Date.now(),
  });
  const id = laptopSourceId(res.server_id);
  // Drop any stale connection from an earlier pairing with this laptop.
  forgetSource(id);
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
  const { candidate } = await firstReachable(
    hosts.map((host) => ({ host, port })),
    serverId,
    5000,
  );
  const res = await pair(candidate, { secret, device_name: deviceName() });
  return save(res, candidate);
}

/** Pairs using the 6-digit code shown in the laptop's terminal. */
export async function pairWithCode(candidates: Candidate[], code: string, serverId?: string): Promise<string> {
  const { candidate } = await firstReachable(candidates, serverId, 5000);
  const res = await pair(candidate, { code, device_name: deviceName() });
  return save(res, candidate);
}

export async function unpair(serverId: string) {
  await tokens.remove(serverId);
  forgetSource(laptopSourceId(serverId));
  useStore.getState().removeLaptop(serverId);
}
