// The markdown reader page. Runs inside a WebView loaded from the APK's assets
// (file:///android_asset/reader/index.html). The app drives it through
// `window.mdshare` and gets events back through `ReactNativeWebView.postMessage`.

import MarkdownIt, { type RendererRule, type StateCore, type Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import mark from 'markdown-it-mark';
import frontMatter from 'markdown-it-front-matter';
import alerts from 'markdown-it-github-alerts';
import katex from '@vscode/markdown-it-katex';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

import { dirname, isExternal, resolvePath, slugify } from './paths';

// ---------------------------------------------------------------------------
// Types shared with the app (mirrored in app/src/lib/reader-protocol.ts).

export type Theme = 'light' | 'dark' | 'sepia' | 'black';

export interface Prefs {
  theme: Theme;
  fontSize: number;
  lineHeight: number;
  /** Max text width in `ch`; 0 means the full screen width. */
  width: number;
  font: 'serif' | 'sans';
}

export interface RenderOptions {
  markdown: string;
  /** Path of the document inside its share, e.g. `docs/plan.md`. */
  path: string;
  /** Prefix for image URLs; the share-relative path is appended URL-encoded.
   * Omit to have the reader ask the app for each image instead. */
  assetBase?: string;
  /** Keep the reader at the same place (live reload). */
  keepPosition?: boolean;
  /** Source line to scroll to after rendering (restoring a saved position). */
  line?: number;
  /** Heading id to scroll to after rendering. */
  anchor?: string;
}

type OutMessage =
  | { type: 'ready' }
  | { type: 'rendered'; toc: TocItem[]; words: number }
  | { type: 'scroll'; line: number; progress: number }
  | { type: 'link'; path: string; anchor?: string }
  | { type: 'external'; href: string }
  | { type: 'asset'; path: string }
  | { type: 'copy'; text: string }
  | { type: 'image'; src: string }
  | { type: 'find'; current: number; total: number };

export interface TocItem {
  level: number;
  text: string;
  id: string;
}

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(data: string): void };
    /** Set by the server's browser page, which hosts the reader outside the app. */
    mdshareHost?: (msg: OutMessage) => void;
    mermaid?: {
      initialize(config: object): void;
      run(opts: { nodes: Element[] }): Promise<void>;
    };
    mdshare: typeof api;
  }
}

function post(msg: OutMessage) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  else window.mdshareHost?.(msg);
}

// ---------------------------------------------------------------------------
// Markdown pipeline.

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(code, lang) {
    if (lang === 'mermaid') {
      return `<pre class="mermaid" data-src="${escapeHtml(code)}">${escapeHtml(code)}</pre>`;
    }
    const language = lang && hljs.getLanguage(lang) ? lang : null;
    try {
      const html = language
        ? hljs.highlight(code, { language, ignoreIllegals: true }).value
        : escapeHtml(code);
      return `<pre class="hljs"><code>${html}</code></pre>`;
    } catch {
      return '';
    }
  },
})
  .use(footnote)
  .use(taskLists, { enabled: false, label: true })
  .use(mark)
  .use(alerts)
  .use(katex, { throwOnError: false, enableMathBlockInHtml: true, enableMathInlineInHtml: true });

let frontMatterText = '';
md.use(frontMatter, (fm: string) => {
  frontMatterText = fm;
});

// Source line numbers on every block, so reading position survives edits.
md.core.ruler.push('data_line', (state: StateCore) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1 && token.block) {
      token.attrSet('data-line', String(token.map[0]));
    }
  }
});

// GitHub-style heading ids.
md.core.ruler.push('heading_ids', (state: StateCore) => {
  const seen = new Map<string, number>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const text = inline?.children?.map((t: Token) => (t.type === 'text' || t.type === 'code_inline' ? t.content : '')).join('') ?? '';
    let id = slugify(text) || 'section';
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    tokens[i].attrSet('id', id);
  }
});

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = ((tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0] ?? '';
  const inner = defaultFence(tokens, idx, options, env, self);
  if (lang === 'mermaid') {
    return `<div class="diagram" data-line="${token.attrGet('data-line') ?? ''}">${inner}</div>`;
  }
  const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
  return (
    `<div class="code-block" data-line="${token.attrGet('data-line') ?? ''}">` +
    `<div class="code-bar">${label}<button class="copy" type="button" aria-label="Copy code">Copy</button></div>` +
    `${inner}</div>`
  );
}) satisfies RendererRule;

md.renderer.rules.table_open = ((tokens, idx, options, env, self) =>
  `<div class="table-wrap">${self.renderToken(tokens, idx, options)}`) satisfies RendererRule;
md.renderer.rules.table_close = ((tokens, idx, options, env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`) satisfies RendererRule;

// ---------------------------------------------------------------------------
// State.

const doc = document.getElementById('doc') as HTMLElement;
let current: RenderOptions = { markdown: '', path: '' };
let blocks: HTMLElement[] = [];
let prefs: Prefs = { theme: 'light', fontSize: 18, lineHeight: 1.65, width: 68, font: 'serif' };

// ---------------------------------------------------------------------------
// Rendering.

function render(opts: RenderOptions) {
  const keep = opts.keepPosition ? topPosition() : null;
  current = opts;
  frontMatterText = '';
  try {
    const html = md.render(opts.markdown);
    const clean = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      ADD_ATTR: ['data-line', 'data-src', 'target', 'aria-hidden'],
    });
    doc.innerHTML = (frontMatterText ? frontMatterBlock(frontMatterText) : '') + clean;
  } catch {
    // A parser bug shouldn't leave a blank page: show the source instead.
    const pre = document.createElement('pre');
    pre.className = 'source-fallback';
    pre.textContent = opts.markdown;
    doc.replaceChildren(pre);
  }

  fixImages();
  blocks = Array.from(doc.querySelectorAll<HTMLElement>('[data-line]'));
  void renderDiagrams();

  if (keep) {
    scrollToLine(keep.line, keep.offset);
  } else if (opts.anchor) {
    scrollToId(opts.anchor);
  } else if (opts.line && opts.line > 0) {
    scrollToLine(opts.line);
  } else {
    window.scrollTo(0, 0);
  }

  const toc: TocItem[] = Array.from(doc.querySelectorAll<HTMLElement>('h1, h2, h3, h4')).map((h) => ({
    level: Number(h.tagName[1]),
    text: h.textContent?.trim() ?? '',
    id: h.id,
  }));
  const words = (doc.textContent ?? '').split(/\s+/).filter(Boolean).length;
  post({ type: 'rendered', toc, words });
  reportScroll();
}

function frontMatterBlock(text: string) {
  const escaped = escapeHtml(text);
  return `<details class="front-matter"><summary>Front matter</summary><pre><code>${escaped}</code></pre></details>`;
}

function fixImages() {
  const base = dirname(current.path);
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    img.loading = 'lazy';
    img.decoding = 'async';
    if (!src || isExternal(src) || src.startsWith('data:')) continue;
    const path = resolvePath(base, decodeURIComponent(src.split(/[?#]/)[0]));
    if (current.assetBase) {
      img.src = current.assetBase + encodeURIComponent(path);
    } else {
      img.removeAttribute('src');
      img.dataset.asset = path;
      post({ type: 'asset', path });
    }
  }
}

function assetResolved(path: string, url: string) {
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>('img[data-asset]'))) {
    if (img.dataset.asset === path) img.src = url;
  }
}

let mermaidLoading: Promise<void> | null = null;
// Mermaid sits next to reader.js, wherever the page itself is served from.
const scriptBase = (document.currentScript as HTMLScriptElement | null)?.src ?? location.href;

function loadMermaid(): Promise<void> {
  mermaidLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('mermaid.min.js', scriptBase).href;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('mermaid failed to load'));
    document.head.appendChild(s);
  });
  return mermaidLoading;
}

async function renderDiagrams() {
  const nodes = Array.from(doc.querySelectorAll<HTMLElement>('pre.mermaid'));
  if (!nodes.length) return;
  try {
    await loadMermaid();
  } catch {
    return;
  }
  const dark = prefs.theme === 'dark' || prefs.theme === 'black';
  window.mermaid!.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit',
  });
  for (const n of nodes) {
    // Hold the current height so re-rendering (e.g. after a theme change)
    // doesn't make the page jump.
    if (n.offsetHeight) n.style.minHeight = `${n.offsetHeight}px`;
    n.removeAttribute('data-processed');
    n.textContent = n.dataset.src ?? n.textContent;
  }
  try {
    await window.mermaid!.run({ nodes });
  } catch {
    // Mermaid leaves its own error box in place of a broken diagram.
  }
  for (const n of nodes) n.style.minHeight = '';
}

// ---------------------------------------------------------------------------
// Scroll position, in source lines.

function topPosition(): { line: number; offset: number } {
  const y = window.scrollY;
  let lo = 0;
  let hi = blocks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (absTop(blocks[mid]) <= y + 1) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return { line: 0, offset: y };
  const el = blocks[found];
  return { line: Number(el.dataset.line), offset: y - absTop(el) };
}

function absTop(el: HTMLElement) {
  return el.getBoundingClientRect().top + window.scrollY;
}

function scrollToLine(line: number, offset = 0) {
  let target: HTMLElement | null = null;
  for (const el of blocks) {
    if (Number(el.dataset.line) <= line) target = el;
    else break;
  }
  window.scrollTo(0, target ? absTop(target) + offset : 0);
}

function scrollToId(id: string) {
  const el = document.getElementById(id) ?? document.getElementsByName(id)[0];
  if (el) {
    window.scrollTo(0, absTop(el as HTMLElement) - 12);
  }
}

let scrollTimer = 0;
function reportScroll() {
  window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 1;
    post({ type: 'scroll', line: topPosition().line, progress });
  }, 150);
}
window.addEventListener('scroll', reportScroll, { passive: true });

// ---------------------------------------------------------------------------
// Preferences.

function setPrefs(next: Partial<Prefs>) {
  const themeChanged = next.theme && next.theme !== prefs.theme;
  const keep = blocks.length ? topPosition() : null;
  prefs = { ...prefs, ...next };
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.font = prefs.font;
  root.style.setProperty('--font-size', `${prefs.fontSize}px`);
  root.style.setProperty('--line-height', String(prefs.lineHeight));
  root.style.setProperty('--measure', prefs.width > 0 ? `${prefs.width}ch` : 'none');
  if (keep) scrollToLine(keep.line, keep.offset);
  if (themeChanged) void renderDiagrams();
}

// ---------------------------------------------------------------------------
// Find in page.

let hits: HTMLElement[] = [];
let hitIndex = -1;

function clearFind() {
  for (const m of Array.from(doc.querySelectorAll('mark.find'))) {
    m.replaceWith(document.createTextNode(m.textContent ?? ''));
  }
  doc.normalize();
  hits = [];
  hitIndex = -1;
}

function find(query: string, step: 1 | -1 | 0 = 0) {
  if (step === 0) {
    clearFind();
    const q = query.trim().toLowerCase();
    if (q) {
      const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          n.parentElement?.closest('script, style, .katex-mathml, .code-bar')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      const texts: Text[] = [];
      while (walker.nextNode()) texts.push(walker.currentNode as Text);
      for (const t of texts) {
        const value = t.data;
        const lower = value.toLowerCase();
        let at = lower.indexOf(q);
        if (at < 0) continue;
        const frag = document.createDocumentFragment();
        let last = 0;
        while (at >= 0) {
          frag.append(value.slice(last, at));
          const m = document.createElement('mark');
          m.className = 'find';
          m.textContent = value.slice(at, at + q.length);
          frag.append(m);
          hits.push(m);
          last = at + q.length;
          at = lower.indexOf(q, last);
        }
        frag.append(value.slice(last));
        t.replaceWith(frag);
      }
    }
    hitIndex = hits.length ? 0 : -1;
  } else if (hits.length) {
    hitIndex = (hitIndex + step + hits.length) % hits.length;
  }
  hits.forEach((h, i) => h.classList.toggle('current', i === hitIndex));
  const cur = hits[hitIndex];
  if (cur) {
    cur.scrollIntoView({ block: 'center' });
    cur.closest('details')?.setAttribute('open', '');
  }
  post({ type: 'find', current: hitIndex + 1, total: hits.length });
}

// ---------------------------------------------------------------------------
// Clicks: links, copy buttons, images.

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  const copy = target.closest('button.copy');
  if (copy) {
    const code = copy.closest('.code-block')?.querySelector('pre code');
    post({ type: 'copy', text: code?.textContent ?? '' });
    copy.textContent = 'Copied';
    window.setTimeout(() => (copy.textContent = 'Copy'), 1500);
    return;
  }

  const img = target.closest('img');
  if (img && !target.closest('a')) {
    post({ type: 'image', src: img.currentSrc || img.src });
    return;
  }

  const a = target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href') ?? '';
  e.preventDefault();
  if (!href) return;
  if (href.startsWith('#')) {
    scrollToId(decodeURIComponent(href.slice(1)));
    return;
  }
  if (isExternal(href)) {
    post({ type: 'external', href });
    return;
  }
  const [pathPart, anchor] = href.split('#');
  const clean = decodeURIComponent(pathPart.split('?')[0]);
  const path = clean ? resolvePath(dirname(current.path), clean) : current.path;
  if (path === current.path) {
    if (anchor) scrollToId(decodeURIComponent(anchor));
    return;
  }
  post({ type: 'link', path, anchor: anchor ? decodeURIComponent(anchor) : undefined });
});

// ---------------------------------------------------------------------------

const api = {
  render,
  setPrefs,
  scrollToLine,
  scrollToId,
  assetResolved,
  find,
  clearFind: () => {
    clearFind();
    post({ type: 'find', current: 0, total: 0 });
  },
};
window.mdshare = api;
setPrefs({});
post({ type: 'ready' });
