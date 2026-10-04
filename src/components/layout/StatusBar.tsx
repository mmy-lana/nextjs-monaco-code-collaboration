'use client';

import { memo } from 'react';
import { Bell, GitBranch, Radio, Users, WifiOff } from 'lucide-react';
import { Tooltip } from '@/components/primitives/Tooltip';
import {
  CONNECTION_STATE_LABELS,
  TRANSPORT_MODE_DETAILS,
  TRANSPORT_MODE_LABELS,
  type ConnectionState,
  type TransportMode,
} from '@/types/collaboration';

export interface StatusBarItem {
  id: string;
  label: string;
  tooltip?: string;
  onClick?: () => void;
}

export interface StatusBarProps {
  isMobile: boolean;
  connectionState: ConnectionState;
  /** Transport actually carrying the CRDT; drives the local-mesh badge. */
  transportMode: TransportMode;
  peerCount: number;
  /** Active file language, shown when a file is open. */
  language: string | null;
  cursor: { line: number; column: number; selectionLength: number } | null;
  workspaceName: string;
  roomId: string;
  problemsCount: number;
  onTogglePanel?: () => void;
  onOpenCollaboration?: () => void;
  items?: readonly StatusBarItem[];
}

/**
 * Footer status strip.
 *
 * Mobile keeps only Branch / peers / language; the full metrics strip is shown
 * from `md` upwards, per the breakpoint matrix.
 *
 * The connection chip reports the transport, not just the peer count: a room
 * held together by BroadcastChannel is syncing, so it must not be dressed up
 * as the same failure as a browser that cannot reach anything.
 */
function StatusBarComponent({
  isMobile,
  connectionState,
  transportMode,
  peerCount,
  language,
  cursor,
  workspaceName,
  roomId,
  problemsCount,
  onTogglePanel,
  onOpenCollaboration,
  items = [],
}: StatusBarProps) {
  const connected = connectionState === 'connected';
  const localMesh = transportMode === 'local-mesh';

  const connectionLabel = connected
    ? `${peerCount} peer${peerCount === 1 ? '' : 's'}`
    : localMesh
      ? TRANSPORT_MODE_LABELS['local-mesh']
      : CONNECTION_STATE_LABELS[connectionState];

  const connectionTooltip = localMesh
    ? `${TRANSPORT_MODE_DETAILS['local-mesh']} ${peerCount} peer(s) in this browser.`
    : connected
      ? `${CONNECTION_STATE_LABELS[connectionState]} · ${peerCount} peer(s) in this room`
      : `${CONNECTION_STATE_LABELS[connectionState]} · ${TRANSPORT_MODE_DETAILS[transportMode]}`;

  return (
    <footer
      data-testid="status-bar"
      data-variant={isMobile ? 'condensed' : 'full'}
      className={`flex shrink-0 items-center gap-3 px-2 text-white ${
        connected ? 'bg-vscode-statusbar-bg' : 'bg-vscode-statusbar-offline-bg'
      }`}
      style={{ height: isMobile ? 28 : 24 }}
    >
      <Tooltip content={`Workspace: ${workspaceName} · room ${roomId}`} placement="top">
        <span className="flex min-w-0 items-center gap-1 text-[11px]" data-testid="status-workspace">
          <GitBranch size={12} aria-hidden="true" />
          <span className="truncate">{isMobile ? roomId : `${workspaceName} · ${roomId}`}</span>
        </span>
      </Tooltip>

      <button
        type="button"
        data-testid="status-problems"
        onClick={onTogglePanel}
        className="flex items-center gap-1 text-[11px] hover:underline"
        aria-label={`${problemsCount} problems`}
      >
        {problemsCount > 0 ? <Bell size={12} aria-hidden="true" /> : null}⊗ {problemsCount} ⚠ 0
      </button>

      <Tooltip content={connectionTooltip} placement="top">
        <button
          type="button"
          data-testid="status-connection"
          data-state={connectionState}
          data-transport={transportMode}
          onClick={onOpenCollaboration}
          className="flex items-center gap-1 text-[11px] hover:underline"
        >
          {connected || localMesh ? (
            <Radio size={12} aria-hidden="true" />
          ) : (
            <WifiOff size={12} aria-hidden="true" />
          )}
          {connectionLabel}
        </button>
      </Tooltip>

      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          data-testid={`status-item-${item.id}`}
          onClick={item.onClick}
          title={item.tooltip ?? item.label}
          className="truncate text-[11px] hover:underline"
        >
          {item.label}
        </button>
      ))}

      <span className="ml-auto flex items-center gap-3 text-[11px]">
        {!isMobile ? (
          <span className="flex items-center gap-1" data-testid="status-remote">
            <Users size={12} aria-hidden="true" />
            {peerCount}
          </span>
        ) : null}

        {cursor ? (
          <span data-testid="status-cursor">
            Ln {cursor.line}, Col {cursor.column}
            {cursor.selectionLength > 0 ? ` (${cursor.selectionLength} selected)` : ''}
          </span>
        ) : null}

        {!isMobile ? (
          <>
            <span data-testid="status-encoding">UTF-8</span>
            <span data-testid="status-eol">LF</span>
          </>
        ) : null}

        <span data-testid="status-language">{language ?? 'Plain Text'}</span>
      </span>
    </footer>
  );
}

export const StatusBar = memo(StatusBarComponent);
StatusBar.displayName = 'StatusBar';