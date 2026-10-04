'use client';

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, Download, Plug, Radio, RefreshCw, Users } from 'lucide-react';
import { ActionButton } from '@/components/primitives/ActionButton';
import { TextInput } from '@/components/primitives/TextInput';
import { PeerAvatarGroup } from '@/components/molecules/PeerAvatarGroup';
import {
  CONNECTION_STATE_LABELS,
  TRANSPORT_MODE_DETAILS,
  TRANSPORT_MODE_LABELS,
  type PeerUser,
  type RoomConnectionInfo,
} from '@/types/collaboration';

export interface CollaborationViewProps {
  roomId: string;
  /** Commits a room change; the provider is rebuilt with the new id. */
  onRoomIdChange: (roomId: string) => void;
  connection: RoomConnectionInfo;
  peers: readonly PeerUser[];
  pendingPeerCount: number;
  /** Current signaling server list, one entry per line. */
  signalingServers: string[];
  onSignalingServersChange: (servers: string[]) => void;
  /** Applies the edited signaling list by reconnecting the provider. */
  onApplySignaling: () => void;
  /** Identifies the local peer in the roster. */
  localClientId: number;
  isHost: boolean;
  /** Re-runs provider setup (retry after a signaling failure). */
  onReconnect: () => void;
  /** Exports the workspace + CRDT snapshot as a downloadable JSON file. */
  onExport: () => void;
  /** Restores a previously exported snapshot. */
  onImport: (file: File) => void;
  error: string | null;
}

const CONNECTION_TONE: Record<RoomConnectionInfo['connectionState'], string> = {
  connected: 'bg-vscode-success-fg text-[#1e1e1e]',
  connecting: 'bg-vscode-warning-fg text-[#1e1e1e]',
  disconnected: 'bg-vscode-statusbar-offline-bg text-white',
  offline: 'bg-vscode-statusbar-offline-bg text-white',
};

/**
 * LAN collaboration controls: room identity, signaling endpoints, live peer
 * roster and snapshot export.
 *
 * Everything here is local-first — there is no hosted backend, so the signaling
 * list is user-editable and a failed connection is a first-class UI state rather
 * than an error toast.
 */
export function CollaborationView({
  roomId,
  onRoomIdChange,
  connection,
  peers,
  pendingPeerCount,
  signalingServers,
  onSignalingServersChange,
  onApplySignaling,
  localClientId,
  isHost,
  onReconnect,
  onExport,
  onImport,
  error,
}: CollaborationViewProps) {
  const [roomDraft, setRoomDraft] = useState(roomId);
  const [serverDraft, setServerDraft] = useState(signalingServers.join('\n'));
  const [serverError, setServerError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);

  const transportMode = connection.transportMode;
  const localMesh = transportMode === 'local-mesh';
  /*
   * "Open this room on another device" is only true advice when a device on
   * another device can actually be reached. Under the local mesh it would send
   * the user chasing a peer that no configuration of their LAN will deliver.
   */
  const peerHint = localMesh
    ? 'Only tabs of this browser can join while signaling is unreachable. Start a signaling server above to invite other devices.'
    : 'Open this room in another browser on the same LAN.';

  const dirtyRoom = roomDraft.trim() !== roomId;
  const parsedServers = useMemo(
    () =>
      serverDraft
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    [serverDraft],
  );
  const dirtyServers =
    parsedServers.length !== signalingServers.length ||
    parsedServers.some((server, index) => server !== signalingServers[index]);

  const commitRoom = useCallback(() => {
    const next = roomDraft.trim();
    if (next === roomId) return;
    if (next.length < 3) {
      setRoomError('Room IDs need at least 3 characters.');
      return;
    }
    if (!/^[\w-]+$/.test(next)) {
      setRoomError('Use only letters, digits, dashes and underscores.');
      return;
    }
    setRoomError(null);
    onRoomIdChange(next);
  }, [onRoomIdChange, roomDraft, roomId]);

  const commitServers = useCallback(() => {
    const invalid = parsedServers.find((server) => !/^wss?:\/\/[^\s]+$/.test(server));
    if (invalid) {
      setServerError(`“${invalid}” is not a valid ws:// or wss:// address.`);
      return;
    }
    setServerError(null);
    onSignalingServersChange(parsedServers);
    onApplySignaling();
  }, [onApplySignaling, onSignalingServersChange, parsedServers]);

  const copyRoomId = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard
      .writeText(roomId)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
      .finally(() => {
        window.setTimeout(() => setCopied(false), 1500);
      });
  }, [roomId]);

  const handleImport = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) onImport(file);
      event.target.value = '';
    },
    [onImport],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="collaboration-view">
      <header className="flex shrink-0 items-center justify-between px-3 py-2">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-vscode-description-fg">
          Collaboration
        </h2>
        <span
          data-testid="connection-chip"
          data-state={connection.connectionState}
          data-transport={transportMode}
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            connection.connectionState === 'connected'
              ? CONNECTION_TONE.connected
              : transportMode === 'unavailable'
                ? CONNECTION_TONE[connection.connectionState]
                : CONNECTION_TONE.connecting
          }`}
        >
          {/*
           * Precedence: real peers first, then the transport that is carrying
           * the document, then the raw connection state. "Disconnected" beside
           * a working mesh — or beside the local BroadcastChannel path —
           * contradicts the transport panel directly beneath it, and only a
           * browser with no usable transport has nothing better to say.
           */}
          {connection.connectionState === 'connected'
            ? CONNECTION_STATE_LABELS.connected
            : transportMode === 'unavailable'
              ? CONNECTION_STATE_LABELS[connection.connectionState]
              : TRANSPORT_MODE_LABELS[transportMode]}
        </span>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        <section
          className={`space-y-1 rounded-sm border p-2 ${
            localMesh
              ? 'border-vscode-warning-fg/50 bg-vscode-warning-fg/10'
              : 'border-vscode-border bg-vscode-editor-hoverBg'
          }`}
          data-testid="transport-panel"
          data-transport={transportMode}
        >
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-vscode-fg">
            {localMesh ? (
              <Radio size={12} aria-hidden="true" />
            ) : (
              <Plug size={12} aria-hidden="true" />
            )}
            Transport: {TRANSPORT_MODE_LABELS[transportMode]}
          </h3>
          <p className="text-[11px] text-vscode-description-fg">
            {TRANSPORT_MODE_DETAILS[transportMode]}
          </p>
          {!connection.broadcastChannelSupported ? (
            <p className="text-[11px] text-vscode-error-fg" data-testid="transport-limitation">
              This browser has no BroadcastChannel, so tabs of this browser cannot sync either.
            </p>
          ) : null}
        </section>

        {error ? (
          <div role="alert" className="rounded-sm border border-vscode-error-fg/60 bg-vscode-error-fg/10 p-2">
            <p className="flex items-center gap-2 text-[11px] text-vscode-error-fg">
              <AlertTriangle size={12} aria-hidden="true" />
              {error}
            </p>
          </div>
        ) : null}

        <section className="space-y-1.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-vscode-fg">Room</h3>
            {isHost ? (
              <span className="rounded-full bg-vscode-badge-bg px-1.5 text-[10px] text-vscode-fg">Host</span>
            ) : null}
          </div>
          <TextInput
            testId="room-id-input"
            label="Room ID"
            value={roomDraft}
            onChange={(value) => {
              setRoomDraft(value);
              setRoomError(null);
            }}
            onEnter={commitRoom}
            tone={roomError ? 'error' : 'default'}
            errorMessage={roomError}
            placeholder="collab-workspace-lan"
            icon={<Radio size={13} aria-hidden="true" />}
          />
          <div className="flex gap-1.5">
            <ActionButton
              testId="room-apply"
              size="sm"
              variant="primary"
              block
              disabled={!dirtyRoom}
              onClick={commitRoom}
            >
              Join room
            </ActionButton>
            <ActionButton
              testId="room-copy"
              size="sm"
              variant="secondary"
              aria-label="Copy room ID"
              icon={copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              onClick={copyRoomId}
            />
          </div>
          <p className="text-[10px] text-vscode-description-fg">
            Share this ID with anyone on the same network. No server round-trip is required.
          </p>
        </section>

        <section className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-vscode-fg">
            <Plug size={12} aria-hidden="true" />
            Signaling servers
          </h3>
          <label className="sr-only" htmlFor="signaling-servers">
            Signaling servers, one per line
          </label>
          <textarea
            id="signaling-servers"
            data-testid="signaling-servers"
            value={serverDraft}
            onChange={(event) => {
              setServerDraft(event.target.value);
              setServerError(null);
            }}
            rows={3}
            spellCheck={false}
            placeholder={'ws://localhost:4444\nwss://signaling.lan:4444'}
            className="w-full resize-y rounded-sm border border-vscode-input-border bg-vscode-input-bg px-2 py-1 font-mono text-[11px] text-vscode-input-fg outline-none focus:border-vscode-accent"
          />
          {serverError ? (
            <p role="alert" className="text-[10px] text-vscode-error-fg">
              {serverError}
            </p>
          ) : null}
          <ActionButton
            testId="signaling-apply"
            size="sm"
            variant="primary"
            block
            disabled={!dirtyServers}
            onClick={commitServers}
          >
            Reconnect with these servers
          </ActionButton>
          <p className="text-[10px] text-vscode-description-fg">
            Leave empty to rely on the built-in BroadcastChannel fallback, which syncs tabs on the
            same browser.
          </p>
        </section>

        <section className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-vscode-fg">
            <Users size={12} aria-hidden="true" />
            Peers ({connection.peerCount})
          </h3>
          <PeerAvatarGroup peers={peers} pendingCount={pendingPeerCount} />
          {peers.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {peers.map((peer) => (
                <li
                  key={peer.clientId}
                  data-testid={`peer-row-${peer.clientId}`}
                  className="flex items-center gap-2 rounded-sm px-1 py-0.5 text-[11px] hover:bg-vscode-list-hover"
                >
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: peer.color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-vscode-fg">{peer.name}</span>
                  {peer.clientId === localClientId ? (
                    <span className="shrink-0 text-[10px] text-vscode-description-fg">you</span>
                  ) : null}
                  <span className="shrink-0 text-[10px] text-vscode-description-fg">
                    {peer.cursor ? `${peer.cursor.line}:${peer.cursor.column}` : 'idle'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-vscode-description-fg" data-testid="peer-list-empty">
              No remote peers yet. {peerHint}
            </p>
          )}
        </section>

        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-vscode-fg">Snapshot</h3>
          <div className="flex gap-1.5">
            <ActionButton
              testId="collab-export"
              size="sm"
              variant="secondary"
              block
              icon={<Download size={13} aria-hidden="true" />}
              onClick={onExport}
            >
              Export
            </ActionButton>
            <label className="flex-1">
              <span className="sr-only">Import workspace snapshot</span>
              <input
                type="file"
                accept="application/json,.json"
                data-testid="collab-import"
                onChange={handleImport}
                className="w-full text-[11px] text-vscode-description-fg file:mr-2 file:rounded-sm file:border-0 file:bg-vscode-button-secondary file:px-2 file:py-1 file:text-[11px] file:text-vscode-fg"
              />
            </label>
          </div>
        </section>

        <ActionButton
          testId="collab-reconnect"
          size="sm"
          variant="ghost"
          block
          icon={<RefreshCw size={13} aria-hidden="true" />}
          onClick={onReconnect}
        >
          Reconnect provider
        </ActionButton>
      </div>
    </div>
  );
}