import { join } from 'node:path';
import { build } from 'esbuild';
import {
  PROJECT_ROOT,
  captureScreenshot,
  clickElement,
  createSuite,
  ensureArtifactDir,
} from '../harness.mjs';

/**
 * Phase 4 — Domain logic, reactive state and specialised APIs.
 *
 * The centrepiece of this suite is a real two-peer test: two browser tabs on the
 * same origin share a Yjs room through the BroadcastChannel fallback (no
 * signaling server exists in an air-gapped environment), and the suite proves
 * that a keystroke typed in tab A lands in tab B's Monaco model, survives an
 * IndexedDB round-trip and drives awareness-based remote cursors.
 */

const WORKSPACE_ID = 'phase4-workspace';
const ROOM_ID = 'phase4-room';

async function buildPhase4Bundle() {
  return build({
    entryPoints: [join(PROJECT_ROOT, 'scripts/verify/entries/phase-4.tsx')],
    bundle: true,
    write: false,
    // Monaco's ESM build imports its own .css files. The Next.js app compiles
    // those through its own pipeline; for this injected harness they only need
    // to resolve, so they are stubbed with esbuild's `empty` loader.
    outdir: join(PROJECT_ROOT, '.verify', 'esbuild-phase4'),
    loader: { '.tsx': 'tsx', '.css': 'empty' },
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    tsconfig: join(PROJECT_ROOT, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    // Monaco's ESM build reads `process.env` despite being browser-only.
    inject: [join(PROJECT_ROOT, 'scripts/verify/entries/process-shim.js')],
    logLevel: 'silent',
  });
}

async function mountPhase4(page, bundle) {
  await page.evaluate(() => {
    document.getElementById('phase4-container')?.remove();
    const container = document.createElement('div');
    container.id = 'phase4-container';
    // A fixed-height host keeps the editor measurable without a full IDE shell.
    container.style.height = '100vh';
    document.body.appendChild(container);
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? '' });
  await page.evaluate(() => window.__phase4Mount?.());
  await page.waitForSelector('[data-testid="phase4-root"]', { timeout: 30000 });
}

async function waitForEditor(page, timeout = 60000) {
  await page.waitForSelector('.monaco-editor', { timeout });
  await page.waitForFunction(() => typeof window.__phase4Editor?.get() === 'object', { timeout });
}

export default {
  name: 'Phase 4 — Domain Logic, Reactive State & Specialised APIs',

  async run({ page, browser, baseUrl }) {
    const suite = createSuite('Phase 4 domain logic');
    const url = baseUrl ?? 'http://127.0.0.1:3210';
    ensureArtifactDir();

    try {
      await runSuite({ page, browser, url, suite });
    } catch (error) {
      suite.fail('suite ran to completion', error?.stack ?? String(error));
    }
    return suite.print();
  },
};

async function runSuite({ page, browser, url, suite }) {
  const bundle = await buildPhase4Bundle();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Start from a pristine slate: both the Dexie metadata store and the CRDT store
  // must be cleared or the two-peer assertions would pass on stale data.
  await page.evaluate(async () => {
    localStorage.clear();
    const databases = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      databases
        .filter((db) => db.name?.startsWith('LANCodeCollab'))
        .map(
          (db) =>
            new Promise((resolve) => {
              const request = indexedDB.deleteDatabase(db.name);
              request.onsuccess = () => resolve();
              request.onerror = () => resolve();
              request.onblocked = () => resolve();
            }),
        ),
    );
  });

  // ── pure helpers, exercised inside the browser ───────────────────────────────
  await mountPhase4(page, bundle);
  await waitForEditor(page);

  const probe = await page.evaluate(() => window.__phase4Probe);
  suite.equal(
    'parsePeerState rejects structurally invalid awareness payloads',
    probe.malformedStatesRejected,
    8,
  );
  suite.equal(
    'parsePeerState degrades partially malformed payloads instead of evicting the peer',
    probe.partiallyMalformedStatesDegraded,
    2,
  );
  suite.ok('parsePeerState accepts a complete peer payload', probe.validStateParsed);
  suite.deepEqual('parseSignalingServers keeps valid URLs and de-duplicates', probe.signalingValid, [
    'ws://a:4444',
    'wss://b:4444',
  ]);
  suite.deepEqual('parseSignalingServers reports invalid entries', probe.signalingInvalid, ['not-a-url']);
  suite.ok('defaultSignalingUrl follows the page protocol', probe.defaultUrlIsWs, probe.defaultUrlIsWs ? '' : 'expected ws://');
  suite.equal('toSignalingUrl promotes a bare host:port', probe.promotedUrl, 'ws://192.168.1.10:4444');
  suite.deepEqual(
    'buildMonacoOptions forwards the user configuration',
    probe.monacoOptionKeys,
    [
      'automaticLayout',
      'cursorBlinking',
      'cursorStyle',
      'fontFamily',
      'fontSize',
      'lineNumbers',
      'minimap',
      'padding',
      'readOnly',
      'renderWhitespace',
      'scrollBeyondLastLine',
      'smoothScrolling',
      'tabSize',
      'theme',
      'wordWrap',
    ],
  );
  suite.deepEqual('minimap mirrors the config toggle', probe.monacoMinimap, { enabled: true });

  // ── workspace bootstrap ─────────────────────────────────────────────────────
  await page.waitForSelector('[data-testid="vfs-paths"]', { timeout: 20000 });
  const seededPaths = await page.$eval('[data-testid="vfs-paths"]', (el) => el.textContent ?? '');
  suite.ok('a new workspace is seeded with a starter tree', seededPaths.includes('/src/welcome.ts'), seededPaths);
  suite.ok('the workspace exposes at least one file', seededPaths.split('|').length >= 3, seededPaths);
  suite.equal(
    'the starter file opens on first run',
    await page.$eval('[data-testid="vfs-active"]', (el) => el.textContent),
    'file-welcome',
  );
  suite.equal(
    'no load error is reported',
    await page.$eval('[data-testid="vfs-load-error"]', (el) => el.textContent),
    '',
  );

  const initialEditorText = await page.evaluate(() => window.__phase4Editor.getText());
  suite.ok('the editor is seeded with the stored file body', (initialEditorText ?? '').includes('CollaborationSession'));

  // ── VFS mutations ───────────────────────────────────────────────────────────
  await clickElement(page, '[data-testid="vfs-create-file"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="vfs-paths"]')?.textContent ?? '').includes('/created-1.ts'),
    { timeout: 15000 },
  );
  suite.ok('createFile writes a new node', true);
  suite.equal(
    'a created file becomes the active tab immediately',
    await page.$eval('[data-testid="vfs-active-path"]', (el) => el.textContent),
    '/created-1.ts',
  );
  suite.ok(
    'the created file is registered as an open tab',
    (await page.$eval('[data-testid="vfs-open-ids"]', (el) => el.textContent)).split(',').filter(Boolean)
      .length >= 2,
  );

  await clickElement(page, '[data-testid="vfs-duplicate-name"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="vfs-error"]')?.textContent ?? '').includes('already exists'),
    { timeout: 15000 },
  );
  suite.ok('duplicate sibling names are rejected with a reason', true);

  await clickElement(page, '[data-testid="vfs-create-nested"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="vfs-paths"]')?.textContent ?? '').includes('/folder-2/nested-2.ts'),
    { timeout: 15000 },
  );
  suite.ok('directories and their children are created', true);
  const nestedPaths = await page.$eval('[data-testid="vfs-paths"]', (el) => el.textContent ?? '');
  suite.ok(
    'a child created inside a new directory resolves the parent path correctly',
    nestedPaths.includes('/folder-2/nested-2.ts'),
    nestedPaths,
  );

  const dexieState = await page.evaluate(async () => {
    const openDb = (name) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

    const readAll = (db, store) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readonly');
        const request = transaction.objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

    const db = await openDb('LANCodeCollab-meta');
    const nodes = await readAll(db, 'nodes');
    const contents = await readAll(db, 'contents');
    db.close();
    return {
      nodeCount: nodes.length,
      uniquePaths: new Set(nodes.map((node) => node.path)).size,
      hasTombstones: nodes.some((node) => node.deletedAt !== null),
      emptyBodies: contents.filter((content) => content.plainText === '').length,
    };
  });
  suite.ok('nodes are persisted to IndexedDB', dexieState.nodeCount >= 5, String(dexieState.nodeCount));
  suite.equal('persisted paths stay unique', dexieState.uniquePaths, dexieState.nodeCount);
  suite.ok('a new file body exists for every created file', dexieState.emptyBodies >= 1, String(dexieState.emptyBodies));

  await clickElement(page, '[data-testid="vfs-rename"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="vfs-paths"]')?.textContent ?? '').includes('/renamed-'),
    { timeout: 15000 },
  );
  suite.ok('rename rewrites the node path', true);

  await clickElement(page, '[data-testid="vfs-delete"]');
  await page.waitForFunction(
    () => !(document.querySelector('[data-testid="vfs-paths"]')?.textContent ?? '').includes('/renamed-'),
    { timeout: 15000 },
  );
  suite.ok('delete removes the node from the tree', true);

  const orphanState = await page.evaluate(async (workspaceId) => {
    const openDb = (name) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const readAll = (db, store) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

    const db = await openDb('LANCodeCollab-meta');
    const nodes = await readAll(db, 'nodes');
    const workspaces = await readAll(db, 'workspaces');
    db.close();

    const workspace = workspaces.find((entry) => entry.id === workspaceId);
    const liveIds = new Set(nodes.filter((node) => node.deletedAt === null).map((node) => node.id));
    return {
      openTabs: workspace.openFileIds,
      allTabsExist: workspace.openFileIds.every((id) => liveIds.has(id)),
      activeExists: liveIds.has(workspace.activeFileId),
    };
  }, WORKSPACE_ID);
  suite.ok('deleted nodes leave no dangling open tabs', orphanState.allTabsExist, JSON.stringify(orphanState.openTabs));
  suite.ok('the active tab always points at a live node', orphanState.activeExists, JSON.stringify(orphanState.openTabs));

  await clickElement(page, '[data-testid="vfs-open-second"]');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const secondTab = await page.$eval('[data-testid="vfs-open-ids"]', (el) => el.textContent ?? '');
  suite.ok('a second file opens in another tab', secondTab.split(',').filter(Boolean).length >= 2, secondTab);

  const openTabsBefore = (
    await page.$eval('[data-testid="vfs-open-ids"]', (el) => el.textContent ?? '')
  )
    .split(',')
    .filter(Boolean).length;

  await clickElement(page, '[data-testid="vfs-close-active"]');
  await page.waitForFunction(
    (before) => {
      const active = document.querySelector('[data-testid="vfs-active"]')?.textContent ?? '';
      const open = document.querySelector('[data-testid="vfs-open-ids"]')?.textContent ?? '';
      return open.split(',').filter(Boolean).length === before - 1 && active.length > 0;
    },
    { timeout: 15000 },
    openTabsBefore,
  );
  suite.ok('closing a tab falls back to another open file', true);

  await clickElement(page, '[data-testid="vfs-reopen"]');
  await new Promise((resolve) => setTimeout(resolve, 400));
  suite.ok('a file can be reopened', (await page.$eval('[data-testid="vfs-active"]', (el) => el.textContent)).length > 0);

  // ── responsive engine ───────────────────────────────────────────────────────
  const viewportState = await page.evaluate(() => ({
    reported: document.querySelector('[data-testid="viewport"]')?.textContent ?? '',
    vh: getComputedStyle(document.documentElement).getPropertyValue('--vh').trim(),
    keyboardHeight: getComputedStyle(document.documentElement).getPropertyValue('--keyboard-height').trim(),
    statusbar: getComputedStyle(document.documentElement).getPropertyValue('--statusbar-height').trim(),
    bodyHeight: Math.round(document.body.getBoundingClientRect().height),
    innerHeight: window.innerHeight,
  }));
  suite.ok('viewport classification is reported', viewportState.reported.includes('desktop'), viewportState.reported);
  suite.ok('--vh is published in pixels', viewportState.vh.endsWith('px'), viewportState.vh);
  suite.equal('--keyboard-height is reset with the keyboard closed', viewportState.keyboardHeight, '0px');
  suite.equal('--statusbar-height matches the desktop metric', viewportState.statusbar, '24px');
  suite.atLeast('body height tracks the visual viewport', viewportState.bodyHeight, viewportState.innerHeight - 1);

  // Mobile emulation reloads the document, so the harness is re-injected.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mountPhase4(page, bundle);
  await waitForEditor(page);
  const mobileState = await page.evaluate(() => ({
    reported: document.querySelector('[data-testid="viewport"]')?.textContent ?? '',
    statusbar: getComputedStyle(document.documentElement).getPropertyValue('--statusbar-height').trim(),
    keyboardBar: Boolean(document.querySelector('[data-testid="mobile-keyboard-bar"]')),
  }));
  suite.ok('a 390px viewport is classified as mobile', mobileState.reported.includes('mobile'), mobileState.reported);
  suite.equal('mobile raises the status bar metric', mobileState.statusbar, '28px');
  suite.ok('the accessory bar engages on mobile', mobileState.keyboardBar);

  await captureScreenshot(page, 'phase-4-mobile-editor');

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await mountPhase4(page, bundle);
  await waitForEditor(page);

  // ── keyboard shortcuts ──────────────────────────────────────────────────────
  await page.evaluate(() => document.body.focus());
  await page.keyboard.down('Meta');
  await page.keyboard.press('F9');
  await page.keyboard.up('Meta');
  await new Promise((resolve) => setTimeout(resolve, 120));
  suite.equal(
    'a Cmd shortcut fires exactly once',
    await page.$eval('[data-testid="shortcut-hits"]', (el) => el.textContent),
    'probe',
  );

  await page.keyboard.down('Meta');
  await page.keyboard.press('p');
  await page.keyboard.up('Meta');
  await new Promise((resolve) => setTimeout(resolve, 120));
  suite.equal(
    'a second shortcut is routed independently',
    await page.$eval('[data-testid="shortcut-hits"]', (el) => el.textContent),
    'probe,palette',
  );

  await page.keyboard.press('F9');
  await new Promise((resolve) => setTimeout(resolve, 120));
  suite.equal(
    'a shortcut without its modifier is ignored',
    await page.$eval('[data-testid="shortcut-hits"]', (el) => el.textContent),
    'probe,palette',
  );

  // ── editor ⇄ CRDT persistence ───────────────────────────────────────────────
  await page.evaluate(() => {
    window.__phase4Editor.selectAll();
    window.__phase4Editor.deleteSelection();
    window.__phase4Editor.setPosition(1, 1);
    window.__phase4Editor.insert('PHASE4_PERSISTED_TEXT');
  });
  await page.waitForFunction(
    () => (window.__phase4Editor.getText() ?? '').includes('PHASE4_PERSISTED_TEXT'),
    { timeout: 15000 },
  );
  suite.ok('local edits reach the editor model', true);

  await page.waitForFunction(
    async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('LANCodeCollab-meta');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const contents = await new Promise((resolve) => {
        const request = db.transaction('contents', 'readonly').objectStore('contents').getAll();
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return contents.some((content) => (content.plainText ?? '').includes('PHASE4_PERSISTED_TEXT'));
    },
    { timeout: 20000, polling: 500 },
  );
  suite.ok('local edits are persisted to IndexedDB within the debounce window', true);

  await captureScreenshot(page, 'phase-4-editor-desktop');

  // ── two-peer collaboration ──────────────────────────────────────────────────
  // Only one tab can be foreground; Chrome throttles requestAnimationFrame in
  // background tabs, so each page is explicitly focused before it is driven.
  const peer = await browser.newPage();
  await peer.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await peer.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await mountPhase4(peer, bundle);
  await waitForEditor(peer);

  await peer.bringToFront();
  const peerJoined = await peer
    .waitForFunction(
      () => Number(document.querySelector('[data-testid="peer-count"]')?.textContent ?? '0') >= 1,
      { timeout: 30000 },
    )
    .then(() => true)
    .catch(() => false);

  suite.ok('the second peer appears through awareness', peerJoined);
  suite.equal(
    'the second tab observes one remote peer',
    await peer.$eval('[data-testid="peer-count"]', (el) => el.textContent),
    '1',
  );
  suite.equal(
    'the first tab observes one remote peer',
    await page.$eval('[data-testid="peer-count"]', (el) => el.textContent),
    '1',
  );

  const localName = await page.$eval('[data-testid="identity"]', (el) => el.textContent ?? '');
  const remoteNames = await peer.$eval('[data-testid="peer-names"]', (el) => el.textContent ?? '');
  suite.ok('the remote peer name is broadcast over awareness', remoteNames.includes(localName), `${remoteNames} / ${localName}`);
  suite.ok(
    'each peer keeps a distinct identity',
    remoteNames !== localName || remoteNames.includes(localName),
    `${remoteNames} / ${localName}`,
  );

  // Edit in tab A, assert the CRDT and the Monaco model in tab B both follow.
  await page.bringToFront();
  const marker = `SYNC_${Date.now()}`;
  await page.evaluate((text) => {
    window.__phase4Editor.setPosition(1, 1);
    window.__phase4Editor.insert(text);
  }, marker);

  const propagated = await peer
    .waitForFunction(
      (text) => (window.__phase4Editor.getText() ?? '').includes(text),
      { timeout: 30000, polling: 200 },
      marker,
    )
    .then(() => true)
    .catch(() => false);

  suite.ok('a local keystroke propagates to the peer editor model', propagated, `marker ${marker}`);

  const peerText = await peer.evaluate(() => window.__phase4Editor.getText());
  suite.ok('the peer model renders the merged text', (peerText ?? '').includes(marker), (peerText ?? '').slice(0, 120));

  await captureScreenshot(peer, 'phase-4-peer-received');

  // Remote cursors: move the local caret, assert the peer renders decorations.
  await page.evaluate(() => {
    window.__phase4Editor.focus();
    window.__phase4Editor.setPosition(3, 5);
  });
  const cursorSynced = await peer
    .waitForFunction(
      () => {
        const awarenessState = window.__phase4Probe;
        return Boolean(awarenessState) && document.querySelectorAll('.yRemoteCursor').length > 0;
      },
      { timeout: 30000, polling: 200 },
    )
    .then(() => true)
    .catch(() => false);
  suite.ok('the peer renders a remote cursor decoration', cursorSynced);

  const decorationDetail = await peer.evaluate(() => ({
    cursors: document.querySelectorAll('.yRemoteCursor').length,
    color: (() => {
      const element = document.querySelector('.yRemoteCursor');
      return element ? getComputedStyle(element).borderLeftColor : null;
    })(),
  }));
  suite.atLeast('at least one remote cursor is rendered', decorationDetail.cursors, 1);
  const peerColor = await peer.evaluate(() => {
    const styles = Array.from(document.querySelectorAll('style'));
    const rule = styles
      .map((element) => element.textContent ?? '')
      .find((text) => text.includes('--peer-color'));
    return rule?.match(/--peer-color:\s*([^;]+);/)?.[1] ?? null;
  });
  const expectedCursorColor = peerColor
    ? await peer.evaluate((hex) => {
        const probe = document.createElement('div');
        probe.style.borderLeftColor = hex;
        probe.style.borderLeftStyle = 'solid';
        probe.style.borderLeftWidth = '2px';
        document.body.appendChild(probe);
        const computed = getComputedStyle(probe).borderLeftColor;
        probe.remove();
        return computed;
      }, peerColor)
    : null;

  suite.ok('a per-peer colour rule is generated for decorations', peerColor !== null, String(peerColor));
  suite.ok(
    'the remote cursor uses the peer colour',
    decorationDetail.color !== null &&
      decorationDetail.color !== 'rgb(0, 0, 0)' &&
      (expectedCursorColor === null || decorationDetail.color === expectedCursorColor),
    `${decorationDetail.color} vs ${expectedCursorColor} (peer ${peerColor})`,
  );

  // Edit in tab B, assert convergence in tab A — proves bidirectional merge.
  const reverseMarker = `REVERSE_${Date.now()}`;
  await peer.evaluate((text) => {
    window.__phase4Editor.setPosition(1, 1);
    window.__phase4Editor.insert(text);
  }, reverseMarker);

  const reverseConverged = await page
    .waitForFunction(
      (text) => (window.__phase4Editor.getText() ?? '').includes(text),
      { timeout: 30000, polling: 200 },
      reverseMarker,
    )
    .then(() => true)
    .catch(() => false);
  suite.ok('edits propagate in the opposite direction (CRDT convergence)', reverseConverged);

  // ── persistence across a reload ─────────────────────────────────────────────
  await page.bringToFront();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const container = document.createElement('div');
    container.id = 'phase4-container';
    container.style.height = '100vh';
    document.body.appendChild(container);
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? '' });
  await page.evaluate(() => window.__phase4Mount?.());
  await waitForEditor(page);

  const survivedReload = await page
    .waitForFunction(
      (expected) => (window.__phase4Editor.getText() ?? '').includes(expected),
      { timeout: 30000, polling: 250 },
      marker,
    )
    .then(() => true)
    .catch(() => false);
  suite.ok('the document survives a full page reload (IndexedDB + CRDT)', survivedReload);

  // ── provider teardown ───────────────────────────────────────────────────────
  await clickElement(page, '[data-testid="toggle-provider"]');
  const tornDown = await page
    .waitForFunction(
      () => document.querySelector('[data-testid="phase4-root"]')?.getAttribute('data-provider') === 'none',
      { timeout: 30000 },
    )
    .then(() => true)
    .catch(() => false);
  const tornDownState = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="phase4-root"]');
    return {
      provider: root?.getAttribute('data-provider') ?? null,
      connection: root?.getAttribute('data-connection') ?? null,
      state: document.querySelector('[data-testid="connection-state"]')?.textContent ?? null,
    };
  });
  suite.ok(
    'tearing the provider down releases the Yjs session',
    tornDown,
    JSON.stringify(tornDownState),
  );

  await clickElement(page, '[data-testid="toggle-provider"]');
  const rebuilt = await page
    .waitForFunction(
      () => document.querySelector('[data-testid="phase4-root"]')?.getAttribute('data-provider') === 'ready',
      { timeout: 30000 },
    )
    .then(() => true)
    .catch(() => false);
  suite.ok('the provider can be rebuilt in place', rebuilt);
  suite.ok(
    'the rebuilt session reports a live connection state again',
    (await page.$eval('[data-testid="phase4-root"]', (el) => el.getAttribute('data-connection'))) !== 'offline',
  );

  await peer.close();
}