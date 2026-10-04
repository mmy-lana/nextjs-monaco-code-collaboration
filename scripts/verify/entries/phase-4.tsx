import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { editor as MonacoEditorNamespace } from 'monaco-editor';
import * as Y from 'yjs';
import type { VFSNode } from '@/types/workspace';
import { MonacoWrapper } from '@/components/domain/MonacoWrapper';
import { MobileKeyboardBar, type KeyboardBarCommand } from '@/components/layout/MobileKeyboardBar';
import { useVFS } from '@/hooks/useVFS';
import { useYjsCollaboration } from '@/hooks/useYjsCollaboration';
import { useResponsiveLayout } from '@/hooks/useResponsiveLayout';
import { useKeyboardShortcuts, type KeyboardShortcut } from '@/hooks/useKeyboardShortcuts';
import { parsePeerState } from '@/hooks/useMonacoBinding';
import { buildMonacoOptions } from '@/components/domain/MonacoWrapper';
import { getFileText } from '@/services/yjsProvider';
import { parseSignalingServers, defaultSignalingUrl, toSignalingUrl } from '@/services/signalingConfig';
import { parseWorkspaceSnapshot, encodeWorkspaceSnapshot } from '@/services/workspaceSnapshot';
import { sanitizePeerName, isValidHexColor, sanitizePeerColor } from '@/utils/colorGenerator';
import { DEFAULT_MONACO_CONFIG } from '@/types/editor';

/** Transaction origin standing in for an edit authored by another peer. */
const PHASE4_REMOTE_ORIGIN = 'phase4-remote-peer';

const WORKSPACE_ID = 'phase4-workspace';
const ROOM_ID = 'phase4-room';

/**
 * Monaco needs a language-service web worker. In the Next.js build the real
 * worker asset is emitted and wired up by `MonacoDynamic`; this harness bundle is
 * injected into an already-built page where `import.meta.url` does not exist, so
 * the worker is supplied here instead. Language services are intentionally inert
 * in the harness — what this suite verifies is the editor surface, the CRDT
 * binding and awareness, none of which depend on TS diagnostics.
 */
function installHarnessWorker(): void {
  const source = `
    // Inert language-service worker for the verification harness.
    self.onmessage = function () {};
  `;

  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

  (window as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker(): Worker {
      return new Worker(blobUrl, { type: 'classic', name: 'monaco-harness-worker' });
    },
  };
}

let createCounter = 0;
let lastError: string | null = null;
const shortcutHits: string[] = [];

/** Live CRDT document, exposed so the suite can inject a peer-authored update. */
const collabDocRef: { current: Y.Doc | null } = { current: null };

function Phase4App() {
  const [enabled, setEnabled] = useState(true);
  const collab = useYjsCollaboration({ roomId: ROOM_ID, enabled, signalingServers: [] });
  collabDocRef.current = collab.doc;
  const vfs = useVFS(WORKSPACE_ID);
  const viewport = useResponsiveLayout();
  const editorRef = useRef<MonacoEditorNamespace.IStandaloneCodeEditor | null>(null);
  const shortcutLogRef = useRef<HTMLSpanElement | null>(null);

  const [content, setContent] = useState('');
  const [cursor, setCursor] = useState({ line: 1, column: 1, selectionLength: 0 });
  const [liveTabOverride, setLiveTabOverride] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const activeFileId = vfs.workspace?.activeFileId ?? null;
  const activeFile = vfs.nodes.find((node) => node.id === activeFileId) ?? null;
  const liveFileId = liveTabOverride ?? activeFileId;

  useEffect(() => {
    let cancelled = false;
    if (!activeFileId) {
      setContent('');
      return () => {
        cancelled = true;
      };
    }
    void vfs.loadFileContent(activeFileId).then((text) => {
      if (!cancelled) setContent(text);
    });
    return () => {
      cancelled = true;
    };
    // Reloads only when the active tab changes; live edits flow through the CRDT.
  }, [activeFileId, vfs.loadFileContent]);

  const shortcuts = useMemo<KeyboardShortcut[]>(
    () => [
      {
        id: 'phase4.probe',
        key: 'F9',
        mod: true,
        description: 'Probe shortcut',
        display: '⌘F9',
        allowInEditor: true,
        handler: () => {
          shortcutHits.push('probe');
          // Written straight to the DOM: the cursor reporter is now correctly
          // suppressed when nothing moved, so no other render would flush this.
          if (shortcutLogRef.current) shortcutLogRef.current.textContent = shortcutHits.join(',');
        },
      },
      {
        id: 'phase4.palette',
        key: 'p',
        mod: true,
        description: 'Open quick open',
        display: '⌘P',
        handler: () => {
          shortcutHits.push('palette');
          if (shortcutLogRef.current) shortcutLogRef.current.textContent = shortcutHits.join(',');
        },
      },
    ],
    [],
  );

  useKeyboardShortcuts(shortcuts);

  const handleEditorReady = useCallback((editor: MonacoEditorNamespace.IStandaloneCodeEditor | null) => {
    editorRef.current = editor;
  }, []);

  const handleKeyboardInsert = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.trigger('mobile-keyboard-bar', 'type', { text });
  }, []);

  const handleKeyboardCommand = useCallback((command: KeyboardBarCommand) => {
    const editor = editorRef.current;
    if (!editor) return;

    switch (command) {
      case 'indent':
        editor.getAction('editor.action.indentLines')?.run();
        break;
      case 'outdent':
        editor.getAction('editor.action.outdentLines')?.run();
        break;
      case 'undo':
        editor.trigger('mobile-keyboard-bar', 'undo', null);
        break;
      case 'redo':
        editor.trigger('mobile-keyboard-bar', 'redo', null);
        break;
      case 'undoSelection':
        editor.trigger('mobile-keyboard-bar', 'cursorUndo', null);
        break;
      case 'redoSelection':
        editor.trigger('mobile-keyboard-bar', 'cursorRedo', null);
        break;
    }
  }, []);

  window.__phase4Editor = {
    get: () => editorRef.current,
    getText: () => editorRef.current?.getValue() ?? null,
    focus: () => editorRef.current?.focus(),
    setPosition: (line: number, column: number) =>
      editorRef.current?.setPosition({ lineNumber: line, column }),
    insert: (text: string) => {
      editorRef.current?.trigger('phase4-suite', 'type', { text });
    },
    selectAll: () => editorRef.current?.getAction('editor.action.selectAll')?.run(),
    deleteSelection: () => editorRef.current?.getAction('editor.action.delete')?.run(),
    trigger: (source: string, command: string, payload: unknown) =>
      editorRef.current?.trigger(source, command, payload),
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="phase4-root"
      data-provider={collab.doc ? 'ready' : 'none'}
      data-connection={collab.connection.connectionState}
      data-transport={collab.connection.transportMode}
      style={{ background: 'var(--vscode-bg)' }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-vscode-border p-2 text-xs">
        <button
          type="button"
          data-testid="toggle-provider"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => setEnabled((value) => !value)}
        >
          Toggle provider
        </button>

        <button
          type="button"
          data-testid="vfs-create-file"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => {
            createCounter += 1;
            void vfs.createFile(null, `created-${createCounter}.ts`).then((result) => {
              lastError = result.error;
            });
          }}
        >
          Create file
        </button>

        <button
          type="button"
          data-testid="vfs-create-nested"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => {
            createCounter += 1;
            void vfs
              .createDirectory(null, `folder-${createCounter}`)
              .then((result) => {
                lastError = result.error;
                return result.node;
              })
              .then((dir) => {
                if (!dir) {
                  lastError = lastError ?? 'directory creation produced no node';
                  return undefined;
                }
                return vfs.createFile(dir.id, `nested-${createCounter}.ts`).then((inner) => {
                  lastError = inner.error;
                });
              })
              .catch((error: unknown) => {
                lastError = error instanceof Error ? error.message : String(error);
              });
          }}
        >
          Create nested
        </button>

        <button
          type="button"
          data-testid="vfs-rename"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => {
            const target = vfs.nodes.find((node) => node.type === 'file');
            if (!target) {
              lastError = 'no file to rename';
              return;
            }
            setDeleteTargetId(target.id);
            void vfs.renameNode(target.id, `renamed-${Date.now()}.ts`).then((result) => {
              lastError = result.error;
            });
          }}
        >
          Rename first file
        </button>

        <button
          type="button"
          data-testid="vfs-duplicate-name"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => {
            void vfs.createFile(null, 'README.md').then((result) => {
              lastError = result.error;
            });
          }}
        >
          Duplicate name
        </button>

        <button
          type="button"
          data-testid="vfs-delete"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => {
            const target =
              vfs.nodes.find((node) => node.id === deleteTargetId) ??
              vfs.nodes.find((node) => node.type === 'file' && node.id !== activeFileId);
            if (!target) {
              lastError = 'no file to delete';
              return;
            }
            void vfs.deleteNode(target.id).then((result) => {
              lastError = result.error;
              setDeleteTargetId(null);
            });
          }}
        >
          Delete a file
        </button>

        <button
          type="button"
          data-testid="vfs-pin-tab"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => {
            const target = vfs.nodes.find((node) => node.type === 'file' && node.id !== activeFileId);
            if (target) setLiveTabOverride(target.id);
          }}
        >
          Bind a pinned tab
        </button>

        <button
          type="button"
          data-testid="vfs-unpin-tab"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => setLiveTabOverride(null)}
        >
          Unpin tab
        </button>

        <button
          type="button"
          data-testid="vfs-open-second"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => {
            const target = vfs.nodes.find((node) => node.type === 'file' && node.id !== activeFileId);
            if (target) void vfs.openFile(target.id);
          }}
        >
          Open second file
        </button>

        <button
          type="button"
          data-testid="vfs-close-active"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => {
            if (activeFileId) void vfs.closeFile(activeFileId);
          }}
        >
          Close active tab
        </button>

        <button
          type="button"
          data-testid="vfs-reopen"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2"
          onClick={() => {
            const target = vfs.nodes.find((node) => node.type === 'file');
            if (target) void vfs.openFile(target.id);
          }}
        >
          Reopen first file
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-b border-vscode-border p-2 text-[11px] sm:grid-cols-4">
        <div>
          <dt className="text-vscode-description-fg">Peers</dt>
          <dd data-testid="peer-count" className="text-vscode-fg">
            {collab.peers.length}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Peer names</dt>
          <dd data-testid="peer-names" className="truncate text-vscode-fg">
            {collab.peers.map((peer) => peer.name).join(',')}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Identity</dt>
          <dd data-testid="identity" className="truncate text-vscode-fg">
            {collab.identity?.name ?? ''}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Connection</dt>
          <dd data-testid="connection-state" className="text-vscode-fg">
            {collab.connection.connectionState}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Transport</dt>
          <dd data-testid="connection-transport" className="text-vscode-fg">
            {collab.connection.transportMode}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Nodes</dt>
          <dd data-testid="vfs-paths" className="truncate text-vscode-fg">
            {vfs.nodes.map((node) => node.path).join('|')}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Open tabs</dt>
          <dd data-testid="vfs-open-ids" className="truncate text-vscode-fg">
            {vfs.workspace?.openFileIds.join(',') ?? ''}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Active path</dt>
          <dd data-testid="vfs-active-path" className="truncate text-vscode-fg">
            {activeFile?.path ?? ''}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Active file</dt>
          <dd data-testid="vfs-active" className="truncate text-vscode-fg">
            {activeFileId ?? ''}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Cursor</dt>
          <dd data-testid="cursor-position" className="text-vscode-fg">
            {cursor.line}:{cursor.column}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Last mutation error</dt>
          <dd data-testid="vfs-error" className="truncate text-vscode-fg">
            {lastError ?? ''}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Viewport</dt>
          <dd data-testid="viewport" className="text-vscode-fg">
            {viewport.width}x{viewport.height} {viewport.isMobile ? 'mobile' : viewport.isTablet ? 'tablet' : 'desktop'}
            {viewport.keyboardOpen ? ` keyboard+${viewport.keyboardHeight}` : ''}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">Shortcut hits</dt>
          <dd
            data-testid="shortcut-hits"
            className="text-vscode-fg"
            ref={shortcutLogRef}
          >
            {shortcutHits.join(',')}
          </dd>
        </div>
        <div>
          <dt className="text-vscode-description-fg">VFS error</dt>
          <dd data-testid="vfs-load-error" className="truncate text-vscode-fg">
            {vfs.error ?? ''}
          </dd>
        </div>
      </dl>

      <div className="min-h-0 flex-1">
        <MonacoWrapper
          doc={collab.doc}
          fileId={liveFileId}
          filePath={activeFile?.path ?? ''}
          language={activeFile?.language ?? 'plaintext'}
          value={content}
          provider={collab.provider}
          onEditorReady={handleEditorReady}
          onCursorChange={(position, selectionLength) =>
            setCursor({ line: position.line, column: position.column, selectionLength })
          }
          onContentChange={(next) => {
            setContent(next);
            if (activeFileId) void vfs.saveFileContent(activeFileId, next);
          }}
          /*
           * Mirrors page.tsx: a peer's edit reaches the model through the
           * binding's echo suppression, so it would never reach `onContentChange`
           * and the Dexie snapshot would drift behind the CRDT.
           */
          onRemoteContentChange={(fileId, next) => {
            void vfs.saveFileContent(fileId, next);
          }}
        />
      </div>

      <MobileKeyboardBar
        visible={viewport.isMobile || viewport.keyboardOpen}
        onInsert={handleKeyboardInsert}
        onCommand={handleKeyboardCommand}
      />
    </div>
  );
}

export interface Phase4Probe {
  injectedColorRejected: boolean;
  injectedColorSafe: boolean;
  injectedNameSanitized: string;
  hexValidation: boolean;
  snapshotRejectsUnknownFormat: boolean;
  snapshotRejectsWrongWorkspace: boolean;
  snapshotRejectsCyclicParent: boolean;
  snapshotRejectsBadCrdt: boolean;
  snapshotRejectsOversizedContent: boolean;
  snapshotRebuildsNestedPaths: string[];
  snapshotRejectsDuplicatePath: number;
  snapshotRoundTripNodes: number;
  malformedStatesRejected: number;
  partiallyMalformedStatesDegraded: number;
  missingColourStillAdmitted: boolean;
  validStateParsed: boolean;
  signalingValid: string[];
  signalingInvalid: string[];
  defaultUrlIsWs: boolean;
  promotedUrl: string;
  monacoOptionKeys: string[];
  monacoMinimap: unknown;
}

declare global {
  interface Window {
    __phase4Mount?: () => void;
    __phase4Probe?: Phase4Probe;
    __phase4Editor?: {
      get: () => MonacoEditorNamespace.IStandaloneCodeEditor | null;
      getText: () => string | null;
      focus: () => void;
      setPosition: (line: number, column: number) => void;
      insert: (text: string) => void;
      selectAll: () => void;
      deleteSelection: () => void;
      trigger: (source: string, command: string, payload: unknown) => void;
    };
    __phase4Read?: (doc: Y.Doc, fileId: string) => string;
    /**
     * Applies an update authored outside this tab, exactly as a peer's CRDT
     * transaction arrives: a foreign document merged in with a non-local
     * transaction origin.
     */
    __phase4ApplyRemoteUpdate?: (fileId: string, text: string) => void;
    __phase4Root?: { render: (node: React.ReactNode) => void; unmount: () => void };
  }
}

function buildProbe(): Phase4Probe {
  const malformed = [
    null,
    undefined,
    'string',
    42,
    {},
    { user: null },
    { user: 'nope' },
    { user: { name: 'ok' } },
    { user: { name: 'ok', color: '#fff', cursor: { line: 'x', column: 1 } } },
    { user: { name: 'ok', color: '#fff', selection: { startLineNumber: 'x' } } },
    { user: { name: 'ok', color: '#fff', cursor: { line: 0, column: -3 } } },
  ];

  const injectionPayload = 'red;} body{display:none} .x::after{content:"leaked"}';

  const injected = parsePeerState({
    user: {
      name: 'Mallory',
      color: injectionPayload,
      clientId: 99,
      cursor: { line: 1, column: 1 },
      activeFileId: 'f1',
      lastActive: 1,
      isHost: false,
    },
  });

  const rejected = malformed.filter((state) => parsePeerState(state) === null).length;
  // Partially malformed payloads must degrade (drop the bad field) rather than
  // evict the peer from the roster entirely.
  const degraded = malformed
    .filter((state) => parsePeerState(state) !== null)
    .filter((state) => {
      const parsed = parsePeerState(state);
      return parsed !== null && parsed.cursor === null && parsed.selection === null;
    }).length;

  const parsed = parsePeerState({
    user: {
      name: 'Valid Peer',
      color: '#22d3ee',
      clientId: 7,
      cursor: { line: 3, column: 4 },
      selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 3 },
      activeFileId: 'file-1',
      lastActive: 123,
      isHost: true,
    },
  });

  const parsedSignaling = parseSignalingServers('ws://a:4444\nnot-a-url\nwss://b:4444\nws://a:4444');
  const options = buildMonacoOptions(DEFAULT_MONACO_CONFIG);

  // Snapshot validation: hostile and malformed payloads must be refused or
  // repaired before they can reach Dexie or a live CRDT.
  const hostileNode: VFSNode & { contentId: string } = {
    id: 'evil',
    workspaceId: 'phase4-workspace',
    parentId: null,
    name: 'evil.ts',
    type: 'file',
    path: '/evil.ts',
    language: 'typescript',
    contentId: 'evil',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    size: 0,
  };

  const unknownFormat = parseWorkspaceSnapshot({ format: 'evil/app' }, 'phase4-workspace');
  const wrongWorkspace = parseWorkspaceSnapshot(
    { format: 'lancodecollab/workspace', version: 1, nodes: [{ ...hostileNode, workspaceId: 'other' }] },
    'phase4-workspace',
  );
  const cyclic = parseWorkspaceSnapshot(
    {
      format: 'lancodecollab/workspace',
      version: 1,
      nodes: [
        { ...hostileNode, id: 'a', name: 'a.ts', parentId: 'b' },
        { ...hostileNode, id: 'b', name: 'b.ts', parentId: 'a' },
      ],
    },
    'phase4-workspace',
  );
  const badCrdt = parseWorkspaceSnapshot(
    { format: 'lancodecollab/workspace', version: 1, nodes: [], crdt: [1, 2, 'x'] },
    'phase4-workspace',
  );
  const oversized = parseWorkspaceSnapshot(
    {
      format: 'lancodecollab/workspace',
      version: 1,
      nodes: [hostileNode],
      contents: [{ contentId: 'evil', plainText: 'x'.repeat(600_000) }],
    },
    'phase4-workspace',
  );
  const nested = parseWorkspaceSnapshot(
    {
      format: 'lancodecollab/workspace',
      version: 1,
      nodes: [
        { ...hostileNode, id: 'dir', name: 'src', type: 'directory', contentId: 'dir' },
        { ...hostileNode, id: 'leaf', name: 'leaf.ts', parentId: 'dir' },
      ],
    },
    'phase4-workspace',
  );
  const duplicatePath = parseWorkspaceSnapshot(
    {
      format: 'lancodecollab/workspace',
      version: 1,
      nodes: [
        { ...hostileNode, id: 'one', name: 'same.ts' },
        { ...hostileNode, id: 'two', name: 'same.ts' },
      ],
    },
    'phase4-workspace',
  );

  const roundTrip = parseWorkspaceSnapshot(
    JSON.parse(
      JSON.stringify(
        encodeWorkspaceSnapshot({
          workspace: null,
          nodes: [hostileNode],
          contents: [{ contentId: 'evil', plainText: 'hello' }],
          crdt: new Uint8Array([1, 2, 3]),
        }),
      ),
    ),
    'phase4-workspace',
  );

  return {
    injectedColorRejected: injected === null || isValidHexColor(injected.color),
    injectedColorSafe: injected !== null && isValidHexColor(injected.color),
    injectedNameSanitized: sanitizePeerName('**Mallory** [bold]'),
    hexValidation:
      isValidHexColor('#ff8811') &&
      !isValidHexColor('red;} body{display:none}') &&
      !isValidHexColor('#fff') &&
      !isValidHexColor('rgb(1,2,3)') &&
      sanitizePeerColor('not-a-color', 'seed').startsWith('#'),
    snapshotRejectsUnknownFormat: !unknownFormat.ok,
    snapshotRejectsWrongWorkspace: wrongWorkspace.ok && wrongWorkspace.rejected.length === 1,
    snapshotRejectsCyclicParent: cyclic.ok && cyclic.rejected.length === 2 && cyclic.snapshot.nodes.length === 0,
    snapshotRejectsBadCrdt: !badCrdt.ok,
    snapshotRejectsOversizedContent: oversized.ok && oversized.snapshot.contents.length === 0,
    snapshotRebuildsNestedPaths:
      nested.ok ? nested.snapshot.nodes.map((node) => node.path).sort() : [],
    snapshotRejectsDuplicatePath: duplicatePath.ok ? duplicatePath.rejected.length : -1,
    snapshotRoundTripNodes: roundTrip.ok ? roundTrip.snapshot.nodes.length : -1,
    malformedStatesRejected: rejected,
    missingColourStillAdmitted:
      (() => {
        const parsed = parsePeerState({ user: { name: 'NoColour' } });
        return parsed !== null && isValidHexColor(parsed.color);
      })(),
    partiallyMalformedStatesDegraded: degraded,
    validStateParsed:
      parsed !== null &&
      parsed.name === 'Valid Peer' &&
      parsed.cursor?.line === 3 &&
      parsed.selection?.endLineNumber === 2 &&
      parsed.isHost,
    signalingValid: parsedSignaling.servers,
    signalingInvalid: parsedSignaling.invalid,
    defaultUrlIsWs: defaultSignalingUrl(4444).startsWith('ws://'),
    promotedUrl: toSignalingUrl('192.168.1.10:4444'),
    monacoOptionKeys: Object.keys(options).sort(),
    monacoMinimap: options.minimap,
  };
}

export function mountPhase4(container: HTMLElement): void {
  // Mounting twice in one document would create a second Yjs provider for the
  // same room, which y-webrtc rejects outright.
  if (window.__phase4Root) return;

  installHarnessWorker();

  window.__phase4Root = createRoot(container);
  window.__phase4Root.render(<Phase4App />);
  window.__phase4Probe = buildProbe();
  window.__phase4Read = (doc, fileId) => getFileText(doc, fileId).toString();

  /*
   * Builds a genuine remote transaction. A peer that had already synced holds
   * the same CRDT lineage, so its edit merges into the existing `Y.Text` and
   * fires that text's observer — which is what makes this reach the model and
   * the snapshot mirror. Re-setting the map entry instead would swap in a new
   * `Y.Text` and never touch the one the binding is bound to.
   */
  window.__phase4ApplyRemoteUpdate = (fileId, text) => {
    const live = collabDocRef.current;
    if (!live) return;

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(live));

    const remoteText = getFileText(remote, fileId);
    const stateVectorBeforeEdit = Y.encodeStateVector(remote);
    remoteText.insert(remoteText.length, text);

    Y.applyUpdate(live, Y.encodeStateAsUpdate(remote, stateVectorBeforeEdit), PHASE4_REMOTE_ORIGIN);
    remote.destroy();
  };
}

const tryMount = (): void => {
  const container = document.getElementById('phase4-container');
  if (container) mountPhase4(container);
};

window.__phase4Mount = tryMount;

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', tryMount);
} else {
  tryMount();
}