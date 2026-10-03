'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assessFileSize, getDB, MAX_FILE_CHARACTERS } from '@/db/schema';
import { detectLanguageByFilename } from '@/services/languageDetector';
import {
  isVirtualDirectory,
  isVirtualFile,
  sortVFSNodes,
  VFS_ROOT_PATH,
  type VFSNode,
  type VirtualDirectory,
  type VirtualFile,
  type WorkspaceMetadata,
} from '@/types/workspace';
import { detectLanguageByPath } from '@/services/languageDetector';
import { buildNodePath, generateNodeId, getFileExtension, getParentPath, renamePath, validateNodeName } from '@/utils/pathUtils';

/**
 * Virtual file system store.
 *
 * Dexie is the system of record for structure (nodes) and text content; the Yjs
 * document owns live editing state. Every mutation therefore has two halves:
 * a structural write, and (for file bodies) a CRDT write that the editor hook
 * mirrors into `contents.plainText` so full-text search works offline.
 */

export interface VFSMutationResult {
  ok: boolean;
  /** Human-readable failure reason; `null` on success. */
  error: string | null;
  node: VFSNode | null;
}

export interface UseVFSResult {
  workspace: WorkspaceMetadata | null;
  nodes: VFSNode[];
  files: VirtualFile[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  expandedIds: Set<string>;
  createFile: (parentId: string | null, name: string) => Promise<VFSMutationResult>;
  createDirectory: (parentId: string | null, name: string) => Promise<VFSMutationResult>;
  renameNode: (nodeId: string, nextName: string) => Promise<VFSMutationResult>;
  /** Soft-deletes a node (and its subtree), closing any tabs it owned. */
  deleteNode: (nodeId: string) => Promise<VFSMutationResult>;
  openFile: (fileId: string) => Promise<void>;
  closeFile: (fileId: string) => Promise<void>;
  toggleDirectory: (directoryId: string) => void;
  /** Persists a file body (used after CRDT updates, debounced by the caller). */
  saveFileContent: (fileId: string, plainText: string) => Promise<void>;
  loadFileContent: (fileId: string) => Promise<string>;
  reconcileTabs: () => Promise<void>;
  refresh: () => Promise<void>;
}

const DEFAULT_WORKSPACE_NAME = 'Main Workspace';
const DEFAULT_ROOM_ID = 'collab-workspace-lan';

const createNodeBase = (workspaceId: string, parentId: string | null, name: string, path: string, now: number) => ({
  workspaceId,
  parentId,
  name,
  path,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
});

const failure = (error: string): VFSMutationResult => ({ ok: false, error, node: null });

/**
 * Read-modify-write helper for the workspace row.
 *
 * Dexie's `Table.update` callback mutates in place and returns `void`, which
 * hides the previous value; working on a copy keeps the update explicit and
 * type-safe.
 */
export async function updateWorkspace(
  workspaceId: string,
  updater: (current: WorkspaceMetadata) => WorkspaceMetadata,
): Promise<WorkspaceMetadata | undefined> {
  const db = getDB();
  const current = await db.workspaces.get(workspaceId);
  if (!current) return undefined;

  const next = updater(current);
  await db.workspaces.put(next);
  return next;
}

/**
 * Ensures a workspace row exists, seeding one on first run.
 * Returns the workspace plus the file tree that should exist for a brand new
 * workspace, so the caller can seed starter content exactly once.
 */
export async function ensureWorkspace(
  workspaceId: string,
  name: string = DEFAULT_WORKSPACE_NAME,
  roomId: string = DEFAULT_ROOM_ID,
): Promise<{ workspace: WorkspaceMetadata; created: boolean }> {
  const db = getDB();
  const existing = await db.workspaces.get(workspaceId);

  if (existing) {
    if (existing.roomId !== roomId) {
      const updated: WorkspaceMetadata = { ...existing, roomId, updatedAt: Date.now() };
      await db.workspaces.put(updated);
      return { workspace: updated, created: false };
    }
    return { workspace: existing, created: false };
  }

  const workspace: WorkspaceMetadata = {
    id: workspaceId,
    name,
    roomId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeFileId: null,
    openFileIds: [],
  };

  await db.workspaces.put(workspace);
  return { workspace, created: true };
}

/** Starter tree written the first time a workspace is opened. */
export async function seedStarterFiles(workspaceId: string): Promise<string> {
  const db = getDB();
  const now = Date.now();

  const directory = (id: string, name: string, parentId: string | null, path: string): VirtualDirectory => ({
    id,
    ...createNodeBase(workspaceId, parentId, name, path, now),
    type: 'directory',
    language: 'plaintext',
    size: 0,
  });

  const file = (
    id: string,
    name: string,
    parentId: string | null,
    path: string,
    language: string,
    contentId: string,
  ): VirtualFile => ({
    id,
    ...createNodeBase(workspaceId, parentId, name, path, now),
    type: 'file',
    extension: getFileExtension(name),
    language,
    size: 0,
    contentId,
  });

  const nodes: VFSNode[] = [
    directory('dir-src', 'src', null, '/src'),
    file('file-readme', 'README.md', null, '/README.md', 'markdown', 'file-readme'),
    file(
      'file-welcome',
      'welcome.ts',
      'dir-src',
      '/src/welcome.ts',
      'typescript',
      'file-welcome',
    ),
  ];

  await db.nodes.bulkPut(nodes);

  const contents = [
    {
      contentId: 'file-readme',
      plainText: [
        '# LAN Code Collaboration',
        '',
        'This workspace is stored in your browser and synchronised peer-to-peer',
        'over WebRTC. No server ever sees your code.',
        '',
        '1. Open the same room ID in another browser on this LAN.',
        '2. Edit the same file in both windows.',
        '3. Watch the cursors and characters merge automatically.',
        '',
      ].join('\n'),
    },
    {
      contentId: 'file-welcome',
      plainText: [
        '/**',
        ' * Starter file. Edit freely — every keystroke is a CRDT operation.',
        ' * Peers in the same room receive it instantly, even offline first.',
        ' */',
        '',
        'export interface CollaborationSession {',
        '  roomId: string;',
        '  peerCount: number;',
        '  connectedAt: number;',
        '}',
        '',
        'export function describeSession(session: CollaborationSession): string {',
        '  const uptime = Math.round((Date.now() - session.connectedAt) / 1000);',
        "  return `${session.roomId}: ${session.peerCount} peer(s) online for ${uptime}s`;",
        '}',
        '',
      ].join('\n'),
    },
  ];

  await db.contents.bulkPut(
    contents.map((content) => ({
      contentId: content.contentId,
      binaryState: new Uint8Array(0),
      plainText: content.plainText,
      size: content.plainText.length,
      updatedAt: now,
    })),
  );

  await db.workspaces.update(workspaceId, {
    activeFileId: 'file-welcome',
    openFileIds: ['file-welcome'],
    updatedAt: now,
  });

  return 'file-welcome';
}

/**
 * Drops open tabs that point at nodes which no longer exist (deleted locally,
 * or removed by a peer). Called after every structural mutation and on load.
 */
export async function reconcileWorkspaceTabs(
  workspace: WorkspaceMetadata,
  liveNodes: readonly VFSNode[],
): Promise<{ workspace: WorkspaceMetadata; changed: boolean }> {
  const liveIds = new Set(liveNodes.filter((node) => node.deletedAt === null).map((node) => node.id));

  const openFileIds = workspace.openFileIds.filter((id) => liveIds.has(id));
  const activeFileId =
    workspace.activeFileId && liveIds.has(workspace.activeFileId)
      ? workspace.activeFileId
      : (openFileIds[0] ?? null);

  const changed =
    openFileIds.length !== workspace.openFileIds.length || activeFileId !== workspace.activeFileId;

  if (!changed) return { workspace, changed: false };

  const updated: WorkspaceMetadata = { ...workspace, openFileIds, activeFileId, updatedAt: Date.now() };
  await getDB().workspaces.put(updated);
  return { workspace: updated, changed: true };
}

export function useVFS(workspaceId: string): UseVFSResult {
  const [workspace, setWorkspace] = useState<WorkspaceMetadata | null>(null);
  const [nodes, setNodes] = useState<VFSNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const mountedRef = useRef(true);

  const loadNodes = useCallback(async (): Promise<VFSNode[]> => {
    const db = getDB();
    const stored = await db.nodes.where('workspaceId').equals(workspaceId).toArray();
    return stored.filter((node) => node.deletedAt === null);
  }, [workspaceId]);

  const refresh = useCallback(async () => {
    try {
      const live = await loadNodes();
      if (!mountedRef.current) return;
      setNodes(sortVFSNodes(live));
      setError(null);
    } catch (loadError) {
      if (!mountedRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [loadNodes]);

  useEffect(() => {
    mountedRef.current = true;

    const bootstrap = async () => {
      setLoading(true);
      try {
        const { workspace: ensured, created } = await ensureWorkspace(workspaceId);
        let live = await loadNodes();

        if (live.length === 0 && created) {
          await seedStarterFiles(workspaceId);
          live = await loadNodes();
        }

        // Re-read: seeding writes the initial tab set, so the object captured
        // before the seed no longer reflects what is on disk.
        const current = (await getDB().workspaces.get(workspaceId)) ?? ensured;
        const reconciled = await reconcileWorkspaceTabs(current, live);

        if (!mountedRef.current) return;
        setWorkspace(reconciled.workspace);
        setNodes(sortVFSNodes(live));
        setExpandedIds(
          new Set(live.filter((node) => isVirtualDirectory(node) && node.parentId === null).map((node) => node.id)),
        );
        setError(null);
      } catch (bootstrapError) {
        if (!mountedRef.current) return;
        setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    };

    void bootstrap();

    return () => {
      mountedRef.current = false;
    };
  }, [loadNodes, workspaceId]);

  const files = useMemo(() => nodes.filter(isVirtualFile), [nodes]);

  /** Writes structure, then re-reconciles tabs so a delete closes its editor. */
  const commitStructure = useCallback(
    async (mutate: () => Promise<VFSNode | null>): Promise<VFSMutationResult> => {
      setBusy(true);
      try {
        const node = await mutate();
        const live = await loadNodes();
        const current = await getDB().workspaces.get(workspaceId);
        if (current) await reconcileWorkspaceTabs(current, live);

        if (!mountedRef.current) return { ok: true, error: null, node };
        const sorted = sortVFSNodes(live);
        setNodes(sorted);

        const nextWorkspace = await getDB().workspaces.get(workspaceId);
        if (nextWorkspace && mountedRef.current) setWorkspace(nextWorkspace);

        return { ok: true, error: null, node };
      } catch (mutationError) {
        const message = mutationError instanceof Error ? mutationError.message : String(mutationError);
        if (mountedRef.current) setError(message);
        return failure(message);
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [loadNodes, workspaceId],
  );

  /**
   * Sibling lookup against Dexie rather than React state.
   *
   * Two mutations can be chained in a single tick (create a folder, then create
   * a file inside it), and the state snapshot would not contain the folder yet.
   */
  const findSiblingName = useCallback(
    async (parentId: string | null, name: string, excludeId?: string): Promise<boolean> => {
      const db = getDB();
      const candidates =
        parentId === null
          ? await db.nodes
              .where('workspaceId')
              .equals(workspaceId)
              .filter((node) => node.parentId === null && node.deletedAt === null)
              .toArray()
          : await db.nodes
              .where('parentId')
              .equals(parentId)
              .filter((node) => node.deletedAt === null)
              .toArray();

      return candidates.some(
        (node) => node.name.toLowerCase() === name.toLowerCase() && node.id !== excludeId,
      );
    },
    [workspaceId],
  );

  const createNode = useCallback(
    async (
      type: 'file' | 'directory',
      parentId: string | null,
      rawName: string,
    ): Promise<VFSMutationResult> => {
      const validation = validateNodeName(rawName);
      if (!validation.valid) return failure(validation.reason ?? 'Invalid name');

      const name = rawName.trim();
      if (await findSiblingName(parentId, name)) {
        return failure(`“${name}” already exists in this folder`);
      }

      // Read the parent from the database so back-to-back mutations resolve
      // against committed rows, not a stale render snapshot.
      const parentPath = parentId
        ? ((await getDB().nodes.get(parentId))?.path ?? VFS_ROOT_PATH)
        : VFS_ROOT_PATH;
      const path = buildNodePath(parentPath, name);
      const now = Date.now();
      const id = generateNodeId(type === 'file' ? 'file' : 'dir');

      return commitStructure(async () => {
        const db = getDB();

        if (type === 'file') {
          const assessment = assessFileSize('');
          if (!assessment.accepted) throw new Error(assessment.reason ?? 'File rejected');

          const fileNode: VirtualFile = {
            id,
            ...createNodeBase(workspaceId, parentId, name, path, now),
            type: 'file',
            extension: getFileExtension(name),
            language: detectLanguageByFilename(name),
            size: 0,
            contentId: id,
          };

          await db.transaction('rw', db.nodes, db.contents, async () => {
            await db.nodes.put(fileNode);
            await db.contents.put({
              contentId: id,
              binaryState: new Uint8Array(0),
              plainText: '',
              size: 0,
              updatedAt: now,
            });
          });

          // A newly created file opens immediately, matching editor convention.
          await updateWorkspace(workspaceId, (workspace) => ({
            ...workspace,
            openFileIds: workspace.openFileIds.includes(id)
              ? workspace.openFileIds
              : [...workspace.openFileIds, id],
            activeFileId: id,
            updatedAt: now,
          }));

          return fileNode;
        }

        const directoryNode: VirtualDirectory = {
          id,
          ...createNodeBase(workspaceId, parentId, name, path, now),
          type: 'directory',
          language: 'plaintext',
          size: 0,
        };

        await db.nodes.put(directoryNode);
        if (mountedRef.current) {
          setExpandedIds((current) => new Set(current).add(id));
        }

        return directoryNode;
      });
    },
    [commitStructure, findSiblingName, nodes, workspaceId],
  );

  const createFile = useCallback(
    (parentId: string | null, name: string) => createNode('file', parentId, name),
    [createNode],
  );

  const createDirectory = useCallback(
    (parentId: string | null, name: string) => createNode('directory', parentId, name),
    [createNode],
  );

  const renameNode = useCallback(
    async (nodeId: string, rawNextName: string): Promise<VFSMutationResult> => {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return failure('That file no longer exists');

      const validation = validateNodeName(rawNextName);
      if (!validation.valid) return failure(validation.reason ?? 'Invalid name');

      const nextName = rawNextName.trim();
      if (nextName === node.name) return { ok: true, error: null, node };
      if (await findSiblingName(node.parentId, nextName, nodeId)) {
        return failure(`“${nextName}” already exists in this folder`);
      }

      return commitStructure(async () => {
        const db = getDB();
        const nextPath = renamePath(node.path, nextName);
        const now = Date.now();

        // Descendants are re-parented by path rewrite, keeping the tree valid.
        const descendants = nodes.filter(
          (candidate) => candidate.path.startsWith(`${node.path}/`),
        );

        await db.transaction('rw', db.nodes, async () => {
          await db.nodes.update(nodeId, {
            name: nextName,
            path: nextPath,
            extension: isVirtualFile(node) ? getFileExtension(nextName) : undefined,
            language: isVirtualFile(node) ? detectLanguageByPath(nextPath) : node.language,
            updatedAt: now,
          });

          for (const descendant of descendants) {
            await db.nodes.update(descendant.id, {
              path: `${nextPath}${descendant.path.slice(node.path.length)}`,
              updatedAt: now,
            });
          }
        });

        return { ...node, name: nextName, path: nextPath };
      });
    },
    [commitStructure, findSiblingName, nodes],
  );

  const deleteNode = useCallback(
    async (nodeId: string): Promise<VFSMutationResult> => {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return failure('That file no longer exists');

      return commitStructure(async () => {
        const db = getDB();
        const now = Date.now();
        const descendants = nodes.filter(
          (candidate) => candidate.id === nodeId || candidate.path.startsWith(`${node.path}/`),
        );
        const doomed = descendants.map((candidate) => candidate.id);

        // Soft-delete first so every open editor can tear its Yjs binding down,
        // then wipe the rows once nothing references them.
        await db.transaction('rw', db.nodes, async () => {
          for (const id of doomed) {
            await db.nodes.update(id, { deletedAt: now, updatedAt: now });
          }
        });

        await db.nodes.bulkDelete(doomed);
        return node;
      });
    },
    [commitStructure, nodes],
  );

  const openFile = useCallback(
    async (fileId: string): Promise<void> => {
      const node = nodes.find((candidate) => candidate.id === fileId);
      if (!node || !isVirtualFile(node)) return;

      // Reveal every ancestor so the tree shows the file that just opened.
      const ancestors = new Set<string>();
      let parentId = node.parentId;
      while (parentId) {
        ancestors.add(parentId);
        parentId = nodes.find((candidate) => candidate.id === parentId)?.parentId ?? null;
      }
      if (ancestors.size > 0) {
        setExpandedIds((current) => {
          const next = new Set(current);
          for (const id of ancestors) next.add(id);
          return next;
        });
      }

      const updated = await updateWorkspace(workspaceId, (current) => ({
        ...current,
        openFileIds: [...new Set([...current.openFileIds, fileId])],
        activeFileId: fileId,
        updatedAt: Date.now(),
      }));

      if (mountedRef.current && updated) setWorkspace(updated);
    },
    [nodes, workspace?.openFileIds, workspaceId],
  );

  const closeFile = useCallback(
    async (fileId: string): Promise<void> => {
      const updated = await updateWorkspace(workspaceId, (current) => {
        const openFileIds = current.openFileIds.filter((id) => id !== fileId);
        return {
          ...current,
          openFileIds,
          activeFileId:
            current.activeFileId === fileId ? (openFileIds[0] ?? null) : current.activeFileId,
          updatedAt: Date.now(),
        };
      });

      if (mountedRef.current && updated) setWorkspace(updated);
    },
    [workspaceId],
  );

  const toggleDirectory = useCallback((directoryId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(directoryId)) next.delete(directoryId);
      else next.add(directoryId);
      return next;
    });
  }, []);

  const saveFileContent = useCallback(
    async (fileId: string, plainText: string): Promise<void> => {
      if (plainText.length > MAX_FILE_CHARACTERS) return;

      const db = getDB();
      const node = await db.nodes.get(fileId);
      if (!node || !isVirtualFile(node)) return;

      const now = Date.now();
      await db.transaction('rw', db.contents, db.nodes, async () => {
        await db.contents.update(node.contentId, {
          plainText,
          size: plainText.length,
          updatedAt: now,
        });
        await db.nodes.update(fileId, { size: plainText.length, updatedAt: now });
      });
    },
    [],
  );

  const loadFileContent = useCallback(async (fileId: string): Promise<string> => {
    const db = getDB();
    const node = await db.nodes.get(fileId);
    if (!node || !isVirtualFile(node)) return '';
    const content = await db.contents.get(node.contentId);
    return content?.plainText ?? '';
  }, []);

  const reconcileTabs = useCallback(async () => {
    const current = await getDB().workspaces.get(workspaceId);
    if (!current) return;
    const live = await loadNodes();
    const reconciled = await reconcileWorkspaceTabs(current, live);
    if (mountedRef.current) setWorkspace(reconciled.workspace);
  }, [loadNodes, workspaceId]);

  return {
    workspace,
    nodes,
    files,
    loading,
    busy,
    error,
    expandedIds,
    createFile,
    createDirectory,
    renameNode,
    deleteNode,
    openFile,
    closeFile,
    toggleDirectory,
    saveFileContent,
    loadFileContent,
    reconcileTabs,
    refresh,
  };
}

/** Convenience helper for the status bar: workspace-relative path of a node. */
export function getNodeDisplayPath(node: VFSNode): string {
  return node.path.startsWith(VFS_ROOT_PATH) ? node.path.slice(1) : node.path;
}

/** Convenience helper: does `path` sit inside the directory at `directoryPath`? */
export function isDirectChild(directoryPath: string, path: string): boolean {
  return getParentPath(path) === directoryPath;
}