'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { WebrtcProvider } from 'y-webrtc';
import { createCollaborationSession, type YjsCollaborationSession } from '@/services/yjsProvider';
import { DEFAULT_SIGNALING, isSignalingSupported } from '@/services/signalingConfig';
import {
  type ConnectionState,
  type LanLogEntry,
  type LanLogLevel,
  type LanMeshStats,
  type LocalPeerIdentity,
  type PeerUser,
  type RoomConnectionInfo,
  type TransportMode,
} from '@/types/collaboration';
import {
  clearLocalIdentity,
  resolveLocalIdentity,
  saveLocalIdentity,
} from '@/utils/colorGenerator';
import { parsePeerState } from '@/hooks/useMonacoBinding';
import { supportsBroadcastChannel, supportsWebRTC } from '@/utils/platform';

/**
 * Awareness instance type, derived from the provider so `y-protocols` stays a
 * transitive dependency instead of a direct one.
 */
export type CollaborationAwareness = WebrtcProvider['awareness'];

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

/**
 * How often the signaling sockets are sampled.
 *
 * `WebsocketClient` emits `connect`/`disconnect` on its own observable, and
 * y-webrtc never forwards those to the provider, so there is no event to
 * subscribe to. Sampling a handful of booleans once a second is cheap and keeps
 * the reported transport within a second of reality.
 */
const SIGNALING_POLL_MS = 1000;

/**
 * Whether any configured signaling server is actually reachable.
 *
 * `WebrtcProvider.connected` is emphatically not that signal: it is
 * `room !== null && shouldConnect`, and the provider emits `status` exactly
 * once — from `connect()` — with `connected: true` whether or not a single
 * socket opened. Trusting it reported an unreachable signaling server as a
 * healthy WebRTC mesh. The per-server connection objects carry the real socket
 * state; `signalingConns` is public but untyped upstream.
 */
function isSignalingReachable(provider: WebrtcProvider): boolean {
  return provider.signalingConns.some(
    (connection) => (connection as { connected?: unknown }).connected === true,
  );
}

let logSequence = 0;

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
  const [signalingConnected, setSignalingConnected] = useState(false);
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

    /*
     * Signaling reachability is sampled from the sockets themselves. A local
     * variable guards the log so it fires once per transition rather than once
     * per poll, keeping the comparison outside the state updater where a side
     * effect does not belong.
     */
    let signalingReachable = false;
    const syncSignaling = () => {
      const reachable = isSignalingReachable(webrtcProvider);
      if (reachable === signalingReachable) return;
      signalingReachable = reachable;
      setSignalingConnected(reachable);
      setStats((current) => (current ? { ...current, signalingConnected: reachable } : current));
      appendLog(
        reachable ? 'success' : 'warn',
        'signaling',
        reachable
          ? 'Signaling channel established'
          : 'Signaling channel closed — falling back to BroadcastChannel',
      );
    };

    const handleStatus = () => {
      /*
       * `status` fires from connect()/disconnect() only. Re-reading the sockets
       * here makes the reported transport correct the moment a manual reconnect
       * finishes, instead of up to a poll interval later.
       */
      syncSignaling();
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

    /*
     * Sampled after the initial stats are seeded, so an already-reachable
     * signaling server is not overwritten a tick later by the default `false`.
     */
    syncSignaling();
    const signalingPoll = window.setInterval(syncSignaling, SIGNALING_POLL_MS);

    return () => {
      window.clearInterval(signalingPoll);
      webrtcProvider.off('peers', handlePeers);
      webrtcProvider.off('status', handleStatus);
      webrtcProvider.awareness.off('change', handlePeers);
      created.destroy();
      setSession(null);
      setPeers([]);
      setSignalingConnected(false);
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

  /*
   * Transport in use, as opposed to connection state.
   *
   * y-webrtc always layers a BroadcastChannel underneath its WebRTC mesh: when
   * signaling cannot be reached, the tabs of one browser still exchange CRDT
   * updates with each other. Reporting that as "Disconnected" was actively
   * misleading — sync was working, only the path across machines was not. The
   * three modes keep "no peers yet" (normal), "peers only inside this browser"
   * (local mesh) and "this browser cannot reach anything" apart.
   */
  const transportMode = useMemo<TransportMode>(() => {
    if (!session) return 'unavailable';
    if (signalingConnected) return 'webrtc';
    return supportsBroadcastChannel() ? 'local-mesh' : 'unavailable';
  }, [session, signalingConnected]);

  // Narrate every transport change in the LAN console: this is the first place
  // a user looks when two devices refuse to see each other.
  useEffect(() => {
    if (!session) return;
    appendLog(
      transportMode === 'webrtc' ? 'success' : 'info',
      'webrtc',
      `Transport: ${transportMode}`,
      transportMode === 'local-mesh'
        ? 'WebRTC signaling is unreachable; same-browser tabs still sync'
        : undefined,
    );
  }, [appendLog, session, transportMode]);

  const connection = useMemo<RoomConnectionInfo>(
    () => ({
      roomId,
      connectionState,
      transportMode,
      peerCount: peers.length + 1,
      signalingServers: serverList,
      webrtcSupported: supportsWebRTC(),
      broadcastChannelSupported: supportsBroadcastChannel(),
    }),
    [connectionState, peers.length, roomId, serverList, transportMode],
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

/** Wipes the persisted identity, forcing a fresh guest name on next load. */
export function resetLocalIdentity(): void {
  clearLocalIdentity();
}