import { join } from 'node:path';
import { build } from 'esbuild';
import { PROJECT_ROOT, captureScreenshot, createSuite } from '../harness.mjs';

/**
 * Phase 3 — Compound molecules and feature components.
 *
 * Every component is mounted with realistic fixtures and driven through its
 * real callbacks, so the suite proves the UI wiring (not just the markup).
 */
export default {
  name: 'Phase 3 — Compound Molecules & Feature Components',

  async run({ page, baseUrl }) {
    const suite = createSuite('Phase 3 feature components');
    const url = baseUrl ?? 'http://127.0.0.1:3210';

    try {
      await runSuite({ page, url, suite });
    } catch (error) {
      // A thrown step is a failure, never a silently truncated report.
      suite.fail('suite ran to completion', error?.stack ?? String(error));
    }
    return suite.print();
  },
};

async function runSuite({ page, url, suite }) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const bundle = await build({
    entryPoints: [join(PROJECT_ROOT, 'scripts/verify/entries/phase-3.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    tsconfig: join(PROJECT_ROOT, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  // `page.setViewport` with mobile emulation reloads the document, which wipes
  // an injected bundle — so mounting is factored out and re-run after each
  // emulation change.
  const mountHarness = async () => {
    await page.evaluate(() => {
      document.getElementById('phase3-container')?.remove();
      const container = document.createElement('div');
      container.id = 'phase3-container';
      document.body.appendChild(container);
    });
    await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? '' });
    await page.evaluate(() => window.__phase3Mount?.());
    await page.waitForSelector('[data-testid="phase3-root"]', { timeout: 15000 });
  };

  await mountHarness();

  const events = () => page.evaluate(() => window.__phase3.events);
  const reset = () => page.evaluate(() => window.__phase3.reset());

  // ── searchContents pure helper ──────────────────────────────────────────────
  const probe = await page.evaluate(() => window.__phase3.searchProbe);
  suite.equal('searchContents finds case-insensitive matches', probe.results.length, 2);
  suite.equal('searchContents reports the 1-based line number', probe.results[0].lineNumber, 1);
  suite.equal('searchContents reports the match column', probe.results[0].matchStart, 11);
  suite.equal('searchContents ignores an empty query', probe.emptyQuery, 0);
  suite.equal('searchContents matches regardless of case', probe.caseInsensitive, 1);
  suite.equal('searchContents honours the per-file match cap', probe.perFileCap, 2);

  // ── FileExplorerView / FileTreeNode ────────────────────────────────────────
  suite.equal('explorer reports the file count', await page.$eval('[data-testid="explorer-file-count"]', (el) => el.textContent), '3 files');

  const rootOrder = await page.$$eval('[role="tree"] > [data-node-type]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-node-path')),
  );
  suite.deepEqual('directories sort before files at the root', rootOrder, ['/src', '/README.md']);

  suite.equal(
    'expanded directory reports aria-expanded=true',
    await page.$eval('[data-node-path="/src"]', (el) => el.getAttribute('aria-expanded')),
    'true',
  );
  suite.equal(
    'active file reports aria-selected=true',
    await page.$eval('[data-node-path="/src/index.ts"]', (el) => el.getAttribute('aria-selected')),
    'true',
  );
  suite.ok(
    'nested children render when the parent is expanded',
    (await page.$('[data-node-path="/src/hooks"]')) !== null,
  );
  suite.equal(
    'collapsed nested directories hide their own children',
    await page.$('[data-node-path="/src/hooks/useVFS.ts"]'),
    null,
  );

  await page.click('[data-node-path="/src/hooks"]');
  suite.ok(
    'expanding a nested directory reveals its files',
    (await page.$('[data-node-path="/src/hooks/useVFS.ts"]')) !== null,
  );

  await page.click('[data-node-path="/src/index.ts"]');
  await reset();
  await page.click('[data-node-path="/src/index.ts"]');
  suite.deepEqual('opening a file fires onOpenFile with its id', await events(), ['open:index-ts']);

  await page.click('[data-node-path="/src"]');
  await reset();
  await page.click('[data-node-path="/src"]');
  suite.deepEqual('toggling a directory fires onToggleDirectory', await events(), ['toggle:src']);

  // Context menu is tap-driven (no hover) — the "…" trigger is always present.
  await reset();
  await page.click('[data-testid="file-tree-more-usevfs-ts"]');
  await page.waitForSelector('[data-testid="file-tree-menu-usevfs-ts-menu"]');
  const menuItems = await page.$$eval(
    '[data-testid="file-tree-menu-usevfs-ts-menu"] [role="menuitem"]',
    (items) => items.map((item) => item.textContent),
  );
  suite.ok('file action menu exposes Rename', menuItems.some((label) => label?.includes('Rename')), JSON.stringify(menuItems));
  suite.ok('file action menu exposes Delete', menuItems.some((label) => label?.includes('Delete')), JSON.stringify(menuItems));

  await page.click('[data-testid="file-tree-menu-usevfs-ts-item-rename"]');
  await page.waitForSelector('[data-testid="file-tree-rename-input-usevfs-ts"]');
  suite.ok('Rename switches the row into an inline editor', true);
  suite.equal(
    'inline editor is pre-filled with the current name',
    await page.$eval('[data-testid="file-tree-rename-input-usevfs-ts"]', (el) => el.value),
    'useVFS.ts',
  );
  suite.equal(
    'inline editor receives focus for immediate typing',
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    'file-tree-rename-input-usevfs-ts',
  );

  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="file-tree-rename-input-usevfs-ts"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'bad/name.ts');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="alert"]', { timeout: 5000 });
  suite.ok('invalid rename surfaces a validation message', true);
  suite.deepEqual('invalid rename is not committed', await events(), []);

  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="file-tree-rename-input-usevfs-ts"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'useVfsStore.ts');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await reset();
  await page.keyboard.press('Enter');
  await new Promise((resolve) => setTimeout(resolve, 80));
  suite.deepEqual(
    'valid rename commits through onRename',
    await events(),
    ['rename:usevfs-ts:useVfsStore.ts'],
  );

  await page.click('[data-testid="file-tree-more-src"]');
  await page.waitForSelector('[data-testid="file-tree-menu-src-menu"]');
  await reset();
  await page.click('[data-testid="file-tree-menu-src-item-new-file"]');
  suite.deepEqual('directory menu creates a file inside it', await events(), ['create-file:src']);

  await page.click('[data-testid="file-tree-more-src"]');
  await page.waitForSelector('[data-testid="file-tree-menu-src-menu"]');
  await reset();
  await page.click('[data-testid="file-tree-menu-src-item-new-folder"]');
  suite.deepEqual('directory menu creates a folder inside it', await events(), ['create-dir:src']);

  await page.click('[data-testid="file-tree-more-readme-md"]');
  await page.waitForSelector('[data-testid="file-tree-menu-readme-md-menu"]');
  await reset();
  await page.click('[data-testid="file-tree-menu-readme-md-item-delete"]');
  suite.deepEqual('file menu deletes through onDelete', await events(), ['delete:readme-md']);

  await reset();
  await page.click('[data-testid="explorer-new-file"]');
  await page.click('[data-testid="explorer-new-folder"]');
  suite.deepEqual('explorer header creates at the root', await events(), ['create-file:root', 'create-dir:root']);

  // Empty + error states.
  await page.click('[data-testid="explorer-break"]');
  await page.waitForSelector('[data-testid="file-explorer"] [role="alert"]', { timeout: 5000 });
  suite.ok('explorer renders an actionable error state', true);
  await reset();
  await page.click('[data-testid="explorer-retry"]');
  suite.deepEqual('error state offers a working retry', await events(), ['explorer-retry']);

  await page.click('[data-testid="explorer-empty"]');
  await page.waitForSelector('[data-testid="explorer-empty"]', { timeout: 5000 });
  suite.ok('explorer renders an empty state', true);

  // ── EditorTabs ─────────────────────────────────────────────────────────────
  suite.equal(
    'active tab is marked selected',
    await page.$eval('[data-testid="editor-tab-index-ts"]', (el) => el.getAttribute('aria-selected')),
    'true',
  );
  suite.equal(
    'inactive tab is not selected',
    await page.$eval('[data-testid="editor-tab-usevfs-ts"]', (el) => el.getAttribute('aria-selected')),
    'false',
  );
  suite.ok(
    'dirty tab renders an unsaved indicator',
    (await page.$('[data-testid="editor-tab-dirty-usevfs-ts"]')) !== null,
  );
  suite.ok(
    'dirty tab announces unsaved changes',
    (await page.$eval('[data-testid="editor-tab-usevfs-ts"]', (el) => el.getAttribute('aria-label'))).includes(
      'unsaved changes',
    ),
  );

  await reset();
  await page.click('[data-testid="editor-tab-usevfs-ts"]');
  suite.deepEqual('clicking a tab selects it', await events(), ['tab-select:usevfs-ts']);

  await reset();
  await page.click('[data-testid="editor-tab-close-index-ts"]');
  suite.deepEqual('close button closes that tab only', await events(), ['tab-close:index-ts']);

  await reset();
  await page.focus('[data-testid="editor-tab-index-ts"]');
  await page.keyboard.press('Delete');
  suite.deepEqual('Delete key closes the focused tab', await events(), ['tab-close:index-ts']);

  // ── BreadcrumbBar ──────────────────────────────────────────────────────────
  const crumbs = await page.$$eval('[data-testid^="breadcrumb-segment-"]', (nodes) =>
    nodes.map((node) => node.textContent?.trim()),
  );
  suite.deepEqual(
    'breadcrumb renders the full hierarchy',
    crumbs,
    ['src', 'hooks', 'useVFS.ts\u25be'],
  );

  await reset();
  await page.click('[data-testid="breadcrumb-segment-1"]');
  suite.deepEqual('ancestor segments navigate to their prefix', await events(), ['breadcrumb:/src/hooks']);

  // ── PeerAvatarGroup ────────────────────────────────────────────────────────
  const avatars = await page.evaluate(() => {
    const group = document.querySelectorAll('[data-testid="peer-avatar-group"]')[0];
    return group
      ? Array.from(group.querySelectorAll('[data-testid^="peer-avatar-"]')).map((node) =>
          node.getAttribute('data-testid'),
        )
      : [];
  });
  suite.deepEqual(
    'avatar group renders max avatars, a pending chip and an overflow chip',
    avatars,
    ['peer-avatar-11', 'peer-avatar-33', 'peer-avatar-pending', 'peer-avatar-overflow'],
  );
  suite.ok('overflow avatars collapse into a counter', avatars.includes('peer-avatar-overflow'));
  suite.ok(
    'peer rows expose an accessible label',
    (await page.$eval('[data-testid="peer-avatar-11"]', (el) => el.getAttribute('aria-label'))).includes('Ada'),
  );
  suite.ok(
    'empty roster renders an explicit empty state',
    (await page.$('[data-testid="peer-avatar-empty"]')) !== null,
  );

  // ── CommandPaletteModal ────────────────────────────────────────────────────
  await reset();
  await page.click('[data-testid="toggle-palette"]');
  await page.waitForSelector('[data-testid="command-palette"]', { timeout: 5000 });
  suite.equal(
    'palette focuses its query input on open',
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    'command-palette-input',
  );

  const initialOptions = await page.$$eval('[data-testid^="command-palette-option-"]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  );
  suite.equal('palette lists every workspace file', initialOptions.length, 3);

  await page.type('[data-testid="command-palette-input"]', 'usevfs');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const filteredOptions = await page.$$eval('[data-testid^="command-palette-option-"]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  );
  suite.deepEqual('fuzzy search narrows to the matching file', filteredOptions, ['command-palette-option-file:usevfs-ts']);

  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="command-palette-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'zzzz');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForSelector('[data-testid="command-palette-empty"]', { timeout: 5000 });
  suite.ok('palette renders a no-results state', true);

  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="command-palette-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await reset();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await new Promise((resolve) => setTimeout(resolve, 80));
  suite.ok('Enter opens the highlighted result', (await events()).some((event) => event.startsWith('palette-open:')), JSON.stringify(await events()));

  // Reopen and exercise the command corpus.
  await page.click('[data-testid="toggle-palette"]');
  await page.waitForSelector('[data-testid="command-palette"]', { timeout: 5000 });
  await reset();
  await page.keyboard.press('Tab');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const commandOptions = await page.$$eval('[data-testid^="command-palette-option-"]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  );
  suite.deepEqual('Tab switches the palette to the command corpus', commandOptions, [
    'command-palette-option-command:cmd-format',
    'command-palette-option-command:cmd-save',
  ]);

  await page.keyboard.press('Enter');
  await new Promise((resolve) => setTimeout(resolve, 80));
  suite.ok('commands execute through the palette', (await events()).some((event) => event.startsWith('palette-command:')), JSON.stringify(await events()));
  suite.ok('palette closes after running a command', (await page.$('[data-testid="command-palette"]')) === null);

  // ── MobileKeyboardBar ──────────────────────────────────────────────────────
  const insertKeys = await page.$$eval('[data-testid^="keyboard-bar-insert-"]', (nodes) => nodes.length);
  suite.atLeast('accessory bar exposes the full quick-input set', insertKeys, 12);
  suite.equal(
    'accessory bar exposes undo and redo',
    await page.$eval('[data-testid="keyboard-bar-undo"]', (el) => el.getAttribute('aria-label')),
    'Undo',
  );

  const barMetrics = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="keyboard-bar-insert-;"]');
    const bar = document.querySelector('[data-testid="mobile-keyboard-bar"]');
    return {
      height: button ? Math.round(button.getBoundingClientRect().height) : 0,
      barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
      overflowX: bar ? getComputedStyle(bar).overflowX : null,
    };
  });
  suite.atLeast('accessory bar buttons keep a comfortable touch height', barMetrics.height, 32);
  suite.atLeast('accessory bar keeps its 40px tray height', barMetrics.barHeight, 38);
  suite.equal('accessory bar scrolls horizontally', barMetrics.overflowX, 'auto');

  await reset();
  await page.click('[data-testid="keyboard-bar-insert-;"]');
  await page.click('[data-testid="keyboard-bar-insert-{"]');
  await page.click('[data-testid="keyboard-bar-undo"]');
  await page.click('[data-testid="keyboard-bar-outdent"]');
  suite.deepEqual('accessory bar forwards inserts and commands', await events(), ['insert:;', 'insert:{', 'kbd:undo', 'kbd:outdent']);

  await page.click('[data-testid="toggle-keyboard-bar"]');
  suite.equal('accessory bar hides when not needed', await page.$('[data-testid="mobile-keyboard-bar"]'), null);
  await page.click('[data-testid="toggle-keyboard-bar"]');
  suite.ok('accessory bar returns when needed', (await page.$('[data-testid="mobile-keyboard-bar"]')) !== null);

  // ── CollaborationView ──────────────────────────────────────────────────────
  suite.equal(
    'connection chip reflects the provider state',
    await page.$eval('[data-testid="connection-chip"]', (el) => el.textContent),
    'Connected',
  );
  suite.equal(
    'room id is prefilled',
    await page.$eval('[data-testid="room-id-input"]', (el) => el.value),
    'collab-workspace-lan',
  );
  suite.equal(
    'apply is disabled until the room id changes',
    await page.$eval('[data-testid="room-apply"]', (el) => el.disabled),
    true,
  );

  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="room-id-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'ab');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('[data-testid="room-apply"]');
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('[role="alert"]')).some((node) =>
        (node.textContent ?? '').includes('at least 3 characters'),
      ),
    { timeout: 5000 },
  );
  suite.ok('short room ids are rejected with a reason', true);

  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="room-id-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'design review');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('[data-testid="room-apply"]');
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('[role="alert"]')).some((node) =>
        (node.textContent ?? '').includes('letters, digits'),
      ),
    { timeout: 5000 },
  );
  suite.ok('room ids with illegal characters are rejected', true);

  await reset();
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="room-id-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'design-review');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('[data-testid="room-apply"]');
  suite.deepEqual('a valid room id is committed', await events(), ['room:design-review']);

  await reset();
  await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="signaling-servers"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, 'not-a-url');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('[data-testid="signaling-apply"]');
  await page.waitForSelector('[data-testid="signaling-servers"] ~ [role="alert"]', { timeout: 5000 });
  suite.ok('malformed signaling URLs are rejected', true);

  await reset();
  await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="signaling-servers"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, 'wss://signaling.lan:4444\nws://localhost:4444');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('[data-testid="signaling-apply"]');
  await new Promise((resolve) => setTimeout(resolve, 60));
  suite.deepEqual(
    'signaling server list is committed and applied',
    await events(),
    ['signaling:wss://signaling.lan:4444|ws://localhost:4444', 'signaling-apply'],
  );

  suite.equal(
    'peer roster lists each peer',
    await page.$$eval('[data-testid^="peer-row-"]', (nodes) => nodes.length),
    3,
  );

  // ── GlobalSearchView ───────────────────────────────────────────────────────
  suite.ok('search view starts in an idle state', (await page.$('[data-testid="search-idle"]')) !== null);
  await page.type('[data-testid="global-search-input"]', 'getDB');
  await page.waitForSelector('[data-testid="search-result-index-ts-12"]', { timeout: 5000 });
  suite.equal(
    'search summary reports the match totals',
    await page.$eval('[data-testid="search-summary"]', (el) => el.textContent),
    '2 results in 2 files',
  );
  suite.ok(
    'matches are highlighted inside the line',
    (await page.$('[data-testid="search-result-index-ts-12"] mark')) !== null,
  );
  await reset();
  await page.click('[data-testid="search-result-usevfs-ts-3"]');
  suite.deepEqual('clicking a result opens it at the right line', await events(), ['open-match:usevfs-ts:3']);

  // ── LanDebugConsole ────────────────────────────────────────────────────────
  suite.equal(
    'LAN stats surface peer and transport state',
    await page.$eval('[data-testid="lan-stats"]', (el) => el.textContent?.includes('fallback')),
    true,
  );
  const logRows = await page.$$eval('[data-testid="lan-log-scroll"] li', (nodes) => nodes.length);
  suite.equal('LAN console lists every recorded event', logRows, 3);
  suite.equal(
    'LAN console reports the filtered/total ratio',
    await page.$eval('[data-testid="lan-log-count"]', (el) => el.textContent),
    '3/3',
  );

  await page.type('[data-testid="lan-log-filter"]', 'warn');
  await new Promise((resolve) => setTimeout(resolve, 80));
  suite.equal(
    'level filter narrows the LAN console',
    await page.$$eval('[data-testid="lan-log-scroll"] li', (nodes) => nodes.length),
    1,
  );

  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="lan-log-filter"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await reset();
  await page.click('[data-testid="lan-log-export"]');
  await page.click('[data-testid="lan-log-clear"]');
  suite.deepEqual('LAN console export and clear are wired', await events(), ['log-export', 'log-clear']);
  suite.equal(
    'LAN console renders an empty state after clearing',
    await page.$$eval('[data-testid="lan-log-scroll"] li', (nodes) => nodes.length),
    0,
  );
  suite.equal(
    'export is disabled with no entries',
    await page.$eval('[data-testid="lan-log-export"]', (el) => el.disabled),
    true,
  );

  // ── Responsive touch targets ──────────────────────────────────────────────
  // Measured last: toggling mobile emulation is the only step in this suite
  // that changes Chrome's input/touch emulation mid-run.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mountHarness();
  await page.click('[data-testid="explorer-restore"]');
  await page.waitForSelector('[data-node-path="/src"]', { timeout: 5000 });
  const touchTargets = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('[data-testid^="file-tree-more-"]'));
    const first = buttons[0];
    const row = first?.closest('[data-testid^="file-tree-row-"]');
    return {
      count: buttons.length,
      actionHeight: first ? Math.round(first.getBoundingClientRect().height) : 0,
      actionWidth: first ? Math.round(first.getBoundingClientRect().width) : 0,
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  suite.atLeast('file rows are present for the touch measurement', touchTargets.count, 1);
  suite.atLeast('file action trigger meets the 44px touch target', touchTargets.actionHeight, 44);
  suite.atLeast('file action trigger meets the 44px touch width', touchTargets.actionWidth, 44);
  suite.atLeast('file rows meet the 44px touch target on mobile', touchTargets.rowHeight, 44);
  suite.atMost('no horizontal page overflow at 390px', touchTargets.pageOverflow, 0);
  await captureScreenshot(page, 'phase-3-mobile-390');
  await captureScreenshot(page, 'phase-3-mobile-390');
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await mountHarness();
  await page.click('[data-testid="explorer-restore"]');
  await page.waitForSelector('[data-node-path="/src"]', { timeout: 5000 });

  await captureScreenshot(page, 'phase-3-components');
}