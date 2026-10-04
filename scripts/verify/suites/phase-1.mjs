import { join } from 'node:path';
import { build } from 'esbuild';
import { PROJECT_ROOT, captureScreenshot, createSuite, resetBrowserState } from '../harness.mjs';

/**
 * Phase 1 — Types, storage/API client config and base utilities.
 *
 * The suite bundles the real Phase 1 modules with esbuild and executes them
 * inside headless Chrome, so IndexedDB, localStorage and Blob sizing are the
 * genuine browser implementations rather than a Node approximation.
 */
export default {
  name: 'Phase 1 — Types, Storage/API Config & Base Utilities',

  async run({ page, baseUrl, harnessUrl }) {
    const suite = createSuite('Phase 1 module behaviour');
    const url = harnessUrl ?? baseUrl ?? 'http://127.0.0.1:4321';

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await resetBrowserState(page);

    const bundle = await build({
      entryPoints: [join(PROJECT_ROOT, 'scripts/verify/entries/phase-1.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: ['chrome120'],
      tsconfig: join(PROJECT_ROOT, 'tsconfig.json'),
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });

    const code = bundle.outputFiles[0]?.text ?? '';
    suite.ok('phase 1 verification bundle was produced', code.length > 1000, `bundle length ${code.length}`);

    await page.evaluate(() => {
      delete window.__phase1;
    });
    await page.addScriptTag({ content: code });

    const hasHarness = await page.evaluate(() => typeof window.__phase1?.run === 'function');
    suite.ok('phase 1 modules execute inside the browser', hasHarness);

    if (!hasHarness) {
      suite.print();
      await captureScreenshot(page, 'phase-1-failure');
      return suite.failureCount + 1;
    }

    const results = await page.evaluate(async () => {
      try {
        return await window.__phase1.run();
      } catch (error) {
        return [{ label: 'phase 1 runner completed without throwing', ok: false, detail: String(error) }];
      }
    });

    for (const result of results) {
      suite.ok(result.label, result.ok, result.detail);
    }

    await page.evaluate(() => {
      delete window.__phase1;
    });

    const failures = suite.print();
    return failures;
  },
};