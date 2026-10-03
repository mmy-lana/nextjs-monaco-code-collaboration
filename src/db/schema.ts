import Dexie, { type Table } from 'dexie';
import type { WorkspaceMetadata, VFSNode } from '@/types/workspace';

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_CHARACTERS = 500_000;

export interface StoredFileContent {
  contentId: string;
  binaryState: Uint8Array;
  plainText: string;
  size: number;
  updatedAt: number;
}

export interface StoredSetting {
  key: string;
  value: unknown;
}

export class LocalWorkspaceDB extends Dexie {
  workspaces!: Table<WorkspaceMetadata, string>;
  nodes!: Table<VFSNode, string>;
  contents!: Table<StoredFileContent, string>;
  settings!: Table<StoredSetting, string>;

  constructor() {
    super('LANCodeCollab-meta');
    this.version(1).stores({
      workspaces: 'id, roomId, updatedAt',
      nodes: 'id, workspaceId, parentId, &path, type, language, deletedAt',
      contents: 'contentId, updatedAt, size',
      settings: 'key'
    });
  }
}

let dbInstance: LocalWorkspaceDB | null = null;

export const getDB = (): LocalWorkspaceDB => {
  if (typeof window === 'undefined') {
    throw new Error('LocalWorkspaceDB can only be instantiated in client-side runtime');
  }
  if (!dbInstance) {
    dbInstance = new LocalWorkspaceDB();
  }
  return dbInstance;
};
