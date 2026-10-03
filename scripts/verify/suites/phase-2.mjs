import { join } from 'node:path';
import { build } from 'esbuild';
import {
  PROJECT_ROOT,
  captureScreenshot,
  createSuite,
} from '../harness.mjs';

/**
 * Phase 2 — Design foundation and atomic UI primitives.
 *
 * The real components are bundled with esbuild, mounted into the page with
 * `react-dom/client`, and then driven with genuine Chrome input events.
 */
export default {
  name: 'Phase 2 — Design Foundation & Atomic UI Primitives',

  async run({ page, baseUrl }) {
    const suite = createSuite('Phase 2 primitives');
    const url = baseUrl ?? 'http://127.0.0.1:3210';

    try {
      await runSuite({ page, url, suite });
    } finally {
      // Always print, even when an assertion helper throws mid-suite.
      return suite.print();
    }
  },
};

async function runSuite({ page, url, suite }) {
  {

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const bundle = await build({
      entryPoints: [join(PROJECT_ROOT, 'scripts/verify/entries/phase-2.tsx')],
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

    // A container must exist before the bundle mounts into it.
    await page.evaluate(() => {
      const container = document.createElement('div');
      container.id = 'phase2-container';
      document.body.appendChild(container);
    });
    await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? '' });
    await page.evaluate(() => window.__phase2Mount?.());

    await page.waitForSelector('[data-testid="phase2-root"]', { timeout: 15000 });
    suite.ok('phase 2 harness mounts', true);

    const state = () => page.evaluate(() => window.__phase2.getState());

    // ── design tokens ─────────────────────────────────────────────────────────
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const read = (name) => style.getPropertyValue(name).trim();
      return {
        bg: read('--vscode-bg'),
        accent: read('--vscode-accent'),
        statusbar: read('--vscode-statusbar-bg'),
        activitybar: read('--activitybar-width'),
        statusbarHeight: read('--statusbar-height'),
        vh: read('--vh'),
        keyboardHeight: read('--keyboard-height'),
        bodyOverflow: getComputedStyle(document.body).overflow,
        bodyHeight: Math.round(document.body.getBoundingClientRect().height),
        innerHeight: window.innerHeight,
      };
    });
    suite.equal('VS Code background token is applied', tokens.bg, '#1e1e1e');
    suite.equal('VS Code accent token is applied', tokens.accent, '#007acc');
    suite.equal('status bar token is applied', tokens.statusbar, '#007acc');
    suite.equal('activity bar width token is applied', tokens.activitybar, '48px');
    suite.equal('status bar height token is applied', tokens.statusbarHeight, '24px');
    suite.equal('body hides overflow for the IDE shell', tokens.bodyOverflow, 'hidden');
    suite.atLeast('body height tracks the window height', tokens.bodyHeight, tokens.innerHeight - 1);
    suite.ok('dynamic viewport height token is initialised', tokens.vh.endsWith('vh') || tokens.vh.endsWith('px'));

    const chromeSelection = await page.evaluate(() => {
      const chrome = document.querySelector('[data-testid="phase2-root"]');
      return chrome ? getComputedStyle(chrome).userSelect : null;
    });
    suite.ok('vscode-chrome scope resolves to user-select: none', chromeSelection === 'none', String(chromeSelection));

    // ── ActionButton ──────────────────────────────────────────────────────────
    await page.click('[data-testid="btn-primary"]');
    await page.click('[data-testid="btn-primary"]');
    suite.equal('ActionButton fires onClick', (await state()).clicks, 2);

    const disabledState = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="btn-disabled"]');
      const loading = document.querySelector('[data-testid="btn-loading"]');
      const block = document.querySelector('[data-testid="btn-large"]');
      return {
        disabled: button?.disabled ?? null,
        loadingBusy: loading?.getAttribute('aria-busy'),
        loadingDisabled: loading?.disabled ?? null,
        loadingSpinner: loading?.querySelector('.animate-spin') !== null,
        blockWidth: Math.round(block?.getBoundingClientRect().width ?? 0),
        containerWidth: Math.round(
          document.querySelector('[data-testid="btn-large"]')?.parentElement?.getBoundingClientRect().width ?? 0,
        ),
        ghostLabel: document.querySelector('[data-testid="btn-ghost"]')?.getAttribute('aria-label'),
      };
    });
    suite.equal('disabled ActionButton sets the disabled attribute', disabledState.disabled, true);
    suite.equal('loading ActionButton exposes aria-busy', disabledState.loadingBusy, 'true');
    suite.equal('loading ActionButton is not interactive', disabledState.loadingDisabled, true);
    suite.ok('loading ActionButton renders a spinner', disabledState.loadingSpinner);
    suite.atLeast('block ActionButton fills its container', disabledState.blockWidth, disabledState.containerWidth - 1);
    suite.equal('icon-only ActionButton keeps an accessible name', disabledState.ghostLabel, 'Ghost icon only');

    // ── TextInput ─────────────────────────────────────────────────────────────
    await page.click('[data-testid="text-input"]');
    await page.type('[data-testid="text-input"]', 'useVFS.ts');
    suite.equal('TextInput propagates keystrokes to onChange', (await state()).value, 'useVFS.ts');

    await page.keyboard.press('Enter');
    suite.equal('TextInput fires onEnter', (await state()).enters, 1);

    await page.keyboard.press('Escape');
    suite.equal('TextInput fires onEscape', (await state()).escapes, 1);

    const inputAccessibility = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="text-input"]');
      const invalid = document.querySelector('[data-testid="text-input-invalid"]');
      const alert = document.querySelector('[data-testid="text-input-invalid"] + p, [role="alert"]');
      return {
        value: input?.value ?? null,
        hasClear: Boolean(input?.parentElement?.querySelector('button[aria-label^="Clear"]')),
        invalidAria: invalid?.getAttribute('aria-invalid'),
        invalidDescribed: invalid?.getAttribute('aria-describedby'),
        alertText: alert?.textContent ?? null,
        alertRole: alert?.getAttribute('role') ?? null,
      };
    });
    suite.equal('TextInput renders the typed value', inputAccessibility.value, 'useVFS.ts');
    suite.ok('clearable TextInput exposes a clear button', inputAccessibility.hasClear);
    suite.equal('error tone sets aria-invalid', inputAccessibility.invalidAria, 'true');
    suite.ok('error message is wired through aria-describedby', Boolean(inputAccessibility.invalidDescribed));
    suite.equal('error message renders as an alert', inputAccessibility.alertRole, 'alert');
    suite.ok(
      'error message text is exposed to assistive tech',
      (inputAccessibility.alertText ?? '').includes('already required'),
      String(inputAccessibility.alertText),
    );

    await page.click('button[aria-label="Clear Rename to"]');
    suite.equal('clear button empties the field', (await state()).value, '');

    // ── DropdownMenu ──────────────────────────────────────────────────────────
    suite.equal('DropdownMenu starts closed', await page.$('[data-testid="menu-menu"]'), null);

    await page.click('[data-testid="menu"]');
    await page.waitForSelector('[data-testid="menu-menu"]', { timeout: 5000 });
    suite.ok('DropdownMenu opens on explicit tap', true);

    const menuSemantics = await page.evaluate(() => {
      const menu = document.querySelector('[data-testid="menu-menu"]');
      const trigger = document.querySelector('[data-testid="menu"]');
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      return {
        role: menu?.getAttribute('role'),
        parentIsBody: menu?.parentElement === document.body,
        hasPopup: trigger?.getAttribute('aria-haspopup'),
        expanded: trigger?.getAttribute('aria-expanded'),
        itemCount: items.length,
        disabledItem: items.find((item) => item.textContent?.includes('Unavailable'))?.disabled ?? null,
        hasSeparator: document.querySelectorAll('[role="separator"]').length,
      };
    });
    suite.equal('menu exposes the menu role', menuSemantics.role, 'menu');
    suite.ok('menu is portalled to the document body', menuSemantics.parentIsBody);
    suite.equal('trigger advertises aria-haspopup', menuSemantics.hasPopup, 'menu');
    suite.equal('trigger advertises expanded state', menuSemantics.expanded, 'true');
    suite.equal('menu renders every configured item', menuSemantics.itemCount, 3);
    suite.equal('disabled item is not actionable', menuSemantics.disabledItem, true);
    suite.atLeast('separator is rendered between groups', menuSemantics.hasSeparator, 1);

    await page.click('[data-testid="menu-item-rename"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="menu-menu"]'), { timeout: 5000 });
    suite.deepEqual('menu item action runs and closes the menu', (await state()).menuActions, ['rename']);

    await page.click('[data-testid="menu"]');
    await page.waitForSelector('[data-testid="menu-menu"]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="menu-menu"]'), { timeout: 5000 });
    suite.ok('Escape dismisses the open menu', true);

    await page.click('[data-testid="menu"]');
    await page.waitForSelector('[data-testid="menu-menu"]');
    await page.mouse.click(10, 10);
    await page.waitForFunction(() => !document.querySelector('[data-testid="menu-menu"]'), { timeout: 5000 });
    suite.ok('outside pointer press dismisses the menu', true);

    // ── Tooltip ───────────────────────────────────────────────────────────────
    suite.equal('tooltip is hidden before interaction', await page.$('[data-testid="tooltip"]'), null);

    await page.hover('[data-testid="tooltip-anchor"]');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const tooltipText = await page.evaluate(
      () => document.querySelector('[data-testid="tooltip"]')?.textContent ?? null,
    );
    suite.equal('hover reveals the tooltip after the delay', tooltipText, 'Format Document');

    const tooltipLink = await page.evaluate(() => {
      const anchor = document.querySelector('[data-testid="tooltip-anchor"]');
      const tooltip = document.querySelector('[data-testid="tooltip"]');
      return {
        role: tooltip?.getAttribute('role'),
        describedBy: anchor?.getAttribute('aria-describedby'),
        tooltipId: tooltip?.id ?? null,
        pointerEvents: tooltip ? getComputedStyle(tooltip).pointerEvents : null,
        portalled: tooltip?.parentElement === document.body,
      };
    });
    suite.equal('tooltip exposes the tooltip role', tooltipLink.role, 'tooltip');
    suite.ok('anchor is linked to the tooltip via aria-describedby', Boolean(tooltipLink.describedBy));
    suite.equal('anchor points at the rendered tooltip id', tooltipLink.describedBy, tooltipLink.tooltipId);
    suite.equal('tooltip never intercepts pointer events', tooltipLink.pointerEvents, 'none');
    suite.ok('tooltip is portalled out of the layout', tooltipLink.portalled);

    await page.keyboard.press('Escape');
    await new Promise((resolve) => setTimeout(resolve, 60));
    suite.equal('Escape dismisses the tooltip', await page.$('[data-testid="tooltip"]'), null);

    await page.mouse.move(5, 5);
    await page.evaluate(() => {
      const anchor = document.querySelector('[data-testid="tooltip-anchor"]');
      if (!anchor) return;
      anchor.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const touchTooltip = await page.evaluate(
      () => document.querySelector('[data-testid="tooltip"]')?.textContent ?? null,
    );
    suite.equal('press-and-hold reveals the tooltip on touch', touchTooltip, 'Format Document');

    await page.evaluate(() => {
      const anchor = document.querySelector('[data-testid="tooltip-anchor"]');
      anchor?.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    suite.equal('releasing the touch press dismisses the tooltip', await page.$('[data-testid="tooltip"]'), null);

    // ── ResizableSplitter ─────────────────────────────────────────────────────
    const splitterGeometry = await page.evaluate(() => {
      const splitter = document.querySelector('[data-testid="splitter"]');
      const style = splitter ? getComputedStyle(splitter) : null;
      return {
        role: splitter?.getAttribute('role'),
        orientation: splitter?.getAttribute('aria-orientation'),
        now: splitter?.getAttribute('aria-valuenow'),
        min: splitter?.getAttribute('aria-valuemin'),
        max: splitter?.getAttribute('aria-valuemax'),
        touchAction: style?.touchAction ?? null,
        cursor: style?.cursor ?? null,
      };
    });
    suite.equal('splitter exposes the separator role', splitterGeometry.role, 'separator');
    suite.equal('splitter reports a vertical orientation', splitterGeometry.orientation, 'vertical');
    suite.equal('splitter reports its current size', splitterGeometry.now, '240');
    suite.equal('splitter reports its minimum size', splitterGeometry.min, '200');
    suite.equal('splitter reports its maximum size', splitterGeometry.max, '400');
    suite.equal('splitter sets touch-action: none', splitterGeometry.touchAction, 'none');
    suite.equal('splitter uses a column-resize cursor', splitterGeometry.cursor, 'col-resize');

    await page.focus('[data-testid="splitter"]');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    suite.equal('keyboard resizes the pane', (await state()).splitterSize, 280);

    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('ArrowLeft');
    }
    suite.equal('resize is clamped to the minimum', (await state()).splitterSize, 200);

    await page.keyboard.press('End');
    suite.equal('End resizes to the maximum', (await state()).splitterSize, 400);

    await page.keyboard.press('Home');
    suite.equal('Home resizes to the minimum', (await state()).splitterSize, 200);
    suite.equal('every keyboard resize commits exactly once', (await state()).splitterCommits, 16);

    // Pointer drag: press on the rail, move 60px right, release.
    const splitterBox = await page.evaluate(() => {
      const rect = document.querySelector('[data-testid="splitter"]').getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(splitterBox.x + splitterBox.width / 2 + 60, splitterBox.y + splitterBox.height / 2, {
      steps: 6,
    });
    await page.mouse.up();
    const draggedSize = (await state()).splitterSize;
    suite.atLeast('pointer drag grows the pane', draggedSize, 250);

    // ── ModalOverlay ──────────────────────────────────────────────────────────
    suite.equal('modal is closed initially', await page.$('[data-testid="modal"]'), null);

    await page.click('[data-testid="modal-open"]');
    await page.waitForSelector('[data-testid="modal"]', { timeout: 5000 });

    const modalState = await state();
    suite.ok('modal opens', modalState.modalOpen);
    suite.equal('modal is a dialog', await page.evaluate(() => document.querySelector('[data-testid="modal"]')?.getAttribute('role')), 'dialog');
    suite.equal('modal is aria-modal', await page.evaluate(() => document.querySelector('[data-testid="modal"]')?.getAttribute('aria-modal')), 'true');
    suite.equal('modal locks body scroll', modalState.bodyOverflow, 'hidden');
    suite.equal('modal moves focus to the initial ref', modalState.activeTestId, 'modal-input');

    const labelledBy = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="modal"]');
      const id = dialog?.getAttribute('aria-labelledby');
      return {
        hasLabelledBy: Boolean(id),
        titleText: id ? document.getElementById(id)?.textContent ?? null : null,
        hasDescribed: Boolean(dialog?.getAttribute('aria-describedby')),
      };
    });
    suite.ok('modal is labelled by its title', labelledBy.hasLabelledBy);
    suite.equal('modal title text is exposed', labelledBy.titleText, 'Rename file');
    suite.ok('modal is described by its description', labelledBy.hasDescribed);

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="modal"]'), { timeout: 5000 });
    suite.ok('Escape closes the modal', true);
    suite.equal('focus returns to the opener', (await state()).activeTestId, 'modal-open');
    suite.equal('body scroll lock is released', (await state()).bodyOverflow, '');

    // The dialog is centred, so the backdrop is only exposed at the viewport
    // edge — click there to prove the backdrop dismiss handler fires.
    await page.click('[data-testid="modal-open"]');
    await page.waitForSelector('[data-testid="modal"]');
    await page.mouse.click(8, 8);
    await page.waitForFunction(() => !document.querySelector('[data-testid="modal"]'), { timeout: 5000 });
    suite.ok('backdrop click closes the modal', true);

    await page.click('[data-testid="modal-open"]');
    await page.waitForSelector('[data-testid="modal"]');
    await page.click('[data-testid="modal-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="modal"]'), { timeout: 5000 });
    suite.ok('close button dismisses the modal', true);

    await page.click('[data-testid="modal-open"]');
    await page.waitForSelector('[data-testid="modal"]');
    const focusables = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="modal"]');
      return dialog ? dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])').length : 0;
    });
    suite.atLeast('modal exposes a focusable set for the trap', focusables, 3);

    // Tab from the last focusable wraps back to the first, proving the trap.
    for (let index = 0; index < focusables + 1; index += 1) {
      await page.keyboard.press('Tab');
    }
    const trappedTestId = (await state()).activeTestId;
    suite.ok(
      'focus stays trapped inside the modal',
      trappedTestId === 'modal-close' || trappedTestId === 'modal-input' || trappedTestId === 'modal-footer',
      String(trappedTestId),
    );

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="modal"]'), { timeout: 5000 });

    await captureScreenshot(page, 'phase-2-primitives');
  }
}