'use client';

import { useCallback, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Info,
  Terminal,
  Radio,
  X,
} from 'lucide-react';
import { ActionButton } from '@/components/primitives/ActionButton';
import { Tooltip } from '@/components/primitives/Tooltip';
import { LanDebugConsole } from '@/components/domain/LanDebugConsole';
import type { DiagnosticItem, BottomPanelTab } from '@/types/editor';
import type { LanLogEntry, LanMeshStats } from '@/types/collaboration';

export interface BottomPanelProps {
  open: boolean;
  activeTab: BottomPanelTab;
  onActiveTabChange: (tab: BottomPanelTab) => void;
  onToggle: () => void;
  onClose: () => void;
  height: number;
  /** Output lines produced by the workspace logger. */
  output: readonly string[];
  diagnostics: readonly DiagnosticItem[];
  lanLogs: readonly LanLogEntry[];
  lanStats: LanMeshStats | null;
  onClearLanLogs: () => void;
  onExportLanLogs: () => void;
  isMobile: boolean;
  onOpenDiagnostic: (diagnostic: DiagnosticItem) => void;
}

const SEVERITY_ICON = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
} as const;

const SEVERITY_COLOR = {
  error: 'text-vscode-error-fg',
  warning: 'text-vscode-warning-fg',
  info: 'text-vscode-info-fg',
} as const;

/**
 * Bottom panel with VS Code's tabbed footer.
 *
 * On mobile it becomes a full-screen sheet (the terminal output would be
 * unreadable in a 200px strip); from `md` upwards it is a resizable, dockable
 * panel under the editor.
 */
export function BottomPanel({
  open,
  activeTab,
  onActiveTabChange,
  onToggle,
  onClose,
  height,
  output,
  diagnostics,
  lanLogs,
  lanStats,
  onClearLanLogs,
  onExportLanLogs,
  isMobile,
  onOpenDiagnostic,
}: BottomPanelProps) {
  const [terminalInput, setTerminalInput] = useState('');

  const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
  const warningCount = diagnostics.filter((item) => item.severity === 'warning').length;

  const tabs: { id: BottomPanelTab; label: string; badge?: number }[] = [
    { id: 'terminal', label: 'Terminal' },
    { id: 'output', label: 'Output' },
    { id: 'problems', label: 'Problems', badge: diagnostics.length },
    { id: 'lan-debug', label: 'LAN Debug', badge: lanLogs.length },
  ];

  const runCommand = useCallback(() => {
    // The workspace has no shell: this is a workspace command channel, not a
    // process runner, and it must never be mistaken for one.
    setTerminalInput('');
  }, []);

  if (!open) {
    return (
      <div className="flex h-8 shrink-0 items-center justify-between border-t border-vscode-border bg-vscode-panel-bg px-2">
        <ActionButton
          testId="panel-open"
          size="sm"
          variant="ghost"
          aria-label="Open panel"
          icon={<Terminal size={13} aria-hidden="true" />}
          onClick={onToggle}
        >
          Panel
        </ActionButton>
        <span className="text-[10px] text-vscode-description-fg" data-testid="panel-summary-closed">
          {diagnostics.length > 0
            ? `${errorCount} errors, ${warningCount} warnings`
            : 'No problems detected'}
        </span>
      </div>
    );
  }

  return (
    <section
      data-testid="bottom-panel"
      data-layout={isMobile ? 'sheet' : 'dock'}
      aria-label="Output panel"
      style={isMobile ? undefined : { height: `${height}px` }}
      className={
        isMobile
          ? 'fixed inset-0 z-[65] flex flex-col bg-vscode-panel-bg'
          : 'flex shrink-0 flex-col border-t border-vscode-border bg-vscode-panel-bg'
      }
    >
      <header className="flex h-[var(--panel-tab-height)] shrink-0 items-center gap-1 border-b border-vscode-border px-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            data-testid={`panel-tab-${tab.id}`}
            onClick={() => onActiveTabChange(tab.id)}
            className={`flex h-7 items-center gap-1.5 rounded-sm px-2 text-[11px] uppercase tracking-wide transition-colors ${
              activeTab === tab.id
                ? 'border-b-2 border-vscode-accent text-vscode-active-fg'
                : 'text-vscode-description-fg hover:bg-vscode-button-hover'
            }`}
          >
            {tab.id === 'lan-debug' ? <Radio size={12} aria-hidden="true" /> : null}
            {tab.label}
            {tab.badge ? (
              <span className="rounded-full bg-vscode-badge-bg px-1 text-[10px] text-vscode-fg">
                {tab.badge}
              </span>
            ) : null}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-1">
          <Tooltip content={open ? 'Hide panel' : 'Show panel'} placement="left">
            <ActionButton
              testId="panel-toggle"
              size="sm"
              variant="ghost"
              aria-label={open ? 'Hide panel' : 'Show panel'}
              onClick={onToggle}
            >
              ▾
            </ActionButton>
          </Tooltip>
          <ActionButton
            testId="panel-close"
            size="sm"
            variant="ghost"
            aria-label="Close panel"
            icon={<X size={12} aria-hidden="true" />}
            onClick={onClose}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'terminal' ? (
          <div className="flex h-full flex-col" data-testid="panel-body-terminal">
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-vscode-fg">
              {output.length === 0 ? (
                <p className="text-vscode-description-fg">
                  Workspace channel ready. Type a command and press Enter.
                </p>
              ) : (
                output.map((line, index) => (
                  <p key={`${index}-${line}`} className="whitespace-pre-wrap break-words">
                    {line}
                  </p>
                ))
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t border-vscode-border px-3 py-1.5">
              <span className="font-mono text-[11px] text-vscode-success-fg">workspace ❯</span>
              <input
                data-testid="panel-terminal-input"
                value={terminalInput}
                onChange={(event) => setTerminalInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runCommand();
                }}
                aria-label="Workspace command"
                className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-vscode-fg outline-none"
              />
            </div>
          </div>
        ) : null}

        {activeTab === 'output' ? (
          <div className="h-full overflow-y-auto px-3 py-2 font-mono text-[11px]" data-testid="panel-body-output">
            {output.length === 0 ? (
              <p className="text-vscode-description-fg">No output has been produced yet.</p>
            ) : (
              output.map((line, index) => (
                <p key={`${index}-${line}`} className="whitespace-pre-wrap break-words text-vscode-fg">
                  {line}
                </p>
              ))
            )}
          </div>
        ) : null}

        {activeTab === 'problems' ? (
          <div className="h-full overflow-y-auto" data-testid="panel-body-problems">
            {diagnostics.length === 0 ? (
              <p className="px-3 py-4 text-center text-[11px] text-vscode-description-fg">
                No problems have been detected in this workspace.
              </p>
            ) : (
              <ul>
                {diagnostics.map((diagnostic) => {
                  const Icon = SEVERITY_ICON[diagnostic.severity];
                  return (
                    <li key={diagnostic.id}>
                      <button
                        type="button"
                        data-testid={`diagnostic-${diagnostic.id}`}
                        onClick={() => onOpenDiagnostic(diagnostic)}
                        className="flex w-full items-start gap-2 px-3 py-1 text-left text-[11px] hover:bg-vscode-list-hover"
                      >
                        <Icon
                          size={12}
                          aria-hidden="true"
                          className={`mt-0.5 shrink-0 ${SEVERITY_COLOR[diagnostic.severity]}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-vscode-fg">{diagnostic.message}</span>
                          <span className="block truncate text-vscode-description-fg">
                            {diagnostic.filePath}:{diagnostic.startLine}:{diagnostic.startColumn} ·{' '}
                            {diagnostic.source}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {activeTab === 'lan-debug' ? (
          <LanDebugConsole
            entries={lanLogs}
            stats={lanStats}
            onClear={onClearLanLogs}
            onExport={onExportLanLogs}
          />
        ) : null}
      </div>
    </section>
  );
}