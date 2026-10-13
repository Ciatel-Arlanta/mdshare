export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function stripExtension(name: string): string {
  return name.replace(/\.(md|markdown|mdx|mdown|mkd|mkdn)$/i, '');
}

const MARKDOWN = /\.(md|markdown|mdx|mdown|mkd|mkdn)$/i;
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i;

export const isMarkdown = (name: string) => MARKDOWN.test(name);
export const isImage = (name: string) => IMAGE.test(name);

export function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Readable name for a content:// or file:// URI. */
export function nameFromUri(uri: string): string {
  const decoded = decodeURIComponent(uri);
  const last = decoded.split(/[/:]/).filter(Boolean).pop() ?? 'Document';
  return last;
}

export function timeAgo(secs: number): string {
  const d = Math.max(0, Date.now() / 1000 - secs);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(secs * 1000).toLocaleDateString();
}
