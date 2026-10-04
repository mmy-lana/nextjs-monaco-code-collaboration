#!/usr/bin/env node
/**
 * Bundles the Monaco language-service workers into `public/monaco/`.
 *
 * Next's bundler treats `new Worker(new URL('./x.js', import.meta.url))` as a
 * static-asset copy, which emits the raw source and leaves the bare `monaco-editor`
 * import unresolvable in the browser. Bundling the workers ahead of time keeps
 * them self-contained module scripts that the app can serve from its own origin
 * — which is what makes the editor work on an air-gapped LAN with no CDN.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(ROOT, 'src', 'workers');
const OUTPUT_DIR = join(ROOT, 'public', 'monaco');

/** Entry name → emitted filename. */
const WORKERS = {
  'monaco-editor.worker.js': 'editor.worker.js',
  'monaco-typescript.worker.js': 'typescript.worker.js',
  'monaco-json.worker.js': 'json.worker.js',
  'monaco-css.worker.js': 'css.worker.js',
  'monaco-html.worker.js': 'html.worker.js',
};

async function main() {
  if (!existsSync(SOURCE_DIR)) {
    console.error(`Worker sources missing at ${SOURCE_DIR}`);
    process.exit(1);
  }

  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const entryPoints = Object.keys(WORKERS).map((name) => join(SOURCE_DIR, name));
  const missing = entryPoints.filter((entry) => !existsSync(entry));
  if (missing.length > 0) {
    console.error(`Missing worker entries:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }

  const result = await build({
    entryPoints: Object.entries(WORKERS).map(([name, outName]) => ({
      in: join(SOURCE_DIR, name),
      out: outName.replace(/\.js$/, ''),
    })),
    outdir: OUTPUT_DIR,
    bundle: true,
    splitting: false,
    format: 'esm',
    platform: 'browser',
    target: ['chrome110', 'firefox110', 'safari16'],
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
  });

  if (result.errors.length > 0) {
    console.error('Failed to bundle the Monaco workers:');
    for (const error of result.errors) console.error(`  ${error.text}`);
    process.exit(1);
  }

  console.log(`Bundled ${entryPoints.length} Monaco workers → public/monaco/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});