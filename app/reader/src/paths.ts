// Path helpers for share-relative paths (always forward slashes, no leading /).

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Resolves `rel` against directory `base`. A leading `/` means the share root.
 * `..` never climbs above the root. */
export function resolvePath(base: string, rel: string): string {
  const parts = rel.startsWith('/') ? [] : base.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** GitHub-style heading slug. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}
