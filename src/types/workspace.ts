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
  deletedAt: number | null;
  size: number;
}

export interface VirtualFile extends VFSNode {
  type: 'file';
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
