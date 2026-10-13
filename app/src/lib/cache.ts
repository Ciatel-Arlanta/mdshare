// Offline copies of trees and documents already opened, so a share stays
// readable after the laptop stops sharing or goes out of reach.

import { Directory, File, Paths } from 'expo-file-system';

import type { TreeNode } from './types';

function hash(s: string): string {
  // FNV-1a, 32-bit, twice with different seeds for fewer collisions.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function dirFor(sourceId: string): Directory {
  const dir = new Directory(Paths.document, 'cache', sourceId.replace(/[^A-Za-z0-9_-]/g, '_'));
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function readJson<T>(file: File): T | null {
  try {
    return file.exists ? (JSON.parse(file.textSync()) as T) : null;
  } catch {
    return null;
  }
}

interface DocMeta {
  etag: string | null;
  savedAt: number;
}

export const cache = {
  tree(sourceId: string): TreeNode | null {
    return readJson<TreeNode>(new File(dirFor(sourceId), 'tree.json'));
  },

  saveTree(sourceId: string, tree: TreeNode) {
    try {
      new File(dirFor(sourceId), 'tree.json').write(JSON.stringify(tree));
    } catch {}
  },

  doc(sourceId: string, path: string): { text: string; meta: DocMeta } | null {
    const dir = dirFor(sourceId);
    const key = hash(path);
    const body = new File(dir, `${key}.md`);
    const meta = readJson<DocMeta>(new File(dir, `${key}.json`));
    if (!body.exists || !meta) return null;
    try {
      return { text: body.textSync(), meta };
    } catch {
      return null;
    }
  },

  saveDoc(sourceId: string, path: string, text: string, etag: string | null) {
    try {
      const dir = dirFor(sourceId);
      const key = hash(path);
      new File(dir, `${key}.md`).write(text);
      new File(dir, `${key}.json`).write(JSON.stringify({ etag, savedAt: Date.now() } satisfies DocMeta));
    } catch {}
  },

  clear(sourceId: string) {
    try {
      const dir = new Directory(Paths.document, 'cache', sourceId.replace(/[^A-Za-z0-9_-]/g, '_'));
      if (dir.exists) dir.delete();
    } catch {}
  },

  /** Total size of all offline copies, for the settings screen. */
  sizeLabel(): string {
    try {
      const dir = new Directory(Paths.document, 'cache');
      const bytes = dir.exists ? (dir.size ?? 0) : 0;
      return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    } catch {
      return '—';
    }
  },

  clearAll() {
    try {
      const dir = new Directory(Paths.document, 'cache');
      if (dir.exists) dir.delete();
    } catch {}
  },
};
