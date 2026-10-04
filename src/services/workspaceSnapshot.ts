import type {
  VFSNode,
  VirtualDirectory,
  VirtualFile,
  WorkspaceMetadata,
} from '@/types/workspace';
import { MAX_FILE_CHARACTERS } from '@/db/schema';
import { normalizePath, validateNodeName } from '@/utils/pathUtils';

/**
 * Workspace snapshot codec.
 *
 * Snapshots are user-supplied files that may have been produced by another
 * installation, edited by hand, or crafted maliciously. Everything is therefore
 * validated structurally before a single row reaches Dexie or a single byte
 * reaches `Y.applyUpdate`: a malformed node could otherwise poison the unique
 * `path` index, and an arbitrary update buffer can permanently wedge a CRDT that
 * peers have already merged.
 */

export const SNAPSHOT_FORMAT = 'lancodecollab/workspace';
export const SNAPSHOT_VERSION = 1;

/** Upper bound on a snapshot's CRDT payload, mirroring the content limit. */
export const MAX_SNAPSHOT_CRD_BYTES = 16 * 1024 * 1024;

/** Upper bound on structural entries, so a crafted file cannot exhaust memory. */
export const MAX_SNAPSHOT_ENTRIES = 20_000;

/** Deepest directory nesting accepted from an imported snapshot. */
export const MAX_SNAPSHOT_DEPTH = 64;

export interface WorkspaceSnapshot {
  format: string;
  version: number;
  exportedAt: string;
  workspace: WorkspaceMetadata | null;
  nodes: VFSNode[];
  contents: { contentId: string; plainText: string; updatedAt: number }[];
  crdt: number[] | null;
}

export type SnapshotValidationResult =
  | {
      ok: true;
      snapshot: WorkspaceSnapshot;
      /** Entries dropped because they failed validation. */
      rejected: string[];
    }
  | { ok: false; error: string; rejected: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A node whose scalar fields passed validation but whose path is not resolved yet. */
interface PendingNode {
  id: string;
  parentId: string | null;
  name: string;
  type: 'file' | 'directory';
  language: string;
  extension?: string;
  contentId: string;
  createdAt: number;
  updatedAt: number;
  size: number;
}

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 255;

/**
 * Validates the scalar fields of a node.
 *
 * `path` is deliberately absent: snapshots store a flat parent graph, so the
 * path has to be rebuilt from `parentId` links by the caller. Trusting a stored
 * path would let a crafted file point two nodes at the same unique key.
 */
function validateNodeFields(
  candidate: unknown,
  workspaceId: string,
): PendingNode | string {
  if (!isRecord(candidate)) return 'node is not an object';

  const { id, name, type } = candidate;

  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
    return 'node id must be a non-empty string of at most 128 characters';
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return `node ${id} has an invalid name`;
  }
  if (type !== 'file' && type !== 'directory') return `node ${id} has an unknown type`;
  if (candidate.workspaceId !== workspaceId) {
    return `node ${id} belongs to a different workspace`;
  }
  if (candidate.parentId !== null && typeof candidate.parentId !== 'string') {
    return `node ${id} has an invalid parent`;
  }

  const nameCheck = validateNodeName(name);
  if (!nameCheck.valid) return `node ${id} has an invalid name: ${nameCheck.reason}`;

  return {
    id,
    parentId: (candidate.parentId as string | null) ?? null,
    name,
    type,
    createdAt: isFiniteNumber(candidate.createdAt) ? candidate.createdAt : Date.now(),
    updatedAt: isFiniteNumber(candidate.updatedAt) ? candidate.updatedAt : Date.now(),
    size:
      isFiniteNumber(candidate.size) && candidate.size >= 0
        ? Math.trunc(candidate.size)
        : 0,
    language: type === 'directory' ? 'plaintext' : typeof candidate.language === 'string' ? candidate.language : 'plaintext',
    extension: typeof candidate.extension === 'string' ? candidate.extension : undefined,
    contentId:
      typeof candidate.contentId === 'string' && candidate.contentId.length > 0
        ? candidate.contentId
        : id,
  };
}

/**
 * Resolves a node's absolute path by walking `parentId` links.
 *
 * The result is tagged rather than a bare string: a resolved path *is* a
 * string, so returning one would be indistinguishable from an error message.
 * Dangling parents and cycles — which would otherwise hang the import or build
 * a path from an unbounded chain — are reported instead.
 */
function resolveNodePath(
  node: PendingNode,
  byId: ReadonlyMap<string, PendingNode>,
): { path: string } | { error: string } {
  const segments = [node.name];
  const visited = new Set<string>([node.id]);
  let parentId = node.parentId;

  while (parentId !== null) {
    if (segments.length > MAX_SNAPSHOT_DEPTH) {
      return { error: `node ${node.id} exceeds the maximum nesting depth` };
    }
    if (visited.has(parentId)) {
      return { error: `node ${node.id} has a cyclic parent chain` };
    }
    visited.add(parentId);

    const parent = byId.get(parentId);
    if (!parent) return { error: `node ${node.id} references a missing parent` };

    segments.unshift(parent.name);
    parentId = parent.parentId;
  }

  return { path: normalizePath(`/${segments.join('/')}`) };
}

function toVFSNode(pending: PendingNode, workspaceId: string, path: string): VFSNode {
  const base = {
    id: pending.id,
    workspaceId,
    parentId: pending.parentId,
    name: pending.name,
    path,
    createdAt: pending.createdAt,
    updatedAt: pending.updatedAt,
    // Tombstones are not meaningful in a snapshot: an import must never
    // resurrect a deleted node into the live tree.
    deletedAt: null,
    size: pending.size,
  };

  if (pending.type === 'directory') {
    return { ...base, type: 'directory', language: 'plaintext' } satisfies VirtualDirectory;
  }

  const file: VirtualFile = {
    ...base,
    type: 'file',
    extension: pending.extension,
    language: pending.language,
    contentId: pending.contentId,
  };

  return file;
}

function validateContent(
  candidate: unknown,
  allowedContentIds: ReadonlySet<string>,
): { contentId: string; plainText: string; updatedAt: number } | string {
  if (!isRecord(candidate)) return 'content entry is not an object';

  const { contentId, plainText } = candidate;
  if (typeof contentId !== 'string' || !allowedContentIds.has(contentId)) {
    return 'content entry does not belong to any imported file';
  }
  if (typeof plainText !== 'string') return `content ${contentId} has no text`;
  if (plainText.length > MAX_FILE_CHARACTERS) {
    return `content ${contentId} exceeds the ${MAX_FILE_CHARACTERS.toLocaleString()} character limit`;
  }

  return {
    contentId,
    plainText,
    updatedAt: isFiniteNumber(candidate.updatedAt) ? candidate.updatedAt : Date.now(),
  };
}

function validateWorkspace(candidate: unknown): WorkspaceMetadata | null {
  if (!isRecord(candidate)) return null;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return null;
  if (typeof candidate.roomId !== 'string') return null;
  if (!Array.isArray(candidate.openFileIds)) return null;
  if (candidate.openFileIds.some((value) => typeof value !== 'string')) return null;

  return {
    id: candidate.id,
    name: candidate.name,
    roomId: candidate.roomId,
    createdAt: isFiniteNumber(candidate.createdAt) ? candidate.createdAt : Date.now(),
    updatedAt: isFiniteNumber(candidate.updatedAt) ? candidate.updatedAt : Date.now(),
    activeFileId: typeof candidate.activeFileId === 'string' ? candidate.activeFileId : null,
    openFileIds: candidate.openFileIds as string[],
  };
}

function validateCrdt(candidate: unknown): number[] | null | string {
  if (candidate === null || candidate === undefined) return null;
  if (!Array.isArray(candidate)) return 'crdt payload is not an array';

  if (candidate.length > MAX_SNAPSHOT_CRD_BYTES) {
    return 'crdt payload exceeds the maximum size';
  }

  const bytes = new Uint8Array(candidate.length);
  for (let index = 0; index < candidate.length; index += 1) {
    const byte = candidate[index];
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return 'crdt payload contains a non-byte value';
    }
    bytes[index] = byte;
  }

  return Array.from(bytes);
}

/**
 * Parses and validates an untrusted snapshot payload.
 *
 * Structural entries that fail validation are dropped and reported rather than
 * aborting the import: a single malformed row should not cost the user the rest
 * of their workspace. The CRDT buffer is all-or-nothing, because a partially
 * applied update would leave the document permanently inconsistent.
 */
export function parseWorkspaceSnapshot(
  raw: unknown,
  workspaceId: string,
): SnapshotValidationResult {
  const rejected: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, error: 'snapshot is not an object', rejected };
  }
  if (raw.format !== SNAPSHOT_FORMAT) {
    return { ok: false, error: 'unrecognised snapshot format', rejected };
  }
  if (raw.version !== SNAPSHOT_VERSION) {
    return { ok: false, error: `unsupported snapshot version ${String(raw.version)}`, rejected };
  }
  if (!Array.isArray(raw.nodes)) {
    return { ok: false, error: 'snapshot has no nodes array', rejected };
  }
  if (raw.contents !== undefined && !Array.isArray(raw.contents)) {
    return { ok: false, error: 'snapshot contents must be an array', rejected };
  }
  if (
    raw.nodes.length > MAX_SNAPSHOT_ENTRIES ||
    (Array.isArray(raw.contents) && raw.contents.length > MAX_SNAPSHOT_ENTRIES)
  ) {
    return { ok: false, error: 'snapshot exceeds the maximum entry count', rejected };
  }

  const pendingNodes: PendingNode[] = [];
  const byId = new Map<string, PendingNode>();

  for (const candidate of raw.nodes) {
    const validated = validateNodeFields(candidate, workspaceId);
    if (typeof validated === 'string') {
      rejected.push(validated);
      continue;
    }
    if (byId.has(validated.id)) {
      rejected.push(`duplicate node id ${validated.id}`);
      continue;
    }
    byId.set(validated.id, validated);
    pendingNodes.push(validated);
  }

  const nodes: VFSNode[] = [];
  const seenPaths = new Set<string>();

  for (const pending of pendingNodes) {
    const resolved = resolveNodePath(pending, byId);
    if ('error' in resolved) {
      rejected.push(resolved.error);
      continue;
    }
    if (seenPaths.has(resolved.path)) {
      rejected.push(`duplicate path ${resolved.path}`);
      continue;
    }
    seenPaths.add(resolved.path);
    nodes.push(toVFSNode(pending, workspaceId, resolved.path));
  }

  const contentIds = new Set(
    nodes.filter((node): node is VirtualFile => node.type === 'file').map((node) => node.contentId),
  );

  const contents: WorkspaceSnapshot['contents'] = [];
  for (const candidate of Array.isArray(raw.contents) ? raw.contents : []) {
    const validated = validateContent(candidate, contentIds);
    if (typeof validated === 'string') {
      rejected.push(validated);
      continue;
    }
    contents.push(validated);
  }

  const crdt = validateCrdt(raw.crdt);
  if (typeof crdt === 'string') {
    return { ok: false, error: crdt, rejected };
  }

  return {
    ok: true,
    snapshot: {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      exportedAt:
        typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date().toISOString(),
      workspace: validateWorkspace(raw.workspace),
      nodes,
      contents,
      crdt,
    },
    rejected,
  };
}

/** Builds the export payload from already-trusted in-app state. */
export function encodeWorkspaceSnapshot(input: {
  workspace: WorkspaceMetadata | null;
  nodes: readonly VFSNode[];
  contents: readonly { contentId: string; plainText: string }[];
  crdt: Uint8Array | null;
  exportedAt?: string;
}): WorkspaceSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    workspace: input.workspace,
    nodes: input.nodes.map((node) => ({ ...node })),
    contents: input.contents.map((content) => ({
      contentId: content.contentId,
      plainText: content.plainText,
      updatedAt: Date.now(),
    })),
    crdt: input.crdt ? Array.from(input.crdt) : null,
  };
}