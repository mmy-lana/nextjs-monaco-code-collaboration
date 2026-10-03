import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { IndexeddbPersistence } from 'y-indexeddb';
import {
  DEFAULT_ICE_SERVERS,
  DEFAULT_SIGNALING,
  isSignalingSupported,
} from '@/services/signalingConfig';
import { supportsBroadcastChannel } from '@/utils/platform';

/**
 * Pure collaboration session factory.
 *
 * Deliberately free of React imports: the hook layer owns lifecycle, this
 * module owns the Yjs/WebRTC/IndexedDB objects. Keeping the two apart means the
 * session can be constructed inside a worker-like context or a test harness
 * without dragging the React runtime in.
 */

export interface YjsCollaborationSession {
  doc: Y.Doc;
  webrtcProvider: WebrtcProvider;
  idbPersistence: IndexeddbPersistence;
  /** IndexedDB database name backing this room. */
  persistenceName: string;
  destroyed: () => boolean;
  destroy: () => void;
}

/** Maximum simultaneous mesh connections before new peers are rejected. */
export const MAX_MESH_CONNECTIONS = 30;

export function getPersistenceName(roomId: string): string {
  return `LANCodeCollab-crdt-${roomId}`;
}

/**
 * Root key holding every file body. Each file lives in its own `Y.Text` so two
 * peers editing different files never contend on the same CRDT node.
 */
export const FILES_MAP_KEY = 'files';

export function createCollaborationSession(
  roomId: string,
  signalingServers: string[] = DEFAULT_SIGNALING.servers,
  iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS,
): YjsCollaborationSession {
  const doc = new Y.Doc();
  const persistenceName = getPersistenceName(roomId);

  // Namespaced to prevent conflict with the Dexie metadata database.
  const idbPersistence = new IndexeddbPersistence(persistenceName, doc);

  // An empty signaling list is meaningful: it keeps BroadcastChannel sync alive
  // (same-browser tabs) without opening any WebSocket that cannot connect.
  const webrtcProvider = new WebrtcProvider(roomId, doc, {
    signaling: signalingServers.filter((server) => isSignalingSupported() || server.startsWith('ws://')),
    maxConns: MAX_MESH_CONNECTIONS,
    filterBcConns: supportsBroadcastChannel(),
    peerOpts: {
      config: { iceServers },
    },
  });

  let destroyed = false;

  return {
    doc,
    webrtcProvider,
    idbPersistence,
    persistenceName,
    destroyed: () => destroyed,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      webrtcProvider.destroy();
      idbPersistence.destroy();
      doc.destroy();
    },
  };
}

/** The `Y.Text` backing a single virtual file. */
export function getFileText(doc: Y.Doc, fileId: string): Y.Text {
  const files = doc.getMap<Y.Text>(FILES_MAP_KEY);
  let text = files.get(fileId);
  if (!text) {
    text = new Y.Text();
    files.set(fileId, text);
  }
  return text;
}

/** Every file currently present in the CRDT document. */
export function listFileIds(doc: Y.Doc): string[] {
  return Array.from(doc.getMap<Y.Text>(FILES_MAP_KEY).keys());
}

/** Serialises the document into an update buffer suitable for export/import. */
export function encodeDocumentState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/** Applies an exported update buffer, returning the struct clocks it carried. */
export function applyDocumentState(doc: Y.Doc, update: Uint8Array): number {
  const before = Y.encodeStateVector(doc);
  Y.applyUpdate(doc, update);
  const after = Y.encodeStateVector(doc);
  const clocksBefore = Object.keys(before).length;
  const clocksAfter = Object.keys(after).length;
  return Math.max(0, clocksAfter - clocksBefore);
}