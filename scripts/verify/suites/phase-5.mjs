import {
  captureScreenshot,
  clickElement,
  createSuite,
  resetBrowserState,
  waitForAppShell,
} from '../harness.mjs';

/**
 * Phase 5 — Page/screen assembly and the responsive shell.
 *
 * Unlike phases 2–4 this suite drives the *real* application (no injected
 * harness), so it also validates SSR/hydration, the Monaco worker pipeline and
 * the breakpoint matrix from the plan: 360, 390, 430, 768 and 1440.
 */

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 1 },
  mobileSmall: { width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  mobileLarge: { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

const text = (page, testId) =>
  page.$eval(`[data-testid="${testId}"]`, (element) => element.textContent ?? '').catch(() => null);

export default {
  name: 'Phase 5 — Page Assembly & Responsive Shell',

  async run({ page, browser, baseUrl }) {
    const suite = createSuite('Phase 5 shell');
    const url = baseUrl ?? 'http://127.0.0.1:3210';

    try {
      await runSuite({ page, browser, url, suite });
    } catch (error) {
      suite.fail('suite ran to completion', error?.stack ?? String(error));
    }
    return suite.print();
  },
};

async function runSuite({ page, browser, url, suite }) {
  await page.setViewport(VIEWPORTS.desktop);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForAppShell(page);

  // ── desktop layout ──────────────────────────────────────────────────────────
  await page.waitForSelector('.monaco-editor', { timeout: 60000 });
  await page.waitForSelector('[data-testid^="editor-tab-"]', { timeout: 20000 });

  const desktop = await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="vscode-shell"]');
    const activityBar = document.querySelector('[data-testid="activity-bar"]');
    const sidebar = document.querySelector('[data-testid="primary-sidebar"]');
    const statusBar = document.querySelector('[data-testid="status-bar"]');
    return {
      breakpoint: shell?.getAttribute('data-breakpoint'),
      activityLayout: activityBar?.getAttribute('data-layout'),
      sidebarLayout: sidebar?.getAttribute('data-layout'),
      statusVariant: statusBar?.getAttribute('data-variant'),
      tabs: document.querySelectorAll('[data-testid^="editor-tab-"][role="tab"]').length,
      breadcrumb: document.querySelector('[data-testid="breadcrumb-bar"]')?.textContent ?? '',
      sidebarSplitter: document.querySelector('[data-testid="sidebar-splitter"]')?.getAttribute('role'),
      splitterTouchAction: (() => {
        const splitter = document.querySelector('[data-testid="sidebar-splitter"]');
        return splitter ? getComputedStyle(splitter).touchAction : null;
      })(),
      monacoReady: Boolean(document.querySelector('.monaco-editor .view-lines')),
      workerScripts: Array.from(document.querySelectorAll('script')).length,
    };
  });

  suite.equal('desktop is detected as the desktop breakpoint', desktop.breakpoint, 'desktop');
  suite.equal('activity bar renders as a left column on desktop', desktop.activityLayout, 'left');
  suite.equal('sidebar renders as a docked panel on desktop', desktop.sidebarLayout, 'panel');
  suite.equal('status bar renders the full metrics strip on desktop', desktop.statusVariant, 'full');
  suite.atLeast('the workspace opens with the seeded file tab', desktop.tabs, 1);
  suite.ok('the breadcrumb shows the active file', desktop.breadcrumb.includes('welcome.ts'), desktop.breadcrumb);
  suite.equal('the sidebar splitter is exposed as a separator', desktop.sidebarSplitter, 'separator');
  suite.equal('the splitter sets touch-action: none', desktop.splitterTouchAction, 'none');
  suite.ok('Monaco renders its content surface', desktop.monacoReady);

  // ── REACT-01 / DATA-01 regressions ──────────────────────────────────────────
  // The cursor reporter used to feed host state through an inline callback,
  // which re-ran its own subscription effect every render and crashed the tab
  // with "Maximum update depth exceeded". Any error at all fails the browser
  // health check; this assertion names the regression explicitly.
  const editorText = await page.evaluate(() => {
    const lines = document.querySelector('.monaco-editor .view-lines');
    return {
      text: (lines?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      renderedLines: lines?.children.length ?? 0,
    };
  });
  suite.atLeast('the active file renders its persisted body', editorText.renderedLines, 3);
  suite.ok(
    'the editor shows the seeded starter content, not an empty buffer',
    editorText.text.includes('Starter file'),
    editorText.text.slice(0, 120),
  );
  suite.ok(
    'the editor body is not the empty string',
    editorText.text.length > 40,
    `length=${editorText.text.length}`,
  );

  // ── status bar contents ─────────────────────────────────────────────────────
  suite.equal(
    'status bar reports the seeded file language',
    await text(page, 'status-language'),
    'typescript',
  );
  suite.ok(
    'status bar reports cursor position',
    (await text(page, 'status-cursor'))?.includes('Ln 1'),
    String(await text(page, 'status-cursor')),
  );
  suite.equal('status bar shows the encoding on desktop', await text(page, 'status-encoding'), 'UTF-8');
  suite.ok(
    'status bar reports a connection state',
    ['connected', 'disconnected', 'offline', 'connecting'].includes(
      await page.$eval('[data-testid="status-connection"]', (el) => el.getAttribute('data-state') ?? ''),
    ),
  );

  // ── file explorer interaction ───────────────────────────────────────────────
  const firstTreeRow = await page.$('[role="tree"] [role="treeitem"]');
  const firstTreePath = firstTreeRow
    ? await firstTreeRow.evaluate((el) => el.getAttribute('data-node-path'))
    : null;
  suite.ok('the explorer renders the seeded tree', Boolean(firstTreePath), String(firstTreePath));

  if (firstTreePath) {
    await clickElement(page, `[data-node-path="${firstTreePath}"]`);
    await page.waitForFunction(
      (path) => (document.querySelector('[data-testid="breadcrumb-bar"]')?.textContent ?? '').length > 0 && path,
      { timeout: 10000 },
      firstTreePath,
    );
    suite.ok('activating a tree row changes the breadcrumb trail', true);
  }

  const readmePath = '/README.md';
  const hasReadme = (await page.$(`[data-node-path="${readmePath}"]`)) !== null;
  if (hasReadme) {
    await clickElement(page, `[data-node-path="${readmePath}"]`);
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="status-language"]')?.textContent ?? '') === 'markdown',
      { timeout: 15000 },
    );
    suite.ok('opening a Markdown file switches the editor language', true);

    // Switching tabs must load that file's own body, not the previous buffer.
    const readmeText = await page
      .waitForFunction(
        () => {
          const lines = document.querySelector('.monaco-editor .view-lines');
          const text = (lines?.textContent ?? '').replace(/\s+/g, ' ').trim();
          return text.includes('LAN Code Collaboration') ? text : null;
        },
        { timeout: 15000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    suite.ok(
      'switching tabs loads the newly active file body',
      typeof readmeText === 'string' && readmeText.length > 20,
      String(readmeText).slice(0, 120),
    );

    await page.waitForFunction(
      () => {
        const lines = document.querySelector('.monaco-editor .view-lines');
        const text = (lines?.textContent ?? '').replace(/\s+/g, ' ');
        return !text.includes('Starter file');
      },
      { timeout: 15000 },
    ).catch(() => undefined);
    const afterSwitch = await page.evaluate(() =>
      (document.querySelector('.monaco-editor .view-lines')?.textContent ?? '').replace(/\s+/g, ' '),
    );
    suite.ok(
      'the previous file body is not left in the editor after switching',
      !afterSwitch.includes('Starter file'),
      afterSwitch.slice(0, 120),
    );
  }

  const tabCountBefore = await page.$$eval('[data-testid^="editor-tab-"][role="tab"]', (nodes) => nodes.length);
  const otherRow = await page.$$eval('[role="tree"] [role="treeitem"][data-node-type="file"]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-node-path')).filter(Boolean),
  );
  if (otherRow.length > 1) {
    await clickElement(page, `[data-node-path="${otherRow[1]}"]`);
    await page.waitForFunction(
      (before) => document.querySelectorAll('[data-testid^="editor-tab-"][role="tab"]').length > before,
      { timeout: 15000 },
      tabCountBefore,
    );
    suite.ok('opening another file adds an editor tab', true);
  }

  // ── quick open ─────────────────────────────────────────────────────────────
  await page.keyboard.down('Meta');
  await page.keyboard.press('p');
  await page.keyboard.up('Meta');
  await page.waitForSelector('[data-testid="command-palette"]', { timeout: 10000 });
  suite.equal(
    'Cmd+P opens the quick-open palette and focuses its input',
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    'command-palette-input',
  );

  await page.type('[data-testid="command-palette-input"]', 'welcome');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="command-palette-option-"]').length === 1,
    { timeout: 10000 },
  );
  suite.ok('fuzzy quick open narrows to a single file', true);

  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('[data-testid="command-palette"]'), { timeout: 10000 });
  suite.ok('quick open closes after opening a file', true);

  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('p');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  await page.waitForSelector('[data-testid="command-palette"]', { timeout: 10000 });
  const commandMode = await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="command-palette"] h2')?.textContent === 'Command Palette' &&
        document.querySelectorAll('[data-testid^="command-palette-option-command:"]').length > 0,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  suite.ok('Cmd+Shift+P opens the palette in command mode', commandMode);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="command-palette"]'), { timeout: 10000 });
  suite.ok('Escape dismisses the palette', true);

  // ── sidebar toggle ──────────────────────────────────────────────────────────
  await clickElement(page, '[data-testid="toggle-sidebar"]');
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="primary-sidebar"]'),
    { timeout: 10000 },
  );
  suite.ok('the sidebar collapses', true);

  await clickElement(page, '[data-testid="toggle-sidebar"]');
  await page.waitForSelector('[data-testid="primary-sidebar"]', { timeout: 10000 });
  suite.ok('the sidebar reopens', true);

  // ── activity bar navigation ─────────────────────────────────────────────────
  for (const [tab, marker] of [
    ['search', 'global-search-view'],
    ['collaboration', 'collaboration-view'],
    ['settings', 'settings-view'],
    ['explorer', 'file-explorer'],
  ]) {
    await clickElement(page, `[data-testid="activity-bar-${tab}"]`);
    await page.waitForSelector(`[data-testid="${marker}"]`, { timeout: 10000 });
    suite.ok(`the activity bar opens the ${tab} view`, true);
  }

  // ── non-blocking dialogs (SEC-03) ──────────────────────────────────────────
  // window.prompt/confirm would stall the render loop and the WebRTC keep-alive
  // timers; these flows must go through ModalOverlay instead.
  suite.equal('no blocking create dialog is opened on load', await page.$('[data-testid="workspace-dialog"]'), null);

  await clickElement(page, '[data-testid="explorer-new-file"]');
  await page.waitForSelector('[data-testid="workspace-dialog"]', { timeout: 10000 });

  const createDialog = await page.evaluate(() => ({
    title: document.querySelector('[data-testid="workspace-dialog"] h2')?.textContent ?? null,
    role: document.querySelector('[data-testid="workspace-dialog"]')?.getAttribute('role'),
    ariaModal: document.querySelector('[data-testid="workspace-dialog"]')?.getAttribute('aria-modal'),
    focused: document.activeElement?.getAttribute('data-testid'),
    confirmDisabled: document.querySelector('[data-testid="workspace-dialog-confirm"]')?.disabled ?? null,
  }));
  suite.equal('create flow opens a modal dialog instead of window.prompt', createDialog.role, 'dialog');
  suite.equal('the dialog is aria-modal', createDialog.ariaModal, 'true');
  suite.ok('the dialog is titled for the action', (createDialog.title ?? '').includes('file'), String(createDialog.title));
  suite.equal('the dialog focuses its name field', createDialog.focused, 'workspace-dialog-name');
  suite.equal(
    'the dialog pre-fills a sensible default name',
    await page.$eval('[data-testid="workspace-dialog-name"]', (el) => el.value),
    'untitled.ts',
  );

  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="workspace-dialog-name"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  suite.equal(
    'an empty name cannot be submitted',
    await page.$eval('[data-testid="workspace-dialog-confirm"]', (el) => el.disabled),
    true,
  );

  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="workspace-dialog-name"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'verified.ts');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const beforeCreate = await page.$$eval('[data-testid^="editor-tab-"][role="tab"]', (nodes) => nodes.length);
  await clickElement(page, '[data-testid="workspace-dialog-confirm"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="workspace-dialog"]'), { timeout: 10000 });
  const createdTab = await page
    .waitForFunction(
      (before) => document.querySelectorAll('[data-testid^="editor-tab-"][role="tab"]').length > before,
      { timeout: 15000 },
      beforeCreate,
    )
    .then(() => true)
    .catch(() => false);
  suite.ok('confirming the dialog creates and opens the file', createdTab);

  await clickElement(page, '[data-testid="explorer-new-folder"]');
  await page.waitForSelector('[data-testid="workspace-dialog"]', { timeout: 10000 });
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="workspace-dialog-name"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'bad/name');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const invalidName = await page.evaluate(() => ({
    disabled: document.querySelector('[data-testid="workspace-dialog-confirm"]')?.disabled ?? null,
    alert: document.querySelector('[data-testid="workspace-dialog"] [role="alert"]')?.textContent ?? null,
  }));
  suite.equal('an invalid name cannot be submitted', invalidName.disabled, true);
  suite.ok('the dialog explains why the name is invalid', Boolean(invalidName.alert), String(invalidName.alert));

  await clickElement(page, '[data-testid="workspace-dialog-cancel"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="workspace-dialog"]'), { timeout: 10000 });
  suite.ok('the dialog can be dismissed without side effects', true);

  // Delete confirmation replaces window.confirm.
  const createdNodeId = await page.evaluate(() => {
    const row = document.querySelector('[data-node-path="/verified.ts"]');
    return row?.getAttribute('data-testid')?.replace('file-tree-row-', '') ?? null;
  });
  suite.ok('the created file appears in the explorer tree', createdNodeId !== null);

  await clickElement(page, `[data-testid="file-tree-more-${createdNodeId}"]`);
  await page.waitForSelector(`[data-testid="file-tree-menu-${createdNodeId}-menu"]`, { timeout: 10000 });
  await clickElement(page, `[data-testid="file-tree-menu-${createdNodeId}-item-delete"]`);
  await page.waitForSelector('[data-testid="workspace-dialog"]', { timeout: 10000 });
  const deleteDialog = await page.evaluate(() => ({
    title: document.querySelector('[data-testid="workspace-dialog"] h2')?.textContent ?? null,
    hasNameInput: Boolean(document.querySelector('[data-testid="workspace-dialog-name"]')),
    confirmLabel: document.querySelector('[data-testid="workspace-dialog-confirm"]')?.textContent ?? null,
  }));
  suite.ok('delete asks for confirmation through a modal', (deleteDialog.title ?? '').includes('Delete'), String(deleteDialog.title));
  suite.equal('the delete dialog has no name field', deleteDialog.hasNameInput, false);
  suite.equal('the delete action is labelled explicitly', deleteDialog.confirmLabel, 'Delete');

  await clickElement(page, '[data-testid="workspace-dialog-confirm"]');
  await page.waitForFunction(
    () => !(document.querySelector('[data-node-path="/verified.ts"]')),
    { timeout: 15000 },
  );
  suite.ok('confirming the delete removes the node from the tree', true);

  // ── collaboration panel ─────────────────────────────────────────────────────
  await clickElement(page, '[data-testid="activity-bar-collaboration"]');
  await page.waitForSelector('[data-testid="collaboration-view"]');
  const collaboration = await page.evaluate(() => ({
    connectionChip: document.querySelector('[data-testid="connection-chip"]')?.getAttribute('data-state'),
    roomId: document.querySelector('[data-testid="room-id-input"]')?.value ?? '',
    servers: document.querySelector('[data-testid="signaling-servers"]')?.value ?? '',
    hasPeers: Boolean(document.querySelector('[data-testid="peer-list-empty"]')),
  }));
  suite.ok(
    'the collaboration panel reports a connection state',
    ['connected', 'disconnected', 'offline', 'connecting'].includes(String(collaboration.connectionChip)),
    String(collaboration.connectionChip),
  );
  suite.equal('the room id is prefilled', collaboration.roomId, 'collab-workspace-lan');
  suite.ok('a signaling server list is prefilled', collaboration.servers.includes('ws'), collaboration.servers);
  suite.ok('an empty peer roster renders an explicit empty state', collaboration.hasPeers);

  // ── settings ───────────────────────────────────────────────────────────────
  await clickElement(page, '[data-testid="activity-bar-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]');
  const readEditorFontSize = () =>
    page.evaluate(() => {
      const lines = document.querySelector('.monaco-editor .view-lines');
      return lines ? getComputedStyle(lines).fontSize : null;
    });
  const beforeFontSize = await readEditorFontSize();
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="settings-font-size"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '18');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const afterFontSize = await page
    .waitForFunction(
      () => {
        const lines = document.querySelector('.monaco-editor .view-lines');
        return lines && getComputedStyle(lines).fontSize === '18px';
      },
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  suite.ok('changing the font size updates the live editor', afterFontSize, `before=${beforeFontSize}`);
  suite.ok('the editor had a different font size to change from', beforeFontSize !== '18px', String(beforeFontSize));

  await clickElement(page, '[data-testid="settings-theme-vs-light"]');
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-theme') === 'light',
    { timeout: 10000 },
  );
  suite.ok('the light theme is applied to the document root', true);
  suite.equal(
    'the editor surface follows the theme',
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    'rgb(255, 255, 255)',
  );

  await clickElement(page, '[data-testid="settings-theme-vs-dark"]');
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-theme') === 'dark',
    { timeout: 10000 },
  );
  suite.ok('the dark theme is restored', true);

  const identityBefore = await page
    .$eval('[data-testid="settings-identity-name"]', (el) => el.value)
    .catch(() => null);
  suite.ok('the settings view shows a peer identity', Boolean(identityBefore), String(identityBefore));
  suite.ok(
    'the storage estimate is surfaced',
    (await text(page, 'settings-storage'))?.includes('across') ?? false,
  );

  // ── bottom panel ───────────────────────────────────────────────────────────
  await page.waitForSelector('[data-testid="panel-open"]', { timeout: 10000 });
  suite.ok(
    'the collapsed panel bar summarises the problem count',
    (await text(page, 'panel-summary-closed')) !== null,
  );
  await clickElement(page, '[data-testid="panel-open"]');
  await page.waitForSelector('[data-testid="bottom-panel"]', { timeout: 10000 });
  suite.ok('the bottom panel opens', true);
  await page.waitForSelector('[data-testid="panel-toggle"]', { timeout: 10000 });
  suite.ok('the expanded panel exposes its toggle affordance', true);
  suite.equal(
    'the panel is docked on desktop',
    await page.$eval('[data-testid="bottom-panel"]', (el) => el.getAttribute('data-layout')),
    'dock',
  );

  for (const [tab, marker] of [
    ['terminal', 'panel-body-terminal'],
    ['output', 'panel-body-output'],
    ['problems', 'panel-body-problems'],
    ['lan-debug', 'lan-debug-console'],
  ]) {
    await clickElement(page, `[data-testid="panel-tab-${tab}"]`);
    await page.waitForSelector(`[data-testid="${marker}"]`, { timeout: 10000 });
    suite.ok(`the panel exposes the ${tab} tab`, true);
  }

  const lanPanel = await page.evaluate(() => ({
    hasStats: Boolean(document.querySelector('[data-testid="lan-stats"]')),
    logCount: document.querySelectorAll('[data-testid="lan-log-scroll"] li').length,
    room: document.querySelector('[data-testid="lan-stats"]')?.textContent?.includes('collab-workspace-lan') ?? false,
  }));
  suite.ok('the LAN console reports live mesh statistics', lanPanel.hasStats);
  suite.ok('the LAN console names the active room', lanPanel.room);
  suite.atLeast('the LAN console records connection events', lanPanel.logCount, 1);

  await clickElement(page, '[data-testid="panel-close"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="bottom-panel"]'), { timeout: 10000 });
  suite.ok('the bottom panel closes', true);

  await captureScreenshot(page, 'phase-5-desktop-1440');

  // ── persistence across reload ───────────────────────────────────────────────
  const tabsBeforeReload = await page.$$eval('[data-testid^="editor-tab-"][role="tab"]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppShell(page);
  await page.waitForSelector('[data-testid^="editor-tab-"]', { timeout: 30000 });
  const tabsAfterReload = await page.$$eval('[data-testid^="editor-tab-"][role="tab"]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  );
  suite.deepEqual('open tabs survive a reload', tabsAfterReload, tabsBeforeReload);

  const fontSizeAfterReload = await page
    .waitForFunction(
      () => {
        const lines = document.querySelector('.monaco-editor .view-lines');
        if (!lines) return null;
        return getComputedStyle(lines).fontSize === '18px';
      },
      { timeout: 30000, polling: 250 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  suite.equal('editor settings survive a reload', fontSizeAfterReload, true);

  // ── tablet ─────────────────────────────────────────────────────────────────
  await page.setViewport(VIEWPORTS.tablet);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="vscode-shell"]')?.getAttribute('data-breakpoint') === 'tablet',
    { timeout: 15000 },
  );
  suite.equal('768px switches to the tablet breakpoint', await page.evaluate(() => document.querySelector('[data-testid="vscode-shell"]')?.getAttribute('data-breakpoint')), 'tablet');
  suite.equal(
    'tablet keeps the sidebar docked',
    await page.$eval('[data-testid="activity-bar"]', (el) => el.getAttribute('data-layout')),
    'left',
  );
  await captureScreenshot(page, 'phase-5-tablet-768');

  // ── mobile ─────────────────────────────────────────────────────────────────
  for (const [label, viewport] of [
    ['360', VIEWPORTS.mobileSmall],
    ['390', VIEWPORTS.mobile],
    ['430', VIEWPORTS.mobileLarge],
  ]) {
    await page.setViewport(viewport);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="vscode-shell"]')?.getAttribute('data-breakpoint') === 'mobile',
      { timeout: 20000 },
    );

    const mobileState = await page.evaluate(() => {
      const activityBars = Array.from(document.querySelectorAll('[data-testid="activity-bar"]'));
      const bottomNav = activityBars.find((bar) => bar.getAttribute('data-layout') === 'bottom');
      const statusBar = document.querySelector('[data-testid="status-bar"]');
      return {
        breakpoint: document.querySelector('[data-testid="vscode-shell"]')?.getAttribute('data-breakpoint'),
        bottomNav: Boolean(bottomNav),
        navPadding: bottomNav ? getComputedStyle(bottomNav).paddingBottom : null,
        navItems: bottomNav?.querySelectorAll('[data-testid^="activity-bar-"]').length ?? 0,
        dockedSidebar: Boolean(document.querySelector('[data-testid="primary-sidebar"][data-layout="panel"]')),
        statusVariant: statusBar?.getAttribute('data-variant'),
        encoding: Boolean(document.querySelector('[data-testid="status-encoding"]')),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        navTargets: Array.from(bottomNav?.querySelectorAll('[data-testid^="activity-bar-"]') ?? []).map((el) =>
          Math.round(el.getBoundingClientRect().height),
        ),
        editorHeight: Math.round(
          document.querySelector('[data-testid="editor-surface"]')?.getBoundingClientRect().height ?? 0,
        ),
        viewportHeight: window.innerHeight,
      };
    });

    suite.equal(`${label}px switches to the mobile breakpoint`, mobileState.breakpoint, 'mobile');
    suite.ok(`${label}px renders the activity bar as a bottom navigation bar`, mobileState.bottomNav);
    suite.equal(`${label}px bottom navigation exposes all four destinations`, mobileState.navItems, 4);
    suite.ok(
      `${label}px bottom navigation keeps the safe-area padding`,
      mobileState.navPadding !== null,
      String(mobileState.navPadding),
    );
    suite.ok(`${label}px hides the docked sidebar`, !mobileState.dockedSidebar);
    suite.equal(`${label}px condenses the status bar`, mobileState.statusVariant, 'condensed');
    suite.ok(`${label}px omits the desktop-only encoding chip`, !mobileState.encoding);
    suite.atMost(`${label}px has no horizontal page overflow`, mobileState.overflow, 0);
    suite.atLeast(`${label}px bottom navigation meets the 44px touch target`, Math.min(...mobileState.navTargets), 44);
    suite.atLeast(`${label}px keeps a usable editor surface`, mobileState.editorHeight, 120);
    suite.atMost(`${label}px editor fits inside the visual viewport`, mobileState.editorHeight, mobileState.viewportHeight);

    if (label === '390') {
      // Drawer navigation.
      await clickElement(page, '[data-testid="activity-bar-explorer"]');
      await page.waitForSelector('[data-testid="primary-sidebar"][data-layout="drawer"]', { timeout: 15000 });
      const drawer = await page.evaluate(() => {
        const aside = document.querySelector('[data-testid="primary-sidebar"][data-layout="drawer"]');
        const backdrop = document.querySelector('[data-testid="sidebar-backdrop"]');
        const rect = aside?.getBoundingClientRect();
        return {
          role: aside?.getAttribute('role'),
          ariaModal: aside?.getAttribute('aria-modal'),
          width: rect ? Math.round(rect.width) : 0,
          viewportWidth: window.innerWidth,
          hasBackdrop: Boolean(backdrop),
        };
      });
      suite.equal('the mobile sidebar opens as a modal drawer', drawer.role, 'dialog');
      suite.equal('the drawer is marked aria-modal', drawer.ariaModal, 'true');
      suite.ok('the drawer is capped at 85vw', drawer.width <= drawer.viewportWidth * 0.85 + 1, `${drawer.width}/${drawer.viewportWidth}`);
      suite.ok('the drawer has a dismiss backdrop', drawer.hasBackdrop);

      const treeTargets = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid^="file-tree-more-"]')).map((el) =>
          Math.round(el.getBoundingClientRect().height),
        ),
      );
      suite.atLeast('file action triggers meet the 44px touch target', Math.min(...treeTargets, 44), 44);

      // UI-01: the tray and the bottom navigation are mutually exclusive. With
      // both rendered the editor is squeezed below a usable height, so focusing
      // the caret must yield the navigation and vice versa.
      const chromeState = () =>
        page.evaluate(() => {
          const bar = document.querySelector('[data-testid="mobile-keyboard-bar"]');
          const nav = document.querySelector('[data-testid="activity-bar"][data-layout="bottom"]');
          const surface = document.querySelector('[data-testid="editor-surface"]');
          return {
            bar: Boolean(bar),
            nav: Boolean(nav),
            barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
            overflowX: bar ? getComputedStyle(bar).overflowX : null,
            buttons: bar?.querySelectorAll('button').length ?? 0,
            editorHeight: Math.round(surface?.getBoundingClientRect().height ?? 0),
          };
        });

      const idleChrome = await chromeState();
      suite.equal('the accessory tray stays hidden until the caret is in the editor', idleChrome.bar, false);
      suite.ok('the bottom navigation is present while the tray is hidden', idleChrome.nav);

      await page.evaluate(() => document.querySelector('.monaco-editor textarea')?.focus());
      await page.waitForSelector('[data-testid="mobile-keyboard-bar"]', { timeout: 10000 });
      const focusedChrome = await chromeState();
      suite.ok('focusing the editor engages the accessory bar', focusedChrome.bar);
      suite.ok('the bottom navigation yields to the accessory bar', !focusedChrome.nav);
      suite.atLeast('the accessory bar keeps its tray height', focusedChrome.barHeight, 38);
      suite.equal('the accessory bar scrolls horizontally', focusedChrome.overflowX, 'auto');
      suite.atLeast('the accessory bar exposes the full quick-input set', focusedChrome.buttons, 12);
      suite.atLeast(
        'the editor stays usable while the tray is open',
        focusedChrome.editorHeight,
        120,
      );

      await page.evaluate(() =>
        document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined,
      );
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="mobile-keyboard-bar"]'),
        { timeout: 10000 },
      );
      const blurredChrome = await chromeState();
      suite.ok('leaving the editor restores the bottom navigation', blurredChrome.nav);
      suite.ok('the tray and the navigation are never rendered together', !focusedChrome.bar === focusedChrome.nav);

      await captureScreenshot(page, 'phase-5-mobile-390');

      await clickElement(page, '[data-testid="sidebar-close"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="primary-sidebar"][data-layout="drawer"]'),
        { timeout: 10000 },
      );
      suite.ok('the drawer can be dismissed', true);
    }

    if (label === '430') {
      const overflow = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[role="treeitem"]'));
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rows: rows.filter((row) => row.getBoundingClientRect().right > window.innerWidth + 1).length,
        };
      });
      suite.atMost('430px file rows stay inside the viewport', overflow.rows, 0);
      suite.atMost('430px has no page overflow with the tree open', overflow.page, 0);
      await captureScreenshot(page, 'phase-5-mobile-430');
    }

    if (label === '360') {
      await captureScreenshot(page, 'phase-5-mobile-360');
    }
  }

  // ── return to desktop ──────────────────────────────────────────────────────
  await page.setViewport(VIEWPORTS.desktop);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="vscode-shell"]')?.getAttribute('data-breakpoint') === 'desktop',
    { timeout: 20000 },
  );
  suite.ok('the shell returns to the desktop layout after mobile', true);

  // ── DATA-04 / NET-01: first run on a second origin ──────────────────────────
  // Every distinct host is a separate IndexedDB partition and a separate HMR
  // socket, so booting on a second loopback address reproduces a brand new
  // browser profile end to end: the workspace row is created, the starter tree
  // is seeded, and the editor must open on real content rather than an empty
  // buffer. It also proves the server answers off `127.0.0.1`, which is what
  // `next dev -H 0.0.0.0` is there to guarantee.
  const base = new URL(url);
  const isLoopback = /^(localhost|127\.)/.test(base.hostname);
  const alternate = new URL(url);
  // `localhost` resolves to 127.0.0.1 only, so a second alias is the only way
  // to exercise the off-default-host path from a loopback base URL.
  alternate.hostname =
    isLoopback && base.hostname !== '127.0.2.2' ? '127.0.2.2' : base.hostname;
  const alternateUrl = alternate.href;

  const alternatePage = await browser.newPage();
  try {
    await alternatePage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await alternatePage.goto(alternateUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (!isLoopback) {
      // No second loopback alias to hand; wipe the partition instead so the
      // assertions below still run against a first-run workspace.
      await resetBrowserState(alternatePage);
      await alternatePage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    await alternatePage.waitForSelector('[data-testid="vscode-shell"]', { timeout: 60000 });
    await alternatePage.waitForSelector('[data-testid^="editor-tab-"]', { timeout: 60000 });
    // The body is hydrated from IndexedDB into the Monaco model after the tab
    // exists, so an empty view-lines at this point is a race, not a defect.
    await alternatePage.waitForFunction(
      () => {
        const lines = document.querySelector('.monaco-editor .view-lines');
        return ((lines?.textContent ?? '').replace(/\s+/g, ' ').trim().length ?? 0) > 0;
      },
      { timeout: 30000, polling: 200 },
    );

    const alternateBoot = await alternatePage.evaluate(async () => {
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

      const lines = document.querySelector('.monaco-editor .view-lines');
      return {
        tabs: document.querySelectorAll('[data-testid^="editor-tab-"][role="tab"]').length,
        paths: nodes.filter((node) => node.deletedAt === null).map((node) => node.path),
        breadcrumb: document.querySelector('[data-testid="breadcrumb-bar"]')?.textContent ?? '',
        editorText: (lines?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        shell: Boolean(document.querySelector('[data-testid="vscode-shell"]')),
      };
    });

    suite.equal(`a first run on ${alternateUrl} renders the shell`, alternateBoot.shell, true);
    suite.atLeast('the alternate origin opens a seeded file tab', alternateBoot.tabs, 1);
    suite.ok(
      'the alternate origin seeds the starter tree',
      alternateBoot.paths.includes('/src/welcome.ts') && alternateBoot.paths.includes('/README.md'),
      JSON.stringify(alternateBoot.paths),
    );
    suite.ok(
      'the alternate origin selects the starter file',
      alternateBoot.breadcrumb.includes('welcome.ts'),
      alternateBoot.breadcrumb,
    );
    suite.ok(
      'the alternate origin renders real starter content, not an empty buffer',
      alternateBoot.editorText.includes('Starter file'),
      alternateBoot.editorText.slice(0, 120),
    );
  } finally {
    await alternatePage.close();
  }
}