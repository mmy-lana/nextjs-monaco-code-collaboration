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
import { buildNodePath, generateNodeId, getFileExtension, renamePath, validateNodeName } from '@/utils/pathUtils';

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
  /**
   * Persists a file body. Returns a failure result instead of throwing so the
   * caller can surface storage-limit errors to the user.
   */
  saveFileContent: (fileId: string, plainText: string) => Promise<VFSMutationResult>;
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
 * Dexie surfaces a duplicate-key insert as a `ConstraintError`. It is the only
 * failure mode `Table.add` raises that another bootstrap legitimately wins.
 */
const isConstraintError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ConstraintError';

/**
 * Keeps a stored workspace's room in step with the room the caller joined.
 *
 * Only the two fields that actually differ are written, so a late-arriving
 * bootstrap cannot roll back an `openFileIds` array that another tab has since
 * populated.
 */
const adoptRoomId = async (
  workspace: WorkspaceMetadata,
  roomId: string,
): Promise<WorkspaceMetadata> => {
  if (workspace.roomId === roomId) return workspace;

  const updated: WorkspaceMetadata = { ...workspace, roomId, updatedAt: Date.now() };
  await getDB().workspaces.update(workspace.id, { roomId, updatedAt: updated.updatedAt });
  return updated;
};

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
 * Returns the workspace plus a `created` flag reporting whether this call was the
 * one that inserted the row.
 *
 * The insert is raced through `add` rather than `put`. Two bootstraps can run
 * concurrently — React StrictMode double-mounts the effect, and an HMR reload
 * can land while the previous boot is still awaiting IndexedDB — and both can
 * observe "no workspace". With `put`, the loser would write its pristine
 * bootstrap record over the winner's row, silently discarding the starter tab
 * the winner had already opened. `add` refuses the duplicate instead, so the
 * loser re-reads the committed row and carries on from there.
 */
export async function ensureWorkspace(
  workspaceId: string,
  name: string = DEFAULT_WORKSPACE_NAME,
  roomId: string = DEFAULT_ROOM_ID,
): Promise<{ workspace: WorkspaceMetadata; created: boolean }> {
  const db = getDB();
  const existing = await db.workspaces.get(workspaceId);

  if (existing) {
    return { workspace: await adoptRoomId(existing, roomId), created: false };
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

  try {
    await db.workspaces.add(workspace);
    return { workspace, created: true };
  } catch (insertError) {
    // A concurrent bootstrap committed the row between the read and this
    // insert. Any other failure is a genuine storage fault and must surface.
    if (!isConstraintError(insertError)) throw insertError;

    const concurrent = await db.workspaces.get(workspaceId);
    if (!concurrent) throw insertError;

    return { workspace: await adoptRoomId(concurrent, roomId), created: false };
  }
}

/**
 * Writes the starter tree and returns the id of the file that should be opened.
 *
 * Idempotent by design: the node ids and paths are fixed, so re-running this
 * against a workspace whose rows were tombstoned or lost revives them rather
 * than duplicating the tree. Tab state is deliberately not touched here — the
 * caller reconciles it, which is the only place that knows whether the user's
 * tab set is worth keeping.
 */
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

  try {
    await db.nodes.bulkPut(nodes);
  } catch (seedError) {
    /*
     * `path` carries a unique index across the whole database, so a starter
     * path already owned by another workspace cannot be written here. That is a
     * real, unrecoverable state for this schema rather than a transient fault,
     * so it is reported instead of leaving the caller to decode a bare
     * ConstraintError.
     */
    throw new Error(
      isConstraintError(seedError)
        ? 'Starter files could not be seeded: their paths are already claimed by another workspace.'
        : `Starter files could not be seeded: ${
            seedError instanceof Error ? seedError.message : String(seedError)
          }`,
    );
  }

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

  return 'file-welcome';
}

export interface TabReconcileOptions {
  /**
   * Preferred file to open when reconciliation empties the tab strip, used to
   * reopen the starter file right after a re-seed. Ignored when it is not a
   * live node.
   */
  preferFileId?: string | null;
  /**
   * Open the first live file when reconciliation empties the tab strip.
   *
   * This is what rescues a workspace that has files on disk but nothing open —
   * every tab closed, or an interrupted load that committed an empty tab set.
   * Without it the editor binds to nothing and the screen reads as a dead
   * canvas. It is off during ordinary structural mutations, where the mutation
   * itself owns which tab should be active; enabling it there would yank the
   * user into an unrelated file whenever they created a folder.
   */
  autoOpenFirstFile?: boolean;
}

/** First live file in tree order: directories first, then natural name order. */
function firstLiveFileId(liveNodes: readonly VFSNode[]): string | null {
  const candidate = sortVFSNodes(liveNodes.filter((node) => node.deletedAt === null)).find(
    isVirtualFile,
  );
  return candidate?.id ?? null;
}

/**
 * Drops open tabs that point at nodes which no longer exist (deleted locally,
 * or removed by a peer). Called after every structural mutation and on load.
 *
 * A reconciliation that empties the tab strip can also rescue the workspace: a
 * file is opened when one was requested and is live, and otherwise when
 * `autoOpenFirstFile` is set and any live file exists. Without that, a workspace
 * whose files exist but whose tab set is empty — every tab closed, or an
 * interrupted load — strands the editor on nothing.
 */
export async function reconcileWorkspaceTabs(
  workspace: WorkspaceMetadata,
  liveNodes: readonly VFSNode[],
  options: TabReconcileOptions = {},
): Promise<{ workspace: WorkspaceMetadata; changed: boolean }> {
  const liveIds = new Set(liveNodes.filter((node) => node.deletedAt === null).map((node) => node.id));

  let openFileIds = workspace.openFileIds.filter((id) => liveIds.has(id));

  if (openFileIds.length === 0) {
    const preferred =
      options.preferFileId && liveIds.has(options.preferFileId) ? options.preferFileId : null;
    const rescued = preferred ?? (options.autoOpenFirstFile ? firstLiveFileId(liveNodes) : null);
    if (rescued) openFileIds = [rescued];
  }

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

/** Every live (non-tombstoned) node in a workspace, straight from Dexie. */
async function readLiveNodes(workspaceId: string): Promise<VFSNode[]> {
  const stored = await getDB().nodes.where('workspaceId').equals(workspaceId).toArray();
  return stored.filter((node) => node.deletedAt === null);
}

interface BootstrapOutcome {
  workspace: WorkspaceMetadata;
  nodes: VFSNode[];
}

/**
 * Ensures the workspace row and the starter tree exist, and reconciles the tabs.
 *
 * The starter tree is a function of the *tree*, not of whether this particular
 * call created the workspace row. Gating it on the creation flag stranded the
 * workspace permanently whenever the two were separated by a reload: a fresh
 * origin (a second loopback address, a LAN IP) has its own IndexedDB partition,
 * and an interrupted first load — a closed tab mid-seed, an HMR reload — commits
 * the workspace row before the nodes. Either way the next load found
 * `created === false` next to an empty tree and never seeded again, leaving no
 * nodes, no tab and an editor bound to nothing. Emptiness is the only signal
 * that needs recovering from.
 */
async function bootstrapWorkspace(workspaceId: string): Promise<BootstrapOutcome> {
  const db = getDB();
  const { workspace: ensured } = await ensureWorkspace(workspaceId);
  let live = await readLiveNodes(workspaceId);

  let starterFileId: string | null = null;
  if (live.length === 0) {
    starterFileId = await seedStarterFiles(workspaceId);
    live = await readLiveNodes(workspaceId);
  }

  /*
   * Re-read the row: seeding writes it, and so does any other tab sharing this
   * origin, so the object captured before either no longer reflects disk.
   */
  const current = (await db.workspaces.get(workspaceId)) ?? ensured;
  const reconciled = await reconcileWorkspaceTabs(current, live, {
    preferFileId: starterFileId,
    autoOpenFirstFile: true,
  });

  return { workspace: reconciled.workspace, nodes: live };
}

/**
 * Bootstrap promises in flight, keyed by workspace.
 *
 * Two bootstraps for one workspace race, and the loser used to win the tab
 * decision by accident. React's StrictMode double-invokes effects in
 * development, so this is not a theoretical case: the second pass observed a
 * tree the first pass had already seeded, concluded that no starter file was
 * needed, and opened the alphabetically first file instead of the intended
 * one — leaving development behaving differently from a production build.
 * Sharing one promise per workspace makes the outcome deterministic and does the
 * work once. The entry is dropped as soon as it settles, so a later mount always
 * re-reads current state.
 */
const bootstrapInFlight = new Map<string, Promise<BootstrapOutcome>>();

function runWorkspaceBootstrap(workspaceId: string): Promise<BootstrapOutcome> {
  const existing = bootstrapInFlight.get(workspaceId);
  if (existing) return existing;

  const pending = bootstrapWorkspace(workspaceId).finally(() => {
    if (bootstrapInFlight.get(workspaceId) === pending) {
      bootstrapInFlight.delete(workspaceId);
    }
  });

  bootstrapInFlight.set(workspaceId, pending);
  return pending;
}

export function useVFS(workspaceId: string): UseVFSResult {
  const [workspace, setWorkspace] = useState<WorkspaceMetadata | null>(null);
  const [nodes, setNodes] = useState<VFSNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const mountedRef = useRef(true);

  const loadNodes = useCallback(() => readLiveNodes(workspaceId), [workspaceId]);

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
    setLoading(true);

    void runWorkspaceBootstrap(workspaceId)
      .then(({ workspace: bootstrapped, nodes: live }) => {
        if (!mountedRef.current) return;
        setWorkspace(bootstrapped);
        setNodes(sortVFSNodes(live));
        setExpandedIds(
          new Set(
            live
              .filter((node) => isVirtualDirectory(node) && node.parentId === null)
              .map((node) => node.id),
          ),
        );
        setError(null);
      })
      .catch((bootstrapError: unknown) => {
        if (!mountedRef.current) return;
        setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });

    return () => {
      mountedRef.current = false;
    };
  }, [workspaceId]);

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

        /*
         * Teardown ordering matters. Tombstoning first stops the tree, the tab
         * strip and the search index from resolving the node; closing the tabs
         * that referenced it then unmounts their Monaco models and CRDT
         * bindings; only once nothing can still write is the row physically
         * removed. Purging earlier leaves live bindings writing to rows that no
         * longer exist.
         */
        await db.transaction('rw', db.nodes, async () => {
          for (const id of doomed) {
            await db.nodes.update(id, { deletedAt: now, updatedAt: now });
          }
        });

        const currentWorkspace = await db.workspaces.get(workspaceId);
        if (currentWorkspace) {
          /*
           * Reconciliation needs the full node set: the doomed rows are marked
           * tombstoned in place, so every other node is passed through live.
           * Passing only the doomed rows would look like an empty workspace and
           * close every open tab.
           */
          const doomedSet = new Set(doomed);
          await reconcileWorkspaceTabs(
            currentWorkspace,
            nodes.map((entry) =>
              doomedSet.has(entry.id) ? { ...entry, deletedAt: now } : entry,
            ),
          );
        }

        // Give the React commit that unmounts the editor models a chance to run
        // before their rows disappear.
        await new Promise((resolve) => setTimeout(resolve, 0));

        await db.nodes.bulkDelete(doomed);
        return node;
      });
    },
    [commitStructure, nodes, workspaceId],
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
    async (fileId: string, plainText: string): Promise<VFSMutationResult> => {
      /*
       * Oversized documents are rejected loudly. Returning silently here would
       * let the in-memory buffer and the persisted snapshot diverge without any
       * signal that edits were being dropped.
       */
      const assessment = assessFileSize(plainText);
      if (!assessment.accepted) {
        const reason =
          assessment.reason ??
          `Document exceeds the ${MAX_FILE_CHARACTERS.toLocaleString()} character limit.`;
        return failure(reason);
      }

      const db = getDB();
      const node = await db.nodes.get(fileId);
      if (!node) return failure('That file no longer exists');
      if (!isVirtualFile(node)) return failure('Only files can hold content');

      const now = Date.now();

      try {
        await db.transaction('rw', db.contents, db.nodes, async () => {
          await db.contents.update(node.contentId, {
            plainText,
            size: plainText.length,
            updatedAt: now,
          });
          await db.nodes.update(fileId, { size: plainText.length, updatedAt: now });
        });
      } catch (writeError) {
        return failure(
          writeError instanceof Error ? writeError.message : String(writeError),
        );
      }

      return { ok: true, error: null, node };
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
    // An imported snapshot can land with files but no tabs; open the first one
    // so the editor is never left bound to nothing.
    const reconciled = await reconcileWorkspaceTabs(current, live, { autoOpenFirstFile: true });
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
