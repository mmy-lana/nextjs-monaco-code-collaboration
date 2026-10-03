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

export interface SignalingConfig {
  servers: string[];
  iceServers: RTCIceServer[];
}

export interface RoomConnectionInfo {
  roomId: string;
  connectionState: ConnectionState;
  peerCount: number;
  signalingServers: string[];
  webrtcSupported: boolean;
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