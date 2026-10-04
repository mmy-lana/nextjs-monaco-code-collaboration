#!/usr/bin/env node
/**
 * Headless Chrome verification entry point.
 *
 * Usage:
 *   node scripts/verify.mjs                 # run every suite
 *   node scripts/verify.mjs --phases=1,3    # run selected suites
 *   node scripts/verify.mjs --headed        # show the browser window
 *   VERIFY_URL=http://127.0.0.1:3210 node scripts/verify.mjs
 *
 * The browser always runs against a throwaway profile in the OS temp dir.
 */
import { launchBrowser, reportBrowserViolations, startHarnessServer, watchPage } from './verify/harness.mjs';

const PHASE_SUITES = {
  1: './verify/suites/phase-1.mjs',
  2: './verify/suites/phase-2.mjs',
  3: './verify/suites/phase-3.mjs',
  4: './verify/suites/phase-4.mjs',
  5: './verify/suites/phase-5.mjs',
};

function parseArgs(argv) {
  const args = { phases: Object.keys(PHASE_SUITES).map(Number), headless: true, baseUrl: null };
  for (const raw of argv) {
    if (raw === '--headed') args.headless = false;
    else if (raw.startsWith('--phases=')) {
      args.phases = raw
        .slice('--phases='.length)
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => PHASE_SUITES[value]);
    } else if (raw.startsWith('--url=')) args.baseUrl = raw.slice('--url='.length);
  }
  if (process.env.VERIFY_URL && !args.baseUrl) args.baseUrl = process.env.VERIFY_URL;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.phases.length === 0) {
    console.error('No valid phases selected.');
    process.exit(1);
  }

  console.log(`\nChrome: ${process.env.CHROME_PATH ?? 'auto-detected'}`);
  console.log(`Headless: ${args.headless}`);

  // Phases 1–4 inject their own React harness and therefore run on a dedicated
  // blank origin; phase 5 drives the real application.
  const harnessServer = await startHarnessServer();
  console.log(`Harness origin: ${harnessServer.url}`);

  // Each phase gets its own browser instance: suites seed IndexedDB, open
  // WebRTC providers and (for phase 4) several tabs, so sharing one browser
  // between phases would let state bleed across assertions.
  const violations = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  let totalFailures = 0;

  for (const phase of args.phases) {
    const suiteUrl = new URL(PHASE_SUITES[phase], import.meta.url);
    const suiteModule = await import(suiteUrl.href);
    const suite = suiteModule.default;

    const session = await launchBrowser({ headless: args.headless });
    const page = await session.browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const pageViolations = watchPage(page, `phase-${phase}`);

    console.log(`\n${'='.repeat(72)}\nRunning ${suite.name}\n${'='.repeat(72)}`);

    let suiteFailures = 0;
    try {
      suiteFailures = await suite.run({
        page,
        browser: session.browser,
        baseUrl: args.baseUrl,
        harnessUrl: harnessServer.url,
        headless: args.headless,
      });
    } catch (error) {
      suiteFailures += 1;
      console.log(`  FAIL  suite threw: ${error?.stack ?? error}`);
    }

    violations.pageErrors.push(...pageViolations.pageErrors);
    violations.consoleErrors.push(...pageViolations.consoleErrors);
    violations.failedRequests.push(...pageViolations.failedRequests);

    totalFailures += suiteFailures;
    await session.close();
  }

  console.log(`\n${'='.repeat(72)}\nBrowser health check\n${'='.repeat(72)}`);
  totalFailures += reportBrowserViolations(violations);
  await harnessServer.close();

  if (totalFailures > 0) {
    console.log(`\nVERIFICATION FAILED — ${totalFailures} problem(s).\n`);
    process.exit(1);
  }

  console.log(`\nVERIFICATION PASSED — phases ${args.phases.join(', ')} clean.\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});