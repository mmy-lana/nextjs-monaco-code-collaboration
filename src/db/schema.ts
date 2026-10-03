import Dexie, { type Table } from 'dexie';
import type { WorkspaceMetadata, VFSNode } from '@/types/workspace';

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_CHARACTERS = 500_000;

export interface StoredFileContent {
  contentId: string;
  /** Serialized Yjs document update buffer. */
  binaryState: Uint8Array;
  /** Fallback snapshot used for full-text search and cold starts. */
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
    // Namespaced explicitly to avoid collision with Y-IndexedDB ('LANCodeCollab-crdt-{roomId}')
    super('LANCodeCollab-meta');
    this.version(1).stores({
      workspaces: 'id, roomId, updatedAt',
      // NOTE: IndexedDB rejects `null` as a key, so rows with
      // `parentId === null` (workspace root) and `deletedAt === null` (live
      // nodes) are absent from those indexes. Both sets are derived with a
      // workspace-scoped `.filter(...)`, never with `where(...).equals(null)`.
      nodes: 'id, workspaceId, parentId, &path, type, language, deletedAt',
      contents: 'contentId, updatedAt, size',
      settings: 'key',
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

/** Releases the shared handle; the next `getDB()` call reopens lazily. */
export const closeDB = (): void => {
  if (!dbInstance) return;
  dbInstance.close();
  dbInstance = null;
};

/** Whether `indexedDB` is usable in the current runtime. */
export const isIndexedDBAvailable = (): boolean => {
  try {
    return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
  } catch {
    return false;
  }
};

export interface FileSizeAssessment {
  accepted: boolean;
  byteLength: number;
  characterLength: number;
  reason: string | null;
}

/**
 * Guard applied before any editor buffer is persisted, so a single oversized
 * paste cannot exhaust the browser storage quota for the whole workspace.
 */
export const assessFileSize = (text: string): FileSizeAssessment => {
  const characterLength = text.length;
  const byteLength = new Blob([text]).size;

  if (characterLength > MAX_FILE_CHARACTERS) {
    return {
      accepted: false,
      byteLength,
      characterLength,
      reason: `Document exceeds the ${MAX_FILE_CHARACTERS.toLocaleString()} character limit.`,
    };
  }

  if (byteLength > MAX_FILE_SIZE_BYTES) {
    return {
      accepted: false,
      byteLength,
      characterLength,
      reason: `Document exceeds the ${Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB storage limit.`,
    };
  }

  return { accepted: true, byteLength, characterLength, reason: null };
};

/** Human-readable byte size for the status bar and collaboration panel. */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
};

/** Builds a content snapshot row for the Dexie contents table. */
export const createStoredFileContent = (
  contentId: string,
  binaryState: Uint8Array,
  plainText: string,
  now: number = Date.now(),
): StoredFileContent => ({
  contentId,
  binaryState,
  plainText,
  size: plainText.length,
  updatedAt: now,
});