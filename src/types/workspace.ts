/**
 * Virtual file system domain model.
 *
 * Every entry in the workspace is a `VFSNode`. Directories hold no content of
 * their own; their children are always derived query-side via
 * `db.nodes.where('parentId').equals(dir.id)`, which keeps a single source of
 * truth for the tree shape.
 */

export type FileType = 'file' | 'directory';

export interface VFSNode {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  type: FileType;
  path: string;
  extension?: string;
  language: string;
  createdAt: number;
  updatedAt: number;
  /** Soft-delete tombstone: bindings are torn down before the row is wiped. */
  deletedAt: number | null;
  size: number;
}

export interface VirtualFile extends VFSNode {
  type: 'file';
  /** Reference key for the Yjs `Y.Text` fragment and the Dexie content table. */
  contentId: string;
}

export interface VirtualDirectory extends VFSNode {
  type: 'directory';
}

export function isVirtualFile(node: VFSNode): node is VirtualFile {
  return node.type === 'file';
}

export function isVirtualDirectory(node: VFSNode): node is VirtualDirectory {
  return node.type === 'directory';
}

/** True when a node has been tombstoned (soft-deleted) and must not be rendered. */
export function isNodeDeleted(node: VFSNode): boolean {
  return node.deletedAt !== null;
}

/** The workspace root directory always lives at the filesystem root path. */
export const VFS_ROOT_PATH = '/';

/**
 * Sibling ordering used by every tree surface: directories first, then files,
 * each group sorted with a locale-aware numeric collation so `file2` precedes
 * `file10`.
 */
export function sortVFSNodes(nodes: readonly VFSNode[]): VFSNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
  });
}

export interface WorkspaceMetadata {
  id: string;
  name: string;
  roomId: string;
  encryptionKey?: string;
  createdAt: number;
  updatedAt: number;
  activeFileId: string | null;
  openFileIds: string[];
}

export function isWorkspaceMetadata(value: unknown): value is WorkspaceMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.roomId === 'string' &&
    Array.isArray(candidate.openFileIds)
  );
}

/** A workspace with nothing opened yet — used as the creation template. */
export function createEmptyWorkspace(
  id: string,
  name: string,
  roomId: string,
  now: number = Date.now(),
): WorkspaceMetadata {
  return {
    id,
    name,
    roomId,
    createdAt: now,
    updatedAt: now,
    activeFileId: null,
    openFileIds: [],
  };
}