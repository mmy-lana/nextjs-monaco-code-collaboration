'use client';

import { useMemo, useState } from 'react';
import { Activity, Download, Trash2 } from 'lucide-react';
import { ActionButton } from '@/components/primitives/ActionButton';
import { TextInput } from '@/components/primitives/TextInput';
import { formatBytes } from '@/db/schema';
import type { LanLogEntry, LanLogLevel, LanMeshStats } from '@/types/collaboration';

export interface LanDebugConsoleProps {
  entries: readonly LanLogEntry[];
  stats: LanMeshStats | null;
  onClear: () => void;
  /** Writes the log to a `.log` file for offline diagnosis. */
  onExport: () => void;
}

const LEVEL_TONE: Record<LanLogLevel, string> = {
  info: 'text-vscode-fg',
  success: 'text-vscode-success-fg',
  warn: 'text-vscode-warning-fg',
  error: 'text-vscode-error-fg',
};

const CHANNEL_LABEL: Record<LanLogEntry['channel'], string> = {
  signaling: 'SIG',
  webrtc: 'RTC',
  persistence: 'IDB',
  awareness: 'AWR',
  system: 'SYS',
};

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * LAN transport inspector.
 *
 * An air-gapped mesh has no server-side logs, so the diagnostics have to live in
 * the client: signaling attempts, ICE candidates, awareness churn and
 * IndexedDB persistence state are all surfaced here with exportable output.
 */
export function LanDebugConsole({ entries, stats, onClear, onExport }: LanDebugConsoleProps) {
  // The raw text is kept locally so partial input ("w", "wa", …) is never
  // swallowed while the user is still typing a level name.
  const [filterText, setFilterText] = useState('');
  const levelFilter = useMemo<LanLogLevel | 'all'>(() => {
    const normalized = filterText.trim().toLowerCase();
    if (normalized === 'info' || normalized === 'success' || normalized === 'warn' || normalized === 'error') {
      return normalized;
    }
    return 'all';
  }, [filterText]);

  const filtered = useMemo(
    () => (levelFilter === 'all' ? entries : entries.filter((entry) => entry.level === levelFilter)),
    [entries, levelFilter],
  );

  return (
    <div className="flex h-full min-h-0 flex-col font-mono" data-testid="lan-debug-console">
      <div className="shrink-0 border-b border-vscode-border px-2 py-1.5">
        {stats ? (
          <dl
            className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] sm:grid-cols-4 lg:grid-cols-6"
            data-testid="lan-stats"
          >
            <div>
              <dt className="text-vscode-description-fg">Room</dt>
              <dd className="truncate text-vscode-fg">{stats.roomId}</dd>
            </div>
            <div>
              <dt className="text-vscode-description-fg">Peers</dt>
              <dd className="text-vscode-fg">{stats.peerCount}</dd>
            </div>
            <div>
              <dt className="text-vscode-description-fg">Signaling</dt>
              <dd className={stats.signalingConnected ? 'text-vscode-success-fg' : 'text-vscode-warning-fg'}>
                {stats.signalingConnected ? 'connected' : 'fallback'}
              </dd>
            </div>
            <div>
              <dt className="text-vscode-description-fg">Broadcast</dt>
              <dd className="text-vscode-fg">{stats.broadcastChannelSupported ? 'ok' : 'n/a'}</dd>
            </div>
            <div>
              <dt className="text-vscode-description-fg">IndexedDB</dt>
              <dd className={stats.persistenceSynced ? 'text-vscode-success-fg' : 'text-vscode-description-fg'}>
                {stats.persistenceSynced ? 'synced' : 'pending'}
              </dd>
            </div>
            <div>
              <dt className="text-vscode-description-fg">Traffic</dt>
              <dd className="text-vscode-fg">
                ↑{formatBytes(stats.bytesSent)} ↓{formatBytes(stats.bytesReceived)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-[11px] text-vscode-description-fg" data-testid="lan-stats-empty">
            Provider not started yet.
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-vscode-border px-2 py-1">
        <TextInput
          testId="lan-log-filter"
          size="sm"
          className="max-w-[180px] flex-1"
          label="Filter level"
          placeholder="Filter by level: info, warn, error"
          value={filterText}
          onChange={setFilterText}
        />
        <span className="text-[10px] text-vscode-description-fg" data-testid="lan-log-count">
          {filtered.length}/{entries.length}
        </span>
        <ActionButton
          testId="lan-log-export"
          size="sm"
          variant="ghost"
          aria-label="Export LAN log"
          disabled={entries.length === 0}
          icon={<Download size={13} aria-hidden="true" />}
          onClick={onExport}
        />
        <ActionButton
          testId="lan-log-clear"
          size="sm"
          variant="ghost"
          aria-label="Clear LAN log"
          disabled={entries.length === 0}
          icon={<Trash2 size={13} aria-hidden="true" />}
          onClick={onClear}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="lan-log-scroll">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <Activity size={20} aria-hidden="true" className="mx-auto opacity-40" />
            <p className="mt-2 text-[11px] text-vscode-fg">
              {entries.length === 0 ? 'No LAN events recorded yet' : 'No entries match this filter'}
            </p>
            <p className="mt-1 text-[10px] text-vscode-description-fg">
              Signaling, ICE and persistence events appear here as the mesh forms.
            </p>
          </div>
        ) : (
          <ol className="divide-y divide-vscode-border/40">
            {filtered.map((entry) => (
              <li key={entry.id} className="flex gap-2 px-2 py-1 text-[11px]">
                <span className="shrink-0 tabular-nums text-vscode-description-fg">
                  {formatTimestamp(entry.timestamp)}
                </span>
                <span className="shrink-0 rounded-sm bg-vscode-badge-bg px-1 text-[9px] uppercase leading-4 text-vscode-fg">
                  {CHANNEL_LABEL[entry.channel]}
                </span>
                <span className={`min-w-0 flex-1 break-words ${LEVEL_TONE[entry.level]}`}>
                  {entry.message}
                  {entry.detail ? (
                    <span className="ml-1 text-vscode-description-fg">{entry.detail}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}