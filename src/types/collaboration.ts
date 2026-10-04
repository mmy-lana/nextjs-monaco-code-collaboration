/**
 * Real-time collaboration domain model.
 *
 * These shapes describe data that travels between peers, so every field is
 * treated as untrusted input at the parse boundary (see `parsePeerState`).
 */

export interface PeerCursorPosition {
  line: number;
  column: number;
}

export interface PeerSelectionRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface PeerUser {
  clientId: number;
  name: string;
  color: string;
  cursor: PeerCursorPosition | null;
  selection: PeerSelectionRange | null;
  activeFileId: string | null;
  lastActive: number;
  isHost: boolean;
}

export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'disconnected';

/**
 * Which transport is actually carrying the CRDT right now.
 *
 * `ConnectionState` answers "are peers visible", which cannot distinguish an
 * air-gapped browser from a perfectly healthy room that is merely keeping its
 * peers on one machine. `local-mesh` is that healthy-but-offline case: no
 * signaling server is reachable, so no WebRTC mesh can form across machines,
 * but `BroadcastChannel` still carries every update between the tabs of this
 * browser. `unavailable` is the genuinely isolated case, where neither path
 * exists and edits stay local.
 */
export type TransportMode = 'webrtc' | 'local-mesh' | 'unavailable';

export interface SignalingConfig {
  servers: string[];
  iceServers: RTCIceServer[];
}

export interface RoomConnectionInfo {
  roomId: string;
  connectionState: ConnectionState;
  /** Transport actually in use; see {@link TransportMode}. */
  transportMode: TransportMode;
  peerCount: number;
  signalingServers: string[];
  webrtcSupported: boolean;
  /** `false` means peers on other machines cannot be reached at all. */
  broadcastChannelSupported: boolean;
}

/** Identity persisted in `localStorage` so a reload keeps the same name/colour. */
export interface LocalPeerIdentity {
  clientId: number;
  name: string;
  color: string;
}

/** A single line in the LAN debug console. */
export type LanLogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LanLogEntry {
  id: string;
  timestamp: number;
  level: LanLogLevel;
  channel: 'signaling' | 'webrtc' | 'persistence' | 'awareness' | 'system';
  message: string;
  detail?: string;
}

/** Live transport counters surfaced by the LAN debug console. */
export interface LanMeshStats {
  roomId: string;
  peerCount: number;
  signalingConnected: boolean;
  signalingServers: string[];
  broadcastChannelSupported: boolean;
  persistenceSynced: boolean;
  bytesSent: number;
  bytesReceived: number;
  updatedAt: number;
}

export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  offline: 'Offline',
  connecting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

/**
 * Status-bar wording, kept short enough for a 24px strip. The tooltip carries
 * the explanation.
 */
export const TRANSPORT_MODE_LABELS: Record<TransportMode, string> = {
  webrtc: 'WebRTC Mesh',
  'local-mesh': 'Local Mesh',
  unavailable: 'No Transport',
};

/** One line explaining what the current transport can and cannot reach. */
export const TRANSPORT_MODE_DETAILS: Record<TransportMode, string> = {
  webrtc: 'Signaling is up: peers can join this room from any device on the network.',
  'local-mesh':
    'Syncing across the tabs of this browser over BroadcastChannel. Peers on other devices cannot join until a signaling server is reachable.',
  unavailable:
    'No usable transport. This browser exposes neither WebRTC nor BroadcastChannel, so edits stay on this device.',
};