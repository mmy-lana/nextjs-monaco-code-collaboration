/**
 * Headless Chrome verification harness.
 *
 * Safety contract:
 *  - The browser is ALWAYS launched with a throwaway `--user-data-dir` created
 *    inside the OS temp directory, so no real browser profile (including the
 *    user's Zen browser) is ever opened, locked, or closed by this harness.
 *  - `browser.close()` only ever terminates the process this harness spawned.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..', '..');
export const ARTIFACT_DIR = join(PROJECT_ROOT, '.verify');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/**
 * Console noise that is an expected consequence of an air-gapped LAN test rig
 * rather than an application defect. Everything else is a hard failure.
 */
const EXPECTED_CONSOLE_NOISE = [
  /WebSocket connection to 'ws:\/\/localhost:\d+' failed/i,
  /y-webrtc/i,
  /Failed to load resource.*4444/i,
  /net::ERR_CONNECTION_REFUSED/i,
  /\[vite\] connect/i,
  /Download the React DevTools/i,
  /\[Report Only\]/i,
];

export function findChromeExecutable() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No Chrome executable found. Checked:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to override.`,
  );
}

export function ensureArtifactDir() {
  if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });
  return ARTIFACT_DIR;
}

export async function launchBrowser({ headless = true } = {}) {
  const executablePath = findChromeExecutable();
  const profileDir = mkdtempSync(join(tmpdir(), 'codex-headless-chrome-'));

  const browser = await puppeteer.launch({
    executablePath,
    headless,
    // Monaco instantiation + CRDT sync can take a while under emulation.
    protocolTimeout: 180_000,
    userDataDir: profileDir,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-default-apps',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars=false',
      '--window-size=1440,900',
    ],
  });

  return {
    browser,
    profileDir,
    async close() {
      try {
        await browser.close();
      } finally {
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  };
}

/** Attaches error collectors to a page and returns the live violation lists. */
export function watchPage(page, label = 'page') {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (EXPECTED_CONSOLE_NOISE.some((pattern) => pattern.test(text))) return;
    consoleErrors.push({ label, text });
  });

  page.on('pageerror', (error) => {
    pageErrors.push({ label, text: error?.message ?? String(error), stack: error?.stack ?? '' });
  });

  page.on('requestfailed', (request) => {
    const url = request.url();
    if (EXPECTED_CONSOLE_NOISE.some((pattern) => pattern.test(url))) return;
    failedRequests.push({ label, url, error: request.failure()?.errorText ?? 'unknown' });
  });

  return { consoleErrors, pageErrors, failedRequests };
}

/** Small assertion recorder producing a deterministic, printable report. */
export function createSuite(name) {
  const checks = [];
  let failures = 0;

  const push = (ok, label, detail) => {
    checks.push({ ok, label, detail });
    if (!ok) failures += 1;
    return ok;
  };

  return {
    name,
    checks,
    get failureCount() {
      return failures;
    },
    ok: (label, condition, detail = '') => push(Boolean(condition), label, detail),
    equal: (label, actual, expected) =>
      push(
        Object.is(actual, expected),
        label,
        Object.is(actual, expected) ? '' : `expected ${format(expected)}, received ${format(actual)}`,
      ),
    deepEqual: (label, actual, expected) => {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      return push(a === b, label, a === b ? '' : `expected ${b}, received ${a}`);
    },
    atLeast: (label, actual, min) =>
      push(
        typeof actual === 'number' && actual >= min,
        label,
        typeof actual === 'number' && actual >= min ? '' : `expected >= ${min}, received ${format(actual)}`,
      ),
    atMost: (label, actual, max) =>
      push(
        typeof actual === 'number' && actual <= max,
        label,
        typeof actual === 'number' && actual <= max ? '' : `expected <= ${max}, received ${format(actual)}`,
      ),
    fail: (label, detail) => push(false, label, detail),
    print() {
      const lines = [`\n── ${name} ─────────────────────────────────────────────`];
      for (const check of checks) {
        lines.push(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
      }
      const passed = checks.length - failures;
      lines.push(`  ${passed}/${checks.length} checks passed`);
      console.log(lines.join('\n'));
      return failures;
    },
  };
}

export function format(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function reportBrowserViolations(violations) {
  const total = violations.pageErrors.length + violations.consoleErrors.length + violations.failedRequests.length;
  if (total === 0) {
    console.log('  PASS  no page errors, console errors, or failed network requests');
    return 0;
  }
  console.log(`  FAIL  ${total} browser-level violation(s):`);
  for (const violation of violations.pageErrors) {
    console.log(`        [pageerror:${violation.label}] ${violation.text}`);
  }
  for (const violation of violations.consoleErrors) {
    console.log(`        [console:${violation.label}] ${violation.text}`);
  }
  for (const violation of violations.failedRequests) {
    console.log(`        [request:${violation.label}] ${violation.url} (${violation.error})`);
  }
  return total;
}

/**
 * Clicks the centre of an element with a real mouse event.
 *
 * `page.click` additionally waits for the element's box to settle, which can
 * block indefinitely on pages that keep re-rendering (a live CRDT session does
 * exactly that). Locating the box first and issuing the raw mouse event keeps
 * the input realistic without the stability heuristic.
 */
export async function clickElement(page, selector) {
  const box = await page.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function captureScreenshot(page, name) {
  ensureArtifactDir();
  const path = join(ARTIFACT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`  ....  screenshot → ${path}`);
  return path;
}

/** Waits until the app renders its shell (or throws a descriptive timeout). */
export async function waitForAppShell(page, selector = '[data-testid="vscode-shell"]', timeout = 30000) {
  await page.waitForSelector(selector, { timeout });
}

/** Clears IndexedDB + localStorage so each suite starts from a pristine slate. */
export async function resetBrowserState(page) {
  await page.evaluate(async () => {
    if (window.localStorage) window.localStorage.clear();
    if (window.sessionStorage) window.sessionStorage.clear();
    if (!window.indexedDB) return;
    const databases = await indexedDB.databases?.();
    await Promise.all(
      (databases ?? [])
        .filter((db) => db.name && db.name.startsWith('LANCodeCollab'))
        .map(
          (db) =>
            new Promise((resolve) => {
              const request = indexedDB.deleteDatabase(db.name);
              request.onsuccess = () => resolve(undefined);
              request.onerror = () => resolve(undefined);
              request.onblocked = () => resolve(undefined);
            }),
        ),
    );
  });
}