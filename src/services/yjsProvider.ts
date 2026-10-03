import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { IndexeddbPersistence } from 'y-indexeddb';
import { DEFAULT_SIGNALING } from '@/services/signalingConfig';

export interface YjsCollaborationSession {
  doc: Y.Doc;
  webrtcProvider: WebrtcProvider;
  idbPersistence: IndexeddbPersistence;
  destroy: () => void;
}

export function createCollaborationSession(
  roomId: string,
  signalingServers: string[] = DEFAULT_SIGNALING.servers
): YjsCollaborationSession {
  const doc = new Y.Doc();

  const idbPersistence = new IndexeddbPersistence(`LANCodeCollab-crdt-${roomId}`, doc);

  const webrtcProvider = new WebrtcProvider(roomId, doc, {
    signaling: signalingServers,
    maxConns: 30,
    filterBcConns: true,
    peerOpts: {
      config: {
        iceServers: DEFAULT_SIGNALING.iceServers
      }
    }
  });

  return {
    doc,
    webrtcProvider,
    idbPersistence,
    destroy: () => {
      webrtcProvider.destroy();
      idbPersistence.destroy();
      doc.destroy();
    }
  };
}
