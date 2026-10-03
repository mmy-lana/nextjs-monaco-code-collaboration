import { VFS_ROOT_PATH } from '@/types/workspace';

/**
 * Virtual path utilities.
 *
 * Every path in the workspace is POSIX-style and absolute (`/src/hooks/useVFS.ts`).
 * All helpers normalise defensively because node names arrive from user input,
 * paste buffers and peer CRDT payloads alike.
 */

export function normalizePath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const stack: string[] = [];

  for (const part of parts) {
    if (part === '..') {
      stack.pop();
    } else if (part !== '.') {
      stack.push(part);
    }
  }

  return '/' + stack.join('/');
}

export function getFileExtension(filename: string): string {
  const lastIndex = filename.lastIndexOf('.');
  if (lastIndex === -1 || lastIndex === 0) return '';
  return filename.substring(lastIndex + 1).toLowerCase();
}

export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 1) return '/';
  segments.pop();
  return '/' + segments.join('/');
}

export function getFileName(path: string): string {
  const segments = normalizePath(path).split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

/** Joins a parent directory path with a single child name. */
export function joinPath(parentPath: string, name: string): string {
  const parent = normalizePath(parentPath);
  const cleaned = name.trim().replace(/^\/+|\/+$/g, '');
  if (!cleaned) return parent === '' ? VFS_ROOT_PATH : parent;
  return normalizePath(`${parent}/${cleaned}`);
}

/** Ordered name segments of a path, excluding the root. */
export function getPathSegments(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean);
}

/** Segments used to render the editor breadcrumb trail. */
export function getBreadcrumbSegments(path: string): string[] {
  return getPathSegments(path);
}

/** Workspace-relative display form: `/src/index.ts` becomes `src/index.ts`. */
export function toRelativePath(path: string): string {
  return getPathSegments(path).join('/');
}

/** Rebuilds a full path from a parent path and an already sanitised name. */
export function buildNodePath(parentPath: string, name: string): string {
  return joinPath(parentPath, name);
}

/**
 * Rewrites the last segment of `path`. Directory renames keep siblings intact
 * because only the tail is replaced.
 */
export function renamePath(path: string, newName: string): string {
  return joinPath(getParentPath(path), newName);
}

/** Re-parents `path` under `newParentPath`, keeping only the node's own name. */
export function movePath(path: string, newParentPath: string): string {
  return joinPath(newParentPath, getFileName(path));
}

/** True when `childPath` is `parentPath` itself or nested beneath it. */
export function isPathInside(childPath: string, parentPath: string): boolean {
  const child = normalizePath(childPath);
  const parent = normalizePath(parentPath);
  if (parent === VFS_ROOT_PATH) return true;
  return child === parent || child.startsWith(`${parent}/`);
}

/** Directory name shown in a ".." breadcrumb affordance, or `null` at root. */
export function getDirectoryName(path: string): string | null {
  const parent = getParentPath(path);
  if (parent === VFS_ROOT_PATH) return null;
  return getFileName(parent);
}

/** Maximum accepted length of a single node name, enforced by the rename UI. */
export const MAX_NODE_NAME_LENGTH = 120;

/**
 * Characters rejected in node names because they break shell and filesystem
 * semantics. The global variant drives `sanitizeNodeName`; the non-global
 * variant backs membership tests, which must not carry `lastIndex` state.
 */
const FORBIDDEN_NAME_CHARACTERS = /[<>:"/\\|?*]/g;
const FORBIDDEN_NAME_TEST = /[<>:"/\\|?*]/;

/** True when the string contains C0 controls or DEL, which break JSON + paths. */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Names Windows reserves; rejected to keep exported files portable. */
const RESERVED_NODE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export interface NodeNameValidation {
  valid: boolean;
  reason: string | null;
}

/**
 * Strips forbidden characters and control codes, then collapses whitespace, so
 * a raw user string can become a usable node name. Returns an empty string when
 * nothing survives sanitisation.
 */
export function sanitizeNodeName(rawName: string): string {
  let cleaned = '';
  for (const character of rawName.replace(FORBIDDEN_NAME_CHARACTERS, '')) {
    const code = character.codePointAt(0) ?? 0;
    cleaned += code < 32 || code === 127 ? '' : character;
  }
  return cleaned
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_NODE_NAME_LENGTH)
    .trim();
}

export function validateNodeName(name: string): NodeNameValidation {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return { valid: false, reason: 'Name cannot be empty.' };
  }
  if (trimmed.length > MAX_NODE_NAME_LENGTH) {
    return { valid: false, reason: `Name must be ${MAX_NODE_NAME_LENGTH} characters or fewer.` };
  }
  if (trimmed === '.' || trimmed === '..') {
    return { valid: false, reason: '"." and ".." are reserved path segments.' };
  }
  if (FORBIDDEN_NAME_TEST.test(trimmed)) {
    return { valid: false, reason: 'Name cannot contain < > : " / \\ | ? * characters.' };
  }
  if (hasControlCharacters(trimmed)) {
    return { valid: false, reason: 'Name cannot contain control characters.' };
  }
  if (RESERVED_NODE_NAMES.has(trimmed.toLowerCase())) {
    return { valid: false, reason: `"${trimmed}" is a reserved system name.` };
  }

  return { valid: true, reason: null };
}

let idCounter = 0;

/**
 * Collision-resistant node identifier: the timestamp prefix keeps ids roughly
 * ordered, the counter disambiguates same-millisecond creates.
 */
export function generateNodeId(prefix: string = 'node'): string {
  idCounter = (idCounter + 1) % 100000;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** Natural ordering helper for path lists (directories-first rendering). */
export function comparePaths(a: string, b: string): number {
  return normalizePath(a).localeCompare(normalizePath(b), 'en', { numeric: true, sensitivity: 'base' });
}