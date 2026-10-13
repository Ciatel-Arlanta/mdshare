import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { Laptop, LocalFile, LocalFolder, Recent } from './types';

export type ReaderTheme = 'auto' | 'light' | 'sepia' | 'dark' | 'black';
export type Appearance = 'system' | 'light' | 'dark';

export interface Prefs {
  appearance: Appearance;
  readerTheme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
  /** Max line length in characters; 0 = full width. */
  width: number;
  font: 'serif' | 'sans';
  keepScreenOn: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  appearance: 'system',
  readerTheme: 'auto',
  fontSize: 18,
  lineHeight: 1.65,
  width: 68,
  font: 'serif',
  keepScreenOn: false,
};

interface Position {
  line: number;
  progress: number;
}

interface State {
  laptops: Record<string, Laptop>;
  folders: Record<string, LocalFolder>;
  files: Record<string, LocalFile>;
  recents: Recent[];
  positions: Record<string, Position>;
  prefs: Prefs;

  upsertLaptop(laptop: Laptop): void;
  updateLaptop(serverId: string, patch: Partial<Laptop>): void;
  removeLaptop(serverId: string): void;
  addFolder(folder: LocalFolder): void;
  removeFolder(id: string): void;
  addFile(file: LocalFile): void;
  removeFile(id: string): void;
  touchRecent(recent: Omit<Recent, 'openedAt' | 'progress'>): void;
  savePosition(sourceId: string, path: string, pos: Position): void;
  setPrefs(patch: Partial<Prefs>): void;
}

export const docKey = (sourceId: string, path: string) => `${sourceId}::${path}`;

const MAX_RECENTS = 30;

export const useStore = create<State>()(
  persist(
    (set) => ({
      laptops: {},
      folders: {},
      files: {},
      recents: [],
      positions: {},
      prefs: DEFAULT_PREFS,

      upsertLaptop: (laptop) => set((s) => ({ laptops: { ...s.laptops, [laptop.serverId]: laptop } })),
      updateLaptop: (serverId, patch) =>
        set((s) => {
          const cur = s.laptops[serverId];
          return cur ? { laptops: { ...s.laptops, [serverId]: { ...cur, ...patch } } } : {};
        }),
      removeLaptop: (serverId) =>
        set((s) => {
          const { [serverId]: _, ...laptops } = s.laptops;
          const sourceId = laptopSourceId(serverId);
          return { laptops, recents: s.recents.filter((r) => r.sourceId !== sourceId) };
        }),
      addFolder: (folder) => set((s) => ({ folders: { ...s.folders, [folder.id]: folder } })),
      removeFolder: (id) =>
        set((s) => {
          const { [id]: _, ...folders } = s.folders;
          return { folders, recents: s.recents.filter((r) => r.sourceId !== folderSourceId(id)) };
        }),
      addFile: (file) => set((s) => ({ files: { ...s.files, [file.id]: file } })),
      removeFile: (id) =>
        set((s) => {
          const { [id]: _, ...files } = s.files;
          return { files, recents: s.recents.filter((r) => r.sourceId !== fileSourceId(id)) };
        }),
      touchRecent: (recent) =>
        set((s) => {
          const key = docKey(recent.sourceId, recent.path);
          const progress = s.positions[key]?.progress ?? 0;
          const rest = s.recents.filter((r) => docKey(r.sourceId, r.path) !== key);
          return {
            recents: [{ ...recent, openedAt: Date.now(), progress }, ...rest].slice(0, MAX_RECENTS),
          };
        }),
      savePosition: (sourceId, path, pos) =>
        set((s) => {
          const key = docKey(sourceId, path);
          return {
            positions: { ...s.positions, [key]: pos },
            recents: s.recents.map((r) =>
              docKey(r.sourceId, r.path) === key ? { ...r, progress: pos.progress } : r,
            ),
          };
        }),
      setPrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
    }),
    {
      name: 'mdshare',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        return { ...current, ...p, prefs: { ...DEFAULT_PREFS, ...p.prefs } };
      },
    },
  ),
);

// Source ids: one namespace for laptops, phone folders and single files.
export const laptopSourceId = (serverId: string) => `l-${serverId}`;
export const folderSourceId = (id: string) => `f-${id}`;
export const fileSourceId = (id: string) => `d-${id}`;

export function randomId(len = 10): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Device tokens are secrets; keep them out of AsyncStorage.
const tokenKey = (serverId: string) => `token.${serverId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

export const tokens = {
  get: (serverId: string) => SecureStore.getItemAsync(tokenKey(serverId)),
  set: (serverId: string, token: string) => SecureStore.setItemAsync(tokenKey(serverId), token),
  remove: (serverId: string) => SecureStore.deleteItemAsync(tokenKey(serverId)),
};
