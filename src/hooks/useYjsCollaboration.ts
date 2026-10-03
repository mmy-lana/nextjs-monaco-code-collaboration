'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { WebrtcProvider } from 'y-webrtc';
import {
  createCollaborationSession,
  getFileText,
  type YjsCollaborationSession,
} from '@/services/yjsProvider';
import { DEFAULT_SIGNALING, isSignalingSupported } from '@/services/signalingConfig';
import {
  type ConnectionState,
  type LanLogEntry,
  type LanLogLevel,
  type LanMeshStats,
  type LocalPeerIdentity,
  type PeerUser,
  type RoomConnectionInfo,
} from '@/types/collaboration';
import {
  clearLocalIdentity,
  resolveLocalIdentity,
  saveLocalIdentity,
} from '@/utils/colorGenerator';
import { supportsWebRTC } from '@/utils/platform';

/**
 * Awareness instance type, derived from the provider so `y-protocols` stays a
 * transitive dependency instead of a direct one.
 */
export type CollaborationAwareness = WebrtcProvider['awareness'];

/** Origin tag used for local transactions, so they are not echoed back. */
export const LOCAL_ORIGIN = 'local-input';

export interface UseYjsCollaborationOptions {
  roomId: string;
  /** Set to null while the workspace is still bootstrapping. */
  enabled: boolean;
  signalingServers?: string[];
}

export interface UseYjsCollaborationResult {
  doc: YjsCollaborationSession['doc'] | null;
  /** Live WebRTC provider, needed by the Monaco awareness decorations. */
  provider: WebrtcProvider | null;
  awareness: CollaborationAwareness | null;
  identity: LocalPeerIdentity | null;
  connection: RoomConnectionInfo;
  peers: PeerUser[];
  stats: LanMeshStats | null;
  logs: LanLogEntry[];
  /** Pushes the local cursor/selection/active file into awareness. */
  publishPresence: (patch: Partial<Omit<PeerUser, 'clientId' | 'name' | 'color'>>) => void;
  /** Replaces the signaling server list and rebuilds the provider. */
  setSignalingServers: (servers: string[]) => void;
  /** Tears the provider down and builds a fresh one for the same room. */
  reconnect: () => void;
  renameSelf: (name: string) => void;
  /** Applies a CRDT update exported from another peer. */
  importSnapshot: (update: Uint8Array) => void;
  appendLog: (level: LanLogLevel, channel: LanLogEntry['channel'], message: string, detail?: string) => void;
  clearLogs: () => void;
}

const MAX_LOG_ENTRIES = 500;

const emptyConnection = (roomId: string, signalingServers: string[]): RoomConnectionInfo => ({
  roomId,
  connectionState: 'offline',
  peerCount: 1,
  signalingServers,
  webrtcSupported: false,
});

let logSequence = 0;

/** Parses an untrusted awareness payload; returns `null` for anything malformed. */
export function parsePeerState(raw: unknown): PeerUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const user = candidate.user;
  if (!user || typeof user !== 'object') return null;

  const payload = user as Record<string, unknown>;
  if (typeof payload.name !== 'string' || typeof payload.color !== 'string') return null;

  const cursor =
    payload.cursor && typeof payload.cursor === 'object'
      ? (() => {
          const value = payload.cursor as Record<string, unknown>;
          return typeof value.line === 'number' && typeof value.column === 'number'
            ? { line: value.line, column: value.column }
            : null;
        })()
      : null;

  const selection =
    payload.selection && typeof payload.selection === 'object'
      ? (() => {
          const value = payload.selection as Record<string, unknown>;
          const keys = [
            'startLineNumber',
            'startColumn',
            'endLineNumber',
            'endColumn',
          ] as const;
          return keys.every((key) => typeof value[key] === 'number')
            ? {
                startLineNumber: value.startLineNumber as number,
                startColumn: value.startColumn as number,
                endLineNumber: value.endLineNumber as number,
                endColumn: value.endColumn as number,
              }
            : null;
        })()
      : null;

  return {
    clientId: typeof payload.clientId === 'number' ? payload.clientId : 0,
    name: payload.name,
    color: payload.color,
    cursor,
    selection,
    activeFileId: typeof payload.activeFileId === 'string' ? payload.activeFileId : null,
    lastActive: typeof payload.lastActive === 'number' ? payload.lastActive : Date.now(),
    isHost: Boolean(payload.isHost),
  };
}

/**
 * Owns the Yjs document lifecycle: WebRTC mesh, IndexedDB persistence and
 * awareness presence.
 *
 * The session object is created and destroyed outside React's render cycle; only
 * derived state (peers, connection state, stats) is mirrored into React so the
 * provider itself never triggers a re-render storm.
 */
export function useYjsCollaboration({
  roomId,
  enabled,
  signalingServers = DEFAULT_SIGNALING.servers,
}: UseYjsCollaborationOptions): UseYjsCollaborationResult {
  const [session, setSession] = useState<YjsCollaborationSession | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [peers, setPeers] = useState<PeerUser[]>([]);
  const [identity, setIdentity] = useState<LocalPeerIdentity | null>(null);
  const [stats, setStats] = useState<LanMeshStats | null>(null);
  const [logs, setLogs] = useState<LanLogEntry[]>([]);
  const [serverList, setServerList] = useState<string[]>(signalingServers);
  const [generation, setGeneration] = useState(0);

  const presenceRef = useRef<PeerUser | null>(null);
  const serverListRef = useRef(serverList);
  serverListRef.current = serverList;

  const appendLog = useCallback(
    (level: LanLogLevel, channel: LanLogEntry['channel'], message: string, detail?: string) => {
      logSequence += 1;
      const entry: LanLogEntry = {
        id: `log-${logSequence}`,
        timestamp: Date.now(),
        level,
        channel,
        message,
        detail,
      };
      setLogs((current) => [...current, entry].slice(-MAX_LOG_ENTRIES));
    },
    [],
  );

  const clearLogs = useCallback(() => setLogs([]), []);

  // ── session lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !roomId) return undefined;

    if (!supportsWebRTC()) {
      appendLog('warn', 'system', 'WebRTC is unavailable in this browser — collaboration is disabled');
      setConnectionState('offline');
      return undefined;
    }

    if (!isSignalingSupported()) {
      appendLog('warn', 'signaling', 'WebSocket is unavailable; relying on BroadcastChannel only');
    }

    appendLog(
      'info',
      'system',
      `Opening room “${roomId}”`,
      serverListRef.current.length > 0 ? serverListRef.current.join(', ') : 'BroadcastChannel only',
    );

    const created = createCollaborationSession(roomId, serverListRef.current);
    setSession(created);
    setConnectionState('connecting');

    const { webrtcProvider, idbPersistence } = created;

    const handlePeers = () => {
      const states = webrtcProvider.awareness.getStates();
      const remote: PeerUser[] = [];

      states.forEach((raw, clientId) => {
        // The local client is present in awareness too; it is not a peer.
        if (clientId === created.doc.clientID) return;
        const parsed = parsePeerState(raw);
        if (!parsed) return;
        remote.push({ ...parsed, clientId: parsed.clientId || clientId });
      });

      remote.sort((a, b) => b.lastActive - a.lastActive);
      setPeers(remote);
      setConnectionState(remote.length > 0 ? 'connected' : 'disconnected');
    };

    const handleStatus = (event: { connected: boolean }) => {
      if (event.connected) {
        appendLog('success', 'signaling', 'Signaling channel established');
        setConnectionState('connected');
        setStats((current) => (current ? { ...current, signalingConnected: true } : current));
      } else {
        appendLog('warn', 'signaling', 'Signaling channel closed — falling back to BroadcastChannel');
        setConnectionState('disconnected');
        setStats((current) => (current ? { ...current, signalingConnected: false } : current));
      }
    };

    const handlePersistence = (state: string) => {
      if (state === 'synced') {
        appendLog('success', 'persistence', 'IndexedDB persistence synced', created.persistenceName);
        setStats((current) =>
          current ? { ...current, persistenceSynced: true } : current,
        );
      }
    };

    webrtcProvider.on('peers', handlePeers);
    webrtcProvider.on('status', handleStatus);
    webrtcProvider.awareness.on('change', handlePeers);
    idbPersistence.on('synced', () => handlePersistence('synced'));

    const initialPeers = Math.max(0, webrtcProvider.awareness.getStates().size - 1);
    setStats({
      roomId,
      peerCount: initialPeers,
      signalingConnected: false,
      signalingServers: serverListRef.current,
      broadcastChannelSupported: typeof BroadcastChannel !== 'undefined',
      persistenceSynced: false,
      bytesSent: 0,
      bytesReceived: 0,
      updatedAt: Date.now(),
    });

    handlePeers();

    return () => {
      webrtcProvider.off('peers', handlePeers);
      webrtcProvider.off('status', handleStatus);
      webrtcProvider.awareness.off('change', handlePeers);
      created.destroy();
      setSession(null);
      setPeers([]);
      setConnectionState('offline');
    };
  }, [appendLog, enabled, generation, roomId]);

  // ── local identity + presence ────────────────────────────────────────────────
  useEffect(() => {
    if (!session) return;

    const localIdentity = resolveLocalIdentity(session.doc.clientID);
    const presence: PeerUser = {
      clientId: session.doc.clientID,
      name: localIdentity.name,
      color: localIdentity.color,
      cursor: null,
      selection: null,
      activeFileId: null,
      lastActive: Date.now(),
      isHost: (session.webrtcProvider.awareness.getStates().size ?? 0) <= 1,
    };

    presenceRef.current = presence;
    setIdentity(localIdentity);
    session.webrtcProvider.awareness.setLocalStateField('user', presence);
    appendLog('success', 'awareness', `Joined as ${presence.name}`, `client ${presence.clientId}`);

    // Presence expires if a peer closes its tab without a clean unload.
    const heartbeat = window.setInterval(() => {
      const current = presenceRef.current;
      if (!current) return;
      const refreshed = { ...current, lastActive: Date.now() };
      presenceRef.current = refreshed;
      session.webrtcProvider.awareness.setLocalStateField('user', refreshed);
    }, 15_000);

    return () => {
      window.clearInterval(heartbeat);
      session.webrtcProvider.awareness.setLocalStateField('user', null);
    };
  }, [appendLog, session]);

  const publishPresence = useCallback(
    (patch: Partial<Omit<PeerUser, 'clientId' | 'name' | 'color'>>) => {
      if (!session) return;
      const current = presenceRef.current;
      if (!current) return;

      const next: PeerUser = { ...current, ...patch, lastActive: Date.now() };
      presenceRef.current = next;
      session.webrtcProvider.awareness.setLocalStateField('user', next);
    },
    [session],
  );

  const renameSelf = useCallback(
    (name: string) => {
      if (!session) return;
      const trimmed = name.trim();
      if (trimmed.length === 0) return;

      const nextIdentity: LocalPeerIdentity = {
        clientId: session.doc.clientID,
        name: trimmed,
        color: presenceRef.current?.color ?? '#007acc',
      };
      saveLocalIdentity(nextIdentity);
      setIdentity(nextIdentity);

      if (presenceRef.current) {
        const next = { ...presenceRef.current, name: trimmed, lastActive: Date.now() };
        presenceRef.current = next;
        session.webrtcProvider.awareness.setLocalStateField('user', next);
      }
      appendLog('info', 'awareness', `Identity renamed to ${trimmed}`);
    },
    [appendLog, session],
  );

  const setSignalingServers = useCallback(
    (servers: string[]) => {
      setServerList(servers);
      appendLog('info', 'signaling', 'Signaling servers updated — rebuilding provider');
      setGeneration((value) => value + 1);
    },
    [appendLog],
  );

  const reconnect = useCallback(() => {
    appendLog('info', 'system', 'Manual reconnect requested');
    setGeneration((value) => value + 1);
  }, [appendLog]);

  const importSnapshot = useCallback(
    (update: Uint8Array) => {
      if (!session) return;
      try {
        // Applying an update is idempotent by design, so replays are safe.
        Y.applyUpdate(session.doc, update, 'snapshot-import');
        appendLog(
          'success',
          'persistence',
          `Imported snapshot (${update.byteLength.toLocaleString()} bytes)`,
        );
      } catch (importError) {
        appendLog(
          'error',
          'persistence',
          'Snapshot import failed',
          importError instanceof Error ? importError.message : String(importError),
        );
      }
    },
    [appendLog, session],
  );

  const connection = useMemo<RoomConnectionInfo>(
    () => ({
      roomId,
      connectionState,
      peerCount: peers.length + 1,
      signalingServers: serverList,
      webrtcSupported: supportsWebRTC(),
    }),
    [connectionState, peers.length, roomId, serverList],
  );

  useEffect(() => {
    setStats((current) =>
      current
        ? { ...current, peerCount: peers.length + 1, updatedAt: Date.now() }
        : current,
    );
  }, [peers.length]);

  return {
    doc: session?.doc ?? null,
    provider: session?.webrtcProvider ?? null,
    awareness: session?.webrtcProvider.awareness ?? null,
    identity,
    connection,
    peers,
    stats,
    logs,
    publishPresence,
    setSignalingServers,
    reconnect,
    renameSelf,
    importSnapshot,
    appendLog,
    clearLogs,
  };
}

/** Reads the `Y.Text` for a file, creating it on first access. */
export function useFileText(doc: YjsCollaborationSession['doc'] | null, fileId: string | null) {
  return useMemo(() => {
    if (!doc || !fileId) return null;
    return getFileText(doc, fileId);
  }, [doc, fileId]);
}

/** Wipes the persisted identity, forcing a fresh guest name on next load. */
export function resetLocalIdentity(): void {
  clearLocalIdentity();
}