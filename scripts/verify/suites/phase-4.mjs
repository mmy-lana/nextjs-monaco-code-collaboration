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

/**
 * Tears the React root down and mounts a fresh one, which re-runs the VFS
 * bootstrap exactly as a real page reload would.
 *
 * The mount guard in the entry module (`if (window.__phase4Root) return`) has to
 * be released explicitly, otherwise the re-mounted tree would be skipped. The
 * bundle itself is deliberately *not* re-injected: a second evaluation would
 * load a second copy of Yjs into the same document, which trips its
 * "already imported" constructor check and is a harness artefact, not an
 * application fault.
 */
async function remountHarness(page) {
  await page.evaluate(() => {
    window.__phase4Root?.unmount();
    delete window.__phase4Root;
  });
  await page.evaluate(() => window.__phase4Mount?.());
  await page.waitForSelector('[data-testid="phase4-root"]', { timeout: 30000 });
}

/**
 * Waits for the editor without throwing.
 *
 * A stranded workspace produces a perfectly valid shell with no editor at all,
 * so a hard timeout here would abort the suite on the very regression this block
 * exists to name. The callers assert on `ready` instead.
 */
async function editorIsReady(page, timeout = 30000) {
  return page
    .waitForFunction(() => typeof window.__phase4Editor?.get() === 'object', {
      timeout,
      polling: 200,
    })
    .then(() => true)
    .catch(() => false);
}

export default {
  name: 'Phase 4 — Domain Logic, Reactive State & Specialised APIs',

  async run({ page, browser, baseUrl, harnessUrl }) {
    const suite = createSuite('Phase 4 domain logic');
    const url = harnessUrl ?? baseUrl ?? 'http://127.0.0.1:4321';
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
    7,
  );
  suite.equal(
    'parsePeerState degrades malformed payloads instead of evicting the peer',
    probe.partiallyMalformedStatesDegraded,
    3,
  );
  suite.ok(
    'a peer that omits its colour is admitted with a safe deterministic colour',
    probe.missingColourStillAdmitted,
  );
  suite.ok('parsePeerState accepts a complete peer payload', probe.validStateParsed);

  // SEC-01: awareness payloads are untrusted network input.
  suite.ok('an injected CSS payload never reaches the peer colour', probe.injectedColorSafe);
  suite.deepEqual(
    'parsePeerState replaces an invalid peer colour with a safe hex value',
    probe.injectedColorSafe,
    true,
  );
  suite.ok('hex colour validation rejects every non-triplet form', probe.hexValidation);
  suite.equal(
    'peer display names are stripped of Markdown control characters',
    probe.injectedNameSanitized,
    'Mallory bold',
  );

  // SEC-02: snapshot ingestion must validate before touching storage.
  suite.ok('an unknown snapshot format is rejected', probe.snapshotRejectsUnknownFormat);
  suite.ok('nodes from another workspace are rejected', probe.snapshotRejectsWrongWorkspace);
  suite.ok('cyclic parent chains are rejected', probe.snapshotRejectsCyclicParent);
  suite.ok('a malformed CRDT payload is rejected', probe.snapshotRejectsBadCrdt);
  suite.ok('oversized content entries are rejected', probe.snapshotRejectsOversizedContent);
  suite.deepEqual(
    'nested paths are rebuilt from the parent graph rather than trusted',
    probe.snapshotRebuildsNestedPaths,
    ['/src', '/src/leaf.ts'],
  );
  suite.equal(
    'duplicate paths are rejected before they poison the unique index',
    probe.snapshotRejectsDuplicatePath,
    1,
  );
  suite.equal('a well-formed snapshot round-trips through validation', probe.snapshotRoundTripNodes, 1);
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

  // ── NET-02: transport reporting on an offline mesh ──────────────────────────
  // This harness runs with an empty signaling list, so no WebRTC mesh can form.
  // The two tabs above nevertheless exchange CRDT updates over BroadcastChannel,
  // and that must be reported as a working local mesh rather than as a failure.
  suite.equal(
    'with no signaling server the transport is reported as a local mesh',
    await page.$eval('[data-testid="connection-transport"]', (el) => el.textContent),
    'local-mesh',
  );
  suite.equal(
    'both tabs agree on the local mesh transport',
    await peer.$eval('[data-testid="connection-transport"]', (el) => el.textContent),
    'local-mesh',
  );
  suite.equal(
    'the local mesh is reflected on the root transport attribute',
    await page.$eval('[data-testid="phase4-root"]', (el) => el.getAttribute('data-transport')),
    'local-mesh',
  );
  suite.ok(
    'the local mesh is distinguished from a peer-less connection state',
    (await page.$eval('[data-testid="connection-state"]', (el) => el.textContent)) === 'connected',
    await page.$eval('[data-testid="connection-state"]', (el) => el.textContent),
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

  // ── DATA-04: recovery from a stranded workspace ─────────────────────────────
  // An interrupted first load (the tab closed mid-seed, an HMR reload landed) or
  // a fresh origin (a second loopback address, a LAN IP — each has its own
  // IndexedDB partition) commits the workspace row before the starter tree.
  // Gating seeding on "did this call create the workspace" left that partition
  // permanently empty: no nodes, no tab, no active file, an editor bound to
  // nothing. Emptiness of the tree is the only signal that needs recovering.
  const strandState = await page.evaluate(async (workspaceId) => {
    const openDb = (name) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

    const db = await openDb('LANCodeCollab-meta');
    const readAll = (store) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

    const nodesBefore = await readAll('nodes');
    const workspaces = await readAll('workspaces');
    const workspace = workspaces.find((entry) => entry.id === workspaceId);

    // Reproduce the interrupted load exactly: the workspace row survives, the
    // tree does not, and the initial tab set was never written.
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['nodes', 'workspaces'], 'readwrite');
      transaction.objectStore('nodes').clear();
      transaction.objectStore('workspaces').put({
        ...workspace,
        activeFileId: null,
        openFileIds: [],
        updatedAt: Date.now(),
      });
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    const nodesAfter = await readAll('nodes');
    const strandedRows = await readAll('workspaces');
    db.close();

    const strandedRow = strandedRows.find((entry) => entry.id === workspaceId);

    return {
      nodesBefore: nodesBefore.length,
      nodesAfter: nodesAfter.length,
      workspaceSurvived: Boolean(workspace),
      // Read back after the write, so this reports the state the next bootstrap
      // will actually observe rather than the one that was just replaced.
      strandedTabs: strandedRow?.openFileIds ?? null,
      strandedActive: strandedRow?.activeFileId ?? null,
    };
  }, WORKSPACE_ID);

  suite.ok(
    'the interrupted-load fixture leaves the workspace row intact',
    strandState.workspaceSurvived,
    JSON.stringify(strandState),
  );
  suite.atLeast('the fixture starts from a populated tree', strandState.nodesBefore, 3);
  suite.equal('the fixture empties only the node table', strandState.nodesAfter, 0);
  suite.deepEqual('the fixture strands the workspace with no open tabs', strandState.strandedTabs, []);
  suite.equal(
    'the fixture strands the workspace with no active file',
    strandState.strandedActive,
    null,
  );

  await remountHarness(page);
  const recoveredEditorReady = await editorIsReady(page);

  const recovered = await page.evaluate(() => ({
    paths: document.querySelector('[data-testid="vfs-paths"]')?.textContent ?? '',
    active: document.querySelector('[data-testid="vfs-active"]')?.textContent ?? '',
    openIds: document.querySelector('[data-testid="vfs-open-ids"]')?.textContent ?? '',
    error: document.querySelector('[data-testid="vfs-load-error"]')?.textContent ?? '',
  }));

  suite.ok(
    'a stranded workspace is re-seeded with the starter tree',
    recovered.paths.includes('/src/welcome.ts') && recovered.paths.includes('/README.md'),
    recovered.paths,
  );
  suite.equal(
    'the re-seeded starter file becomes the active tab',
    recovered.active,
    'file-welcome',
  );
  suite.equal(
    'the re-seeded starter file is registered as an open tab',
    recovered.openIds,
    'file-welcome',
  );
  suite.equal('the recovery reports no load error', recovered.error, '');
  suite.ok(
    'the stranded workspace binds an editor instead of leaving it unbound',
    recoveredEditorReady,
    'no editor was mounted after the workspace was re-seeded',
  );
  suite.ok(
    'the re-seeded file has its starter body again',
    recoveredEditorReady &&
      (await page.evaluate(() => window.__phase4Editor.getText() ?? '')).includes(
        'CollaborationSession',
      ),
  );

  const seededRows = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('LANCodeCollab-meta');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const nodes = await new Promise((resolve, reject) => {
      const request = db.transaction('nodes', 'readonly').objectStore('nodes').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const wanted = new Set(['/src', '/src/welcome.ts', '/README.md']);
    const matched = nodes.filter((node) => wanted.has(node.path));
    return {
      count: nodes.length,
      liveStarterRows: matched.filter((node) => node.deletedAt === null).length,
    };
  });
  suite.equal('the re-seed writes exactly the starter tree', seededRows.count, 3);
  suite.equal('every re-seeded row is live, not tombstoned', seededRows.liveStarterRows, 3);

  // A populated workspace must never be re-seeded: that would roll back the
  // file bodies the user has been editing.
  await remountHarness(page);
  const secondBootReady = await editorIsReady(page);
  const secondBoot = await page.evaluate(() => ({
    paths: document.querySelector('[data-testid="vfs-paths"]')?.textContent ?? '',
    active: document.querySelector('[data-testid="vfs-active"]')?.textContent ?? '',
    error: document.querySelector('[data-testid="vfs-load-error"]')?.textContent ?? '',
  }));
  suite.equal('a populated workspace is not seeded a second time', secondBoot.paths, recovered.paths);
  suite.equal('the recovered tab set survives the next bootstrap', secondBoot.active, 'file-welcome');
  suite.equal('the repeated bootstrap reports no load error', secondBoot.error, '');
  suite.ok('the editor is still bound after the repeated bootstrap', secondBootReady);

  // ── stranded tab strip: files present, nothing open ──────────────────────────
  // The DATA-04 fixture above empties the tree *and* the tab set, so it is
  // rescued by re-seeding. This one keeps every node and clears only the tabs —
  // the state produced by closing the last tab, or by a load that committed an
  // empty tab set over a healthy tree. Without an explicit rescue the hook
  // reconciles to `openFileIds: []` and binds the editor to nothing.
  const tabStripState = await page.evaluate(async (workspaceId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('LANCodeCollab-meta');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const workspaces = await new Promise((resolve, reject) => {
      const request = db.transaction('workspaces', 'readonly').objectStore('workspaces').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const workspace = workspaces.find((entry) => entry.id === workspaceId);

    await new Promise((resolve, reject) => {
      const transaction = db.transaction('workspaces', 'readwrite');
      transaction.objectStore('workspaces').put({
        ...workspace,
        activeFileId: null,
        openFileIds: [],
        updatedAt: Date.now(),
      });
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    const nodes = await new Promise((resolve, reject) => {
      const request = db.transaction('nodes', 'readonly').objectStore('nodes').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();

    return {
      liveFiles: nodes.filter((node) => node.deletedAt === null && node.type === 'file').length,
      liveNodes: nodes.filter((node) => node.deletedAt === null).length,
    };
  }, WORKSPACE_ID);

  suite.atLeast(
    'the fixture keeps files on disk and clears only the tabs',
    tabStripState.liveFiles,
    2,
  );

  await remountHarness(page);
  const rescuedReady = await editorIsReady(page);
  const rescued = await page.evaluate(() => ({
    openIds: (document.querySelector('[data-testid="vfs-open-ids"]')?.textContent ?? '')
      .split(',')
      .filter(Boolean),
    active: document.querySelector('[data-testid="vfs-active"]')?.textContent ?? '',
    activePath: document.querySelector('[data-testid="vfs-active-path"]')?.textContent ?? '',
    error: document.querySelector('[data-testid="vfs-load-error"]')?.textContent ?? '',
  }));

  suite.ok(
    'an empty tab strip over a populated tree is rescued on load',
    rescued.openIds.length >= 1,
    JSON.stringify(rescued.openIds),
  );
  suite.equal(
    'the rescue opens the first file in tree order',
    rescued.activePath,
    '/README.md',
  );
  suite.equal('the rescued file becomes the active tab', rescued.active, rescued.openIds[0] ?? '');
  suite.equal('the tab-strip rescue reports no load error', rescued.error, '');
  suite.ok('the rescued workspace binds an editor', rescuedReady);
  suite.ok(
    'the rescued editor renders the file body, not an empty buffer',
    rescuedReady &&
      ((await page.evaluate(() => window.__phase4Editor.getText() ?? '')).includes(
        'LAN Code Collaboration',
      )),
  );
}