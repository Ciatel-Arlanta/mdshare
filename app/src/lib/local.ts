// Reading markdown that's already on the phone.

import * as DocumentPicker from 'expo-document-picker';
import { Directory } from 'expo-file-system';

import { nameFromUri } from './paths';
import { fileSourceId, folderSourceId, randomId, useStore } from './store';

/** Opens the system folder picker. Returns the new source id, or null. */
export async function pickFolder(): Promise<string | null> {
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch {
    return null; // cancelled
  }
  if (!dir?.uri) return null;
  const existing = Object.values(useStore.getState().folders).find((f) => f.uri === dir.uri);
  if (existing) return folderSourceId(existing.id);
  const id = randomId();
  const name = dir.name || nameFromUri(dir.uri);
  useStore.getState().addFolder({ id, uri: dir.uri, name, addedAt: Date.now() });
  return folderSourceId(id);
}

/** Remembers a single file (from "Open with" or the picker). Returns its source id. */
export function addLocalFile(uri: string, name?: string): string {
  const existing = Object.values(useStore.getState().files).find((f) => f.uri === uri);
  if (existing) return fileSourceId(existing.id);
  const id = randomId();
  useStore.getState().addFile({ id, uri, name: name || nameFromUri(uri), addedAt: Date.now() });
  return fileSourceId(id);
}

export async function pickFile(): Promise<{ sourceId: string; name: string } | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ['text/markdown', 'text/x-markdown', 'text/plain', 'application/octet-stream'],
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (res.canceled || !res.assets?.[0]) return null;
  const asset = res.assets[0];
  const sourceId = addLocalFile(asset.uri, asset.name);
  const file = useStore.getState().files[sourceId.slice(2)];
  return { sourceId, name: file?.name ?? asset.name };
}
