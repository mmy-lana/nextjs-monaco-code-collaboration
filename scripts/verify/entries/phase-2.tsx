import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionButton } from '@/components/primitives/ActionButton';
import { TextInput } from '@/components/primitives/TextInput';
import { DropdownMenu } from '@/components/primitives/DropdownMenu';
import { Tooltip } from '@/components/primitives/Tooltip';
import { ModalOverlay } from '@/components/primitives/ModalOverlay';
import { ResizableSplitter } from '@/components/primitives/ResizableSplitter';

/**
 * Phase 2 verification surface.
 *
 * Every primitive is mounted with real state wiring so the headless suite can
 * exercise genuine interaction (typing, clicking, dragging, key presses)
 * rather than asserting on markup alone.
 */

/** Focus events recorded by the modal section, read by the verification suite. */
const focusLog: string[] = [];

interface Phase2HarnessApi {
  getState: () => {
    clicks: number;
    value: string;
    enters: number;
    escapes: number;
    menuActions: string[];
    splitterSize: number;
    splitterCommits: number;
    modalOpen: boolean;
    focusLog: string[];
    bodyOverflow: string;
    activeTestId: string | null;
  };
}

function Phase2Harness() {
  const [clicks, setClicks] = useState(0);
  const [value, setValue] = useState('');
  const [enters, setEnters] = useState(0);
  const [escapes, setEscapes] = useState(0);
  const [menuActions, setMenuActions] = useState<string[]>([]);
  const [splitterSize, setSplitterSize] = useState(240);
  const [splitterCommits, setSplitterCommits] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const modalInputRef = useRef<HTMLInputElement | null>(null);
  const modalReturnRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div
      data-testid="phase2-root"
      className="flex flex-col gap-6 p-4"
      style={{ background: 'var(--vscode-bg)' }}
    >
      {/* ── ActionButton ─────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-xs uppercase text-vscode-description-fg">ActionButton</h2>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            testId="btn-primary"
            variant="primary"
            onClick={() => setClicks((c) => c + 1)}
          >
            Primary
          </ActionButton>
          <ActionButton testId="btn-ghost" variant="ghost" aria-label="Ghost icon only">
            <span aria-hidden="true">◈</span>
          </ActionButton>
          <ActionButton testId="btn-disabled" disabled onClick={() => setClicks((c) => c + 1)}>
            Disabled
          </ActionButton>
          <ActionButton testId="btn-loading" loading>
            Saving
          </ActionButton>
          <ActionButton testId="btn-large" size="lg" block>
            Large block
          </ActionButton>
        </div>
        <output data-testid="click-count" className="ml-2 text-xs">
          {clicks}
        </output>
      </section>

      {/* ── TextInput ────────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-xs uppercase text-vscode-description-fg">TextInput</h2>
        <TextInput
          testId="text-input"
          label="Rename to"
          placeholder="index.ts"
          value={value}
          onChange={setValue}
          onEnter={() => setEnters((n) => n + 1)}
          onEscape={() => setEscapes((n) => n + 1)}
          clearable
          icon={<span>⌕</span>}
        />
        <TextInput
          testId="text-input-invalid"
          label="Invalid field"
          value={value}
          onChange={setValue}
          tone="error"
          errorMessage="A name is already required at this path."
        />
        <p data-testid="value-echo" className="text-xs">
          {value}
        </p>
        <p data-testid="enter-count" className="text-xs">
          {enters}
        </p>
        <p data-testid="escape-count" className="text-xs">
          {escapes}
        </p>
      </section>

      {/* ── DropdownMenu ─────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-xs uppercase text-vscode-description-fg">DropdownMenu</h2>
        <DropdownMenu
          testId="menu"
          triggerLabel="File actions"
          items={[
            {
              id: 'rename',
              label: 'Rename',
              shortcut: 'F2',
              onSelect: () => setMenuActions((a) => [...a, 'rename']),
            },
            {
              id: 'delete',
              label: 'Delete',
              tone: 'danger',
              separatorBefore: true,
              onSelect: () => setMenuActions((a) => [...a, 'delete']),
            },
            {
              id: 'disabled',
              label: 'Unavailable',
              disabled: true,
              onSelect: () => setMenuActions((a) => [...a, 'disabled']),
            },
          ]}
          trigger={
            <span className="inline-flex h-6 items-center rounded-sm bg-vscode-button-secondary px-2 text-xs">
              Actions ▾
            </span>
          }
        />
        <p data-testid="menu-actions" className="text-xs">
          {menuActions.join(',')}
        </p>
      </section>

      {/* ── Tooltip ──────────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-xs uppercase text-vscode-description-fg">Tooltip</h2>
        <Tooltip content="Format Document" testId="tooltip" delay={120} holdDelay={150}>
          <button
            type="button"
            data-testid="tooltip-anchor"
            className="h-6 rounded-sm bg-vscode-button-secondary px-2 text-xs"
          >
            Format
          </button>
        </Tooltip>
      </section>

      {/* ── ResizableSplitter ────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-xs uppercase text-vscode-description-fg">ResizableSplitter</h2>
        <div
          className="flex items-stretch"
          style={{ height: 80, border: '1px solid var(--vscode-border)' }}
        >
          <div
            data-testid="splitter-pane"
            style={{ width: splitterSize, background: 'var(--vscode-sidebar-bg)' }}
          >
            <p data-testid="pane-width" className="p-2 text-xs">
              {splitterSize}
            </p>
          </div>
          <ResizableSplitter
            testId="splitter"
            orientation="vertical"
            label="Resize sidebar"
            size={splitterSize}
            minSize={200}
            maxSize={400}
            step={20}
            onResize={setSplitterSize}
            onResizeEnd={() => setSplitterCommits((n) => n + 1)}
          />
          <div className="flex-1" style={{ background: 'var(--vscode-editor-bg)' }} />
        </div>
        <p data-testid="splitter-commits" className="text-xs">
          {splitterCommits}
        </p>
      </section>

      {/* ── ModalOverlay ─────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-xs uppercase text-vscode-description-fg">ModalOverlay</h2>
        <button
          ref={modalReturnRef}
          type="button"
          data-testid="modal-open"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2 text-xs"
          onClick={() => setModalOpen(true)}
          onFocus={() => focusLog.push('opener')}
        >
          Open dialog
        </button>

        <ModalOverlay
          testId="modal"
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Rename file"
          description="Renaming propagates to every peer in the room."
          initialFocusRef={modalInputRef}
          returnFocusRef={modalReturnRef}
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="modal-footer"
                className="h-7 rounded-sm bg-vscode-button-secondary px-3 text-xs"
                onFocus={() => focusLog.push('footer')}
              >
                Save
              </button>
            </div>
          }
        >
          <input
            ref={modalInputRef}
            data-testid="modal-input"
            type="text"
            defaultValue="index.ts"
            className="h-8 w-full rounded-sm bg-vscode-input-bg px-2 text-sm"
            aria-label="New file name"
          />
        </ModalOverlay>
      </section>
    </div>
  );
}

export function mountPhase2(container: HTMLElement): void {
  // The entry self-mounts when injected into a loaded document *and* the suite
  // calls the explicit bridge; mounting twice would create two React roots on
  // one container.
  if (window.__phase2Root) return;
  window.__phase2Root = true;

  createRoot(container).render(<Phase2Harness />);

  window.__phase2 = {
    getState: () => ({
      clicks: Number(document.querySelector('[data-testid="click-count"]')?.textContent ?? '0'),
      value: document.querySelector('[data-testid="value-echo"]')?.textContent ?? '',
      enters: Number(document.querySelector('[data-testid="enter-count"]')?.textContent ?? '0'),
      escapes: Number(document.querySelector('[data-testid="escape-count"]')?.textContent ?? '0'),
      menuActions: (document.querySelector('[data-testid="menu-actions"]')?.textContent ?? '')
        .split(',')
        .filter(Boolean),
      splitterSize: Number(
        document.querySelector('[data-testid="pane-width"]')?.textContent ?? '0',
      ),
      splitterCommits: Number(
        document.querySelector('[data-testid="splitter-commits"]')?.textContent ?? '0',
      ),
      modalOpen: document.querySelector('[data-testid="modal"]') !== null,
      focusLog: [...focusLog],
      bodyOverflow: document.body.style.overflow,
      activeTestId:
        document.activeElement instanceof HTMLElement ? document.activeElement.dataset.testid ?? null : null,
    }),
  };
}

declare global {
  interface Window {
    __phase2?: Phase2HarnessApi;
    __phase2Mount?: () => void;
    __phase2Root?: boolean;
  }
}

/**
 * Mounts into `#phase2-container` once it exists. The suite injects the bundle
 * into an already-loaded document, so the explicit `window.__phase2Mount()`
 * bridge is what the suite calls; the readyState branch keeps the bundle
 * self-mounting when it happens to be injected before parsing completes.
 */
const tryMount = (): void => {
  const container = document.getElementById('phase2-container');
  if (container) mountPhase2(container);
};

window.__phase2Mount = tryMount;

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', tryMount);
} else {
  tryMount();
}