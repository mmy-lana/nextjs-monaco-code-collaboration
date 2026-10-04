'use client';

import { useCallback } from 'react';
import { RotateCcw, User } from 'lucide-react';
import { ActionButton } from '@/components/primitives/ActionButton';
import { TextInput } from '@/components/primitives/TextInput';
import { formatBytes } from '@/db/schema';
import { DEFAULT_MONACO_CONFIG, type MonacoEditorConfig } from '@/types/editor';
import type { LocalPeerIdentity } from '@/types/collaboration';

export interface SettingsViewProps {
  config: MonacoEditorConfig;
  onConfigChange: (patch: Partial<MonacoEditorConfig>) => void;
  onResetConfig: () => void;
  /** Persisted `data-theme` applied to the document root. */
  theme: 'vs-dark' | 'vs-light' | 'hc-black';
  onThemeChange: (theme: 'vs-dark' | 'vs-light' | 'hc-black') => void;
  identity: LocalPeerIdentity | null;
  onRename: (name: string) => void;
  onResetIdentity: () => void;
  /** Approximate bytes used by the metadata + CRDT stores. */
  storageBytes: number;
  nodeCount: number;
  workspaceCount: number;
}

const THEMES: MonacoEditorConfig['theme'][] = ['vs-dark', 'vs-light', 'hc-black'];

/**
 * Workspace preferences.
 *
 * Settings are applied immediately and persisted to `localStorage` by the shell,
 * so a reload restores the exact editor configuration the user left behind.
 */
export function SettingsView({
  config,
  onConfigChange,
  onResetConfig,
  theme,
  onThemeChange,
  identity,
  onRename,
  onResetIdentity,
  storageBytes,
  nodeCount,
  workspaceCount,
}: SettingsViewProps) {
  const handleRename = useCallback(
    (value: string) => onRename(value),
    [onRename],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="settings-view">
      <header className="shrink-0 px-3 py-2">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-vscode-description-fg">
          Settings
        </h2>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-vscode-fg">Editor</h3>

          <div className="grid grid-cols-2 gap-2">
            <TextInput
              testId="settings-font-size"
              size="sm"
              label="Font size"
              type="number"
              min={10}
              max={28}
              value={String(config.fontSize)}
              onChange={(value) => {
                const parsed = Number.parseInt(value, 10);
                if (Number.isFinite(parsed)) {
                  onConfigChange({ fontSize: Math.min(28, Math.max(10, parsed)) });
                }
              }}
            />
            <TextInput
              testId="settings-tab-size"
              size="sm"
              label="Tab size"
              type="number"
              min={1}
              max={8}
              value={String(config.tabSize)}
              onChange={(value) => {
                const parsed = Number.parseInt(value, 10);
                if (Number.isFinite(parsed)) {
                  onConfigChange({ tabSize: Math.min(8, Math.max(1, parsed)) });
                }
              }}
            />
          </div>

          <label className="flex items-center justify-between text-[11px] text-vscode-fg">
            Word wrap
            <select
              data-testid="settings-word-wrap"
              value={config.wordWrap}
              onChange={(event) =>
                onConfigChange({ wordWrap: event.target.value as MonacoEditorConfig['wordWrap'] })
              }
              className="h-6 rounded-sm border border-vscode-input-border bg-vscode-input-bg px-1 text-[11px]"
            >
              <option value="off">off</option>
              <option value="on">on</option>
              <option value="wordWrapColumn">wordWrapColumn</option>
              <option value="bounded">bounded</option>
            </select>
          </label>

          <label className="flex items-center justify-between text-[11px] text-vscode-fg">
            Line numbers
            <select
              data-testid="settings-line-numbers"
              value={config.lineNumbers}
              onChange={(event) =>
                onConfigChange({ lineNumbers: event.target.value as MonacoEditorConfig['lineNumbers'] })
              }
              className="h-6 rounded-sm border border-vscode-input-border bg-vscode-input-bg px-1 text-[11px]"
            >
              <option value="on">on</option>
              <option value="off">off</option>
              <option value="relative">relative</option>
            </select>
          </label>

          <label className="flex items-center justify-between text-[11px] text-vscode-fg">
            Cursor style
            <select
              data-testid="settings-cursor-style"
              value={config.cursorStyle}
              onChange={(event) =>
                onConfigChange({ cursorStyle: event.target.value as MonacoEditorConfig['cursorStyle'] })
              }
              className="h-6 rounded-sm border border-vscode-input-border bg-vscode-input-bg px-1 text-[11px]"
            >
              <option value="line">line</option>
              <option value="block">block</option>
              <option value="underline">underline</option>
            </select>
          </label>

          <label className="flex items-center justify-between text-[11px] text-vscode-fg">
            Minimap
            <input
              type="checkbox"
              data-testid="settings-minimap"
              checked={config.minimap.enabled}
              onChange={(event) =>
                onConfigChange({ minimap: { enabled: event.target.checked } })
              }
              className="h-4 w-4 accent-[var(--vscode-accent)]"
            />
          </label>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-vscode-fg">Theme</h3>
          <div className="flex flex-wrap gap-1.5">
            {THEMES.map((option) => (
              <ActionButton
                key={option}
                testId={`settings-theme-${option}`}
                size="sm"
                variant={theme === option ? 'primary' : 'secondary'}
                aria-pressed={theme === option}
                onClick={() => onThemeChange(option)}
              >
                {option}
              </ActionButton>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-vscode-fg">
            <User size={12} aria-hidden="true" />
            Your identity
          </h3>
          <p className="text-[10px] text-vscode-description-fg">
            Peers see this name and the cursor colour{' '}
            <span
              className="mx-1 inline-block h-2 w-2 rounded-full align-middle"
              style={{ backgroundColor: identity?.color ?? 'transparent' }}
              aria-hidden="true"
            />
            beside their cursor.
          </p>
          <TextInput
            testId="settings-identity-name"
            size="sm"
            label="Display name"
            value={identity?.name ?? ''}
            onChange={handleRename}
            placeholder="SwiftCoder#123"
          />
          <ActionButton
            testId="settings-reset-identity"
            size="sm"
            variant="secondary"
            block
            icon={<RotateCcw size={12} aria-hidden="true" />}
            onClick={onResetIdentity}
          >
            Generate a new identity
          </ActionButton>
        </section>

        <section className="space-y-1">
          <h3 className="text-xs font-medium text-vscode-fg">Storage</h3>
          <p className="text-[10px] text-vscode-description-fg" data-testid="settings-storage">
            {formatBytes(storageBytes)} across {nodeCount} node{nodeCount === 1 ? '' : 's'} and{' '}
            {workspaceCount} workspace{workspaceCount === 1 ? '' : 's'} · everything stays on this
            device until you export it.
          </p>
          <p className="text-[10px] text-vscode-description-fg">
            Defaults: {DEFAULT_MONACO_CONFIG.fontSize}px · tab {DEFAULT_MONACO_CONFIG.tabSize}
          </p>
          <ActionButton
            testId="settings-reset-config"
            size="sm"
            variant="secondary"
            block
            icon={<RotateCcw size={12} aria-hidden="true" />}
            onClick={onResetConfig}
          >
            Reset editor settings
          </ActionButton>
        </section>
      </div>
    </div>
  );
}