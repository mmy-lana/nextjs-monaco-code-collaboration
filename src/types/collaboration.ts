export interface PeerUser {
  clientId: number;
  name: string;
  color: string;
  cursor: {
    line: number;
    column: number;
  } | null;
  selection: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
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
