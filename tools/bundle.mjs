/**
 * Builds the game into a single self-contained HTML file.
 *
 * Everything -- Three.js, the simulation, the stylesheet -- is inlined, so the
 * result runs by double-clicking it. No server, no toolchain, no network. That
 * matters because a module script loaded from a separate file over file:// is
 * blocked by CORS, whereas an inline one is not.
 */
import { build } from 'vite';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, '.singlefile');
const TARGET = path.join(ROOT, 'heavy-haul.html');

await rm(OUT_DIR, { recursive: true, force: true });

await build({
  root: ROOT,
  logLevel: 'warn',
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: 'es2022',
    // One chunk, so there is exactly one script to inline.
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

const assetDir = path.join(OUT_DIR, 'assets');
const assets = await readdir(assetDir);
const jsName = assets.find((f) => f.endsWith('.js'));
const cssName = assets.find((f) => f.endsWith('.css'));

const js = await readFile(path.join(assetDir, jsName), 'utf8');
const css = cssName ? await readFile(path.join(assetDir, cssName), 'utf8') : '';
let html = await readFile(path.join(OUT_DIR, 'index.html'), 'utf8');

// Splice the built assets in place of their tags.
html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/g, '');

// A literal </script> inside a string or shader would close the tag early.
const safeJs = js.replace(/<\/script/gi, '<\\/script');

// Both of these MUST use a replacement function. Passing the code as a
// replacement *string* would let String.replace interpret its `$` sequences --
// and three.js's PropertyBinding builds regexes containing a literal `$`, so
// `$\`` would expand to the entire preceding document and splice the HTML into
// the middle of the bundle.
html = html.replace('</head>', () => `  <style>\n${css}\n  </style>\n</head>`);
html = html.replace('</body>', () => `  <script type="module">\n${safeJs}\n  </script>\n</body>`);

await writeFile(TARGET, html, 'utf8');
await rm(OUT_DIR, { recursive: true, force: true });

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log(`wrote heavy-haul.html (${kb} KB, fully self-contained)`);
