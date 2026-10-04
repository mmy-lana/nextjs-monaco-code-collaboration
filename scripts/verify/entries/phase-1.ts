/**
 * Phase 1 verification entry.
 *
 * Bundled with esbuild and injected into a real headless Chrome page, so every
 * assertion runs in the same browser engine the application ships to (IndexedDB,
 * localStorage and Blob sizing all behave as they do in production).
 */

import {
  assessFileSize,
  createStoredFileContent,
  formatBytes,
  getDB,
  MAX_FILE_CHARACTERS,
} from '@/db/schema';
import {
  detectLanguageByFilename,
  detectLanguageByPath,
  FALLBACK_LANGUAGE,
  resolveMonacoLanguage,
  SUPPORTED_LANGUAGES,
} from '@/services/languageDetector';
import { hexToRgba, hslToHex, getContrastColor, getPeerColor, getPeerColorByName, hashString, loadLocalIdentity, resolveLocalIdentity, saveLocalIdentity, colorFromSeed, generateInitials, clearLocalIdentity } from '@/utils/colorGenerator';
import {
  comparePaths,
  generateNodeId,
  getBreadcrumbSegments,
  getDirectoryName,
  getFileExtension,
  getFileName,
  getParentPath,
  isPathInside,
  joinPath,
  movePath,
  normalizePath,
  renamePath,
  sanitizeNodeName,
  toRelativePath,
  validateNodeName,
} from '@/utils/pathUtils';
import {
  getBrowserFamily,
  getOperatingSystem,
  isTouchDevice,
  MIN_TOUCH_TARGET_PX,
  prefersCoarsePointer,
  supportsBroadcastChannel,
  supportsWebRTC,
} from '@/utils/platform';
import {
  createEmptyWorkspace,
  isVirtualDirectory,
  isVirtualFile,
  sortVFSNodes,
  type VirtualDirectory,
  type VirtualFile,
  type WorkspaceMetadata,
} from '@/types/workspace';

export interface Phase1Check {
  label: string;
  ok: boolean;
  detail: string;
}

const TEST_WORKSPACE_ID = 'phase1-verify-workspace';
const TEST_NODE_ID = 'phase1-verify-node';

export async function runPhase1(): Promise<Phase1Check[]> {
  const results: Phase1Check[] = [];
  const check = (label: string, ok: boolean, detail = ''): void => {
    results.push({ label, ok, detail: ok ? '' : detail });
  };
  const eq = (label: string, actual: unknown, expected: unknown): void => {
    check(
      label,
      Object.is(actual, expected),
      `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  };

  // ── path utilities ─────────────────────────────────────────────────────────
  eq('normalizePath collapses redundant separators', normalizePath('//src///hooks//'), '/src/hooks');
  eq('normalizePath resolves parent traversal', normalizePath('/src/lib/../hooks/useVFS.ts'), '/src/hooks/useVFS.ts');
  eq('normalizePath clamps traversal above root', normalizePath('/../../etc/passwd'), '/etc/passwd');
  eq('normalizePath drops current-directory segments', normalizePath('/src/./app/./page.tsx'), '/src/app/page.tsx');
  eq('normalizePath maps empty input to root', normalizePath(''), '/');

  eq('getFileExtension lowercases extension', getFileExtension('Main.TSX'), 'tsx');
  eq('getFileExtension ignores dotfiles', getFileExtension('.gitignore'), '');
  eq('getFileExtension handles extensionless names', getFileExtension('Makefile'), '');
  eq('getFileExtension uses the final segment', getFileExtension('bundle.tar.gz'), 'gz');

  eq('getParentPath walks one level up', getParentPath('/src/hooks/useVFS.ts'), '/src/hooks');
  eq('getParentPath of a root child is root', getParentPath('/index.ts'), '/');

  eq('getFileName returns the leaf segment', getFileName('/src/app/page.tsx'), 'page.tsx');
  eq('getFileName of root is empty', getFileName('/'), '');

  eq('joinPath concatenates parent and child', joinPath('/src', 'app'), '/src/app');
  eq('joinPath trims stray slashes in child', joinPath('/src/', '/app/'), '/src/app');
  eq('getBreadcrumbSegments yields ordered trail', getBreadcrumbSegments('/src/app/page.tsx').join('>'), 'src>app>page.tsx');
  eq('toRelativePath strips the leading slash', toRelativePath('/src/index.ts'), 'src/index.ts');
  eq('getDirectoryName returns the parent folder', getDirectoryName('/src/app/page.tsx'), 'app');
  eq('getDirectoryName at root returns null', getDirectoryName('/index.ts'), null);

  eq('renamePath replaces only the leaf', renamePath('/src/old.ts', 'new.ts'), '/src/new.ts');
  eq('movePath re-parents while keeping the name', movePath('/src/utils/a.ts', '/lib'), '/lib/a.ts');
  check('isPathInside accepts descendants', isPathInside('/src/a/b.ts', '/src'));
  check('isPathInside rejects siblings with a shared prefix', !isPathInside('/srcx/a.ts', '/src'));
  check('isPathInside accepts the path itself', isPathInside('/src', '/src'));
  check('comparePaths orders naturally', comparePaths('/file2.ts', '/file10.ts') < 0);

  eq('sanitizeNodeName strips control characters', sanitizeNodeName('bad\u0000name\u001f.txt'), 'badname.txt');
  eq('sanitizeNodeName strips path separators', sanitizeNodeName('src/../escape.ts'), 'src..escape.ts');
  eq('sanitizeNodeName preserves hyphens and spaces', sanitizeNodeName('my-notes.md'), 'my-notes.md');
  check('validateNodeName rejects empty input', !validateNodeName('   ').valid);
  check('validateNodeName rejects reserved Windows names', !validateNodeName('CON').valid);
  check('validateNodeName accepts normal names', validateNodeName('useVFS.ts').valid);

  const idA = generateNodeId('node');
  const idB = generateNodeId('node');
  check('generateNodeId produces unique ids', idA !== idB, `${idA} === ${idB}`);

  // ── language detection ─────────────────────────────────────────────────────
  eq('detectLanguageByFilename handles TypeScript', detectLanguageByFilename('index.ts'), 'typescript');
  eq('detectLanguageByFilename handles TSX', detectLanguageByFilename('App.tsx'), 'typescript');
  eq('detectLanguageByFilename handles extensionless Dockerfile', detectLanguageByFilename('Dockerfile'), 'dockerfile');
  eq('detectLanguageByFilename handles suffixed Dockerfile', detectLanguageByFilename('Dockerfile.prod'), 'dockerfile');
  eq('detectLanguageByFilename handles package.json', detectLanguageByFilename('package.json'), 'json');
  eq('detectLanguageByFilename handles Makefile', detectLanguageByFilename('Makefile'), FALLBACK_LANGUAGE);
  eq('detectLanguageByFilename handles Markdown', detectLanguageByFilename('README.md'), 'markdown');
  eq('detectLanguageByFilename handles SFCs', detectLanguageByFilename('Card.vue'), 'html');
  eq('detectLanguageByFilename falls back for unknown types', detectLanguageByFilename('mystery.qqq'), FALLBACK_LANGUAGE);
  eq('detectLanguageByPath resolves from a full path', detectLanguageByPath('/src/hooks/useVFS.ts'), 'typescript');
  eq('resolveMonacoLanguage rejects unknown ids', resolveMonacoLanguage('brainfuck'), FALLBACK_LANGUAGE);
  eq('resolveMonacoLanguage handles null', resolveMonacoLanguage(null), FALLBACK_LANGUAGE);
  check('SUPPORTED_LANGUAGES is non-empty', SUPPORTED_LANGUAGES.length > 10, `length=${SUPPORTED_LANGUAGES.length}`);

  // ── colours and identity ───────────────────────────────────────────────────
  eq('getPeerColor is deterministic for id 0', getPeerColor(0), '#f87171');
  eq('getPeerColor handles negative ids', getPeerColor(-1), '#fb923c');
  eq('getPeerColor wraps modulo palette length', getPeerColor(10), '#f87171');
  check('getPeerColorByName is deterministic', getPeerColorByName('Ada') === getPeerColorByName('Ada'));
  check('hashString returns an unsigned 32-bit integer', hashString('lan') >>> 0 === hashString('lan'));
  check('hashString differs across inputs', hashString('lan') !== hashString('wan'));

  eq('hslToHex converts pure red', hslToHex(0, 100, 50), '#ff0000');
  eq('hslToHex converts pure green', hslToHex(120, 100, 50), '#00ff00');
  eq('hslToHex converts pure blue', hslToHex(240, 100, 50), '#0000ff');
  eq('hslToHex wraps hue past 360', hslToHex(360, 100, 50), '#ff0000');
  eq('hexToRgba emits the expected rgba string', hexToRgba('#f87171', 0.2), 'rgba(248, 113, 113, 0.200)');
  eq('getContrastColor picks black on light colours', getContrastColor('#fbbf24'), '#000000');
  eq('getContrastColor picks white on dark colours', getContrastColor('#1e1e1e'), '#ffffff');
  check('colorFromSeed yields a hex colour', /^#[0-9a-f]{6}$/i.test(colorFromSeed('peer-7')));
  eq('generateInitials uses first and last token', generateInitials('Swift Coder'), 'SC');

  clearLocalIdentity();
  saveLocalIdentity({ clientId: 42, name: 'Verifier', color: '#22d3ee' });
  const restored = loadLocalIdentity();
  check('localStorage identity round-trips', restored?.name === 'Verifier' && restored?.clientId === 42, JSON.stringify(restored));
  const reused = resolveLocalIdentity(99);
  check('resolveLocalIdentity reuses the stored name', reused.name === 'Verifier' && reused.clientId === 99, JSON.stringify(reused));
  clearLocalIdentity();
  check('clearLocalIdentity removes the entry', loadLocalIdentity() === null);

  // ── platform capabilities ──────────────────────────────────────────────────
  check('supportsWebRTC detects RTCPeerConnection', supportsWebRTC());
  check('supportsBroadcastChannel detects BroadcastChannel', supportsBroadcastChannel());
  check('isTouchDevice returns a boolean', typeof isTouchDevice() === 'boolean');
  check('prefersCoarsePointer returns a boolean', typeof prefersCoarsePointer() === 'boolean');
  check('getOperatingSystem resolves a known platform', getOperatingSystem() !== 'Unknown', getOperatingSystem());
  check('getBrowserFamily resolves a known browser', getBrowserFamily() !== 'unknown', getBrowserFamily());
  eq('MIN_TOUCH_TARGET_PX matches the breakpoint matrix', MIN_TOUCH_TARGET_PX, 44);

  // ── workspace types and guards ─────────────────────────────────────────────
  const now = Date.now();
  const directory: VirtualDirectory = {
    id: 'd1', workspaceId: 'w1', parentId: null, name: 'src', type: 'directory', path: '/src',
    language: 'plaintext', createdAt: now, updatedAt: now, deletedAt: null, size: 0,
  };
  const file: VirtualFile = {
    id: 'f1', workspaceId: 'w1', parentId: 'd1', name: 'index.ts', type: 'file', path: '/src/index.ts',
    extension: 'ts', language: 'typescript', createdAt: now, updatedAt: now, deletedAt: null, size: 12,
    contentId: 'f1',
  };
  check('isVirtualDirectory narrows directories', isVirtualDirectory(directory) && !isVirtualDirectory(file));
  check('isVirtualFile narrows files', isVirtualFile(file) && !isVirtualFile(directory));

  const sorted = sortVFSNodes([
    { ...file, id: 'f10', name: 'file10.ts', path: '/file10.ts', parentId: null },
    { ...directory, id: 'd2', name: 'app', path: '/app' },
    { ...file, id: 'f2', name: 'file2.ts', path: '/file2.ts', parentId: null },
    { ...directory, id: 'd3', name: 'api', path: '/api' },
  ]);
  eq('sortVFSNodes orders directories first, naturally', sorted.map((node) => node.name).join(','), 'api,app,file2.ts,file10.ts');

  const empty = createEmptyWorkspace('w1', 'Empty', 'room-1', now);
  check('createEmptyWorkspace opens with no tabs', empty.openFileIds.length === 0 && empty.activeFileId === null);

  // ── size guards and formatting ─────────────────────────────────────────────
  eq('formatBytes renders zero', formatBytes(0), '0 B');
  eq('formatBytes renders kilobytes', formatBytes(2048), '2.0 KB');
  eq('formatBytes renders whole kilobytes', formatBytes(10240), '10 KB');
  eq('formatBytes renders megabytes', formatBytes(50 * 1024 * 1024), '50 MB');
  check('assessFileSize accepts normal content', assessFileSize('const a = 1;').accepted);
  check(
    'assessFileSize rejects oversized documents',
    !assessFileSize('x'.repeat(MAX_FILE_CHARACTERS + 1)).accepted,
    'oversized document was accepted',
  );
  check(
    'assessFileSize reports a human-readable reason',
    assessFileSize('x'.repeat(MAX_FILE_CHARACTERS + 1)).reason !== null,
  );

  // ── Dexie persistence layer ────────────────────────────────────────────────
  const db = getDB();
  check('getDB returns the singleton instance', getDB() === db);
  check('workspaces table is registered', db.tables.some((table) => table.name === 'workspaces'));
  check('nodes table is registered', db.tables.some((table) => table.name === 'nodes'));
  check('contents table is registered', db.tables.some((table) => table.name === 'contents'));
  check('settings table is registered', db.tables.some((table) => table.name === 'settings'));
  eq('database is namespaced away from the CRDT store', db.name, 'LANCodeCollab-meta');

  await db.workspaces.delete(TEST_WORKSPACE_ID);
  await db.nodes.where('workspaceId').equals(TEST_WORKSPACE_ID).delete();
  await db.contents.delete(`${TEST_NODE_ID}-content`);

  const workspace: WorkspaceMetadata = {
    ...createEmptyWorkspace(TEST_WORKSPACE_ID, 'Verify Workspace', 'verify-room', now),
    activeFileId: TEST_NODE_ID,
    openFileIds: [TEST_NODE_ID],
  };
  await db.workspaces.put(workspace);

  const readWorkspace = await db.workspaces.get(TEST_WORKSPACE_ID);
  eq('workspace metadata round-trips', readWorkspace?.roomId, 'verify-room');

  const byRoom = await db.workspaces.where('roomId').equals('verify-room').toArray();
  check('roomId index is queryable', byRoom.length === 1, `found ${byRoom.length}`);

  const node: VirtualFile = {
    id: TEST_NODE_ID, workspaceId: TEST_WORKSPACE_ID, parentId: null, name: 'phase1-verify.ts',
    type: 'file', path: '/phase1-verify.ts', extension: 'ts', language: 'typescript',
    createdAt: now, updatedAt: now, deletedAt: null, size: 26, contentId: `${TEST_NODE_ID}-content`,
  };
  await db.nodes.put(node);

  const child: VirtualFile = {
    ...node,
    id: `${TEST_NODE_ID}-child`,
    parentId: TEST_NODE_ID,
    name: 'child.ts',
    path: '/child.ts',
    contentId: `${TEST_NODE_ID}-child-content`,
  };
  await db.nodes.put(child);

  const nodesByWorkspace = await db.nodes.where('workspaceId').equals(TEST_WORKSPACE_ID).toArray();
  eq('node query by workspaceId returns every seeded node', nodesByWorkspace.length, 2);

  const children = await db.nodes.where('parentId').equals(TEST_NODE_ID).toArray();
  eq('parentId index resolves directory children', children.length, 1);
  eq('parentId index returns the correct child', children[0]?.path, '/child.ts');

  // IndexedDB refuses `null` as a key, so root rows (`parentId === null`) and
  // live rows (`deletedAt === null`) are never written into those indexes.
  // The application therefore derives both sets with a workspace-scoped filter.
  const rootChildren = await db.nodes
    .where('workspaceId')
    .equals(TEST_WORKSPACE_ID)
    .filter((candidate) => candidate.parentId === null)
    .toArray();
  eq('root children are derived via a workspace-scoped filter', rootChildren.length, 1);
  eq('the root-scoped filter returns the root node', rootChildren[0]?.id, TEST_NODE_ID);

  const liveNodes = await db.nodes
    .where('workspaceId')
    .equals(TEST_WORKSPACE_ID)
    .filter((candidate) => candidate.deletedAt === null)
    .toArray();
  eq('live nodes are derived by filtering the deletedAt tombstone', liveNodes.length, 2);

  const tombstoned = await db.nodes
    .where('workspaceId')
    .equals(TEST_WORKSPACE_ID)
    .filter((candidate) => candidate.deletedAt !== null)
    .toArray();
  eq('tombstoned nodes are excluded from the live set', tombstoned.length, 0);

  let uniquePathEnforced = false;
  await db.nodes.put({ ...node, id: `${TEST_NODE_ID}-dupe`, path: '/phase1-duplicate.ts' });
  try {
    await db.nodes.put({ ...node, id: `${TEST_NODE_ID}-dupe2`, path: '/phase1-duplicate.ts' });
  } catch (error) {
    uniquePathEnforced = (error as Error)?.name === 'ConstraintError';
  }
  check('unique &path index rejects duplicates', uniquePathEnforced, 'duplicate path was accepted');

  const binaryState = new Uint8Array([0, 1, 2, 250, 255]);
  await db.contents.put(createStoredFileContent(`${TEST_NODE_ID}-content`, binaryState, 'const a = 1;', now));
  const storedContent = await db.contents.get(`${TEST_NODE_ID}-content`);
  check(
    'binaryState round-trips as a Uint8Array',
    storedContent?.binaryState instanceof Uint8Array && storedContent.binaryState[4] === 255,
    JSON.stringify(storedContent?.binaryState),
  );
  eq('plainText fallback snapshot round-trips', storedContent?.plainText, 'const a = 1;');

  await db.settings.put({ key: 'editor.fontSize', value: 14 });
  const setting = await db.settings.get('editor.fontSize');
  eq('settings round-trip', setting?.value, 14);

  // cleanup so repeated verification runs start clean
  await db.workspaces.delete(TEST_WORKSPACE_ID);
  await db.nodes.where('workspaceId').equals(TEST_WORKSPACE_ID).delete();
  await db.contents.delete(`${TEST_NODE_ID}-content`);
  await db.settings.delete('editor.fontSize');
  const cleanupNodes = await db.nodes.where('workspaceId').equals(TEST_WORKSPACE_ID).count();
  eq('verification fixtures are removed', cleanupNodes, 0);

  return results;
}

declare global {
  interface Window {
    __phase1?: { run: () => Promise<Phase1Check[]> };
  }
}

if (typeof window !== 'undefined') {
  window.__phase1 = { run: runPhase1 };
}