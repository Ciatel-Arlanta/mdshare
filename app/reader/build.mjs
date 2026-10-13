// Builds the reader page into reader/dist. The app ships dist as Android
// assets (see plugins/with-reader-assets.js).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const require = createRequire(import.meta.url);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, 'src/reader.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome100'],
  outfile: join(out, 'reader.js'),
  legalComments: 'none',
});

await build({
  entryPoints: [join(here, 'src/reader.css')],
  bundle: true,
  minify: true,
  outfile: join(out, 'reader.css'),
  // Modern WebViews only need woff2; drop the older formats KaTeX lists.
  loader: { '.woff2': 'file', '.woff': 'empty', '.ttf': 'empty' },
  assetNames: 'fonts/[name]',
});

cpSync(join(here, 'src/index.html'), join(out, 'index.html'));
// Loaded on demand, only for documents that contain a diagram.
cpSync(require.resolve('mermaid/dist/mermaid.min.js'), join(out, 'mermaid.min.js'));

console.log('reader built →', out);
