'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { editor as MonacoEditorNamespace } from 'monaco-editor';
import { VSCodeShell } from '@/components/layout/VSCodeShell';
import { MonacoWrapper } from '@/components/domain/MonacoWrapper';
import { FileExplorerView } from '@/components/domain/FileExplorerView';
import { GlobalSearchView } from '@/components/domain/GlobalSearchView';
import { CollaborationView } from '@/components/domain/CollaborationView';
import { SettingsView } from '@/components/domain/SettingsView';
import { CommandPaletteModal, type CommandPaletteCommand } from '@/components/molecules/CommandPaletteModal';
import { useVFS } from '@/hooks/useVFS';
import { useYjsCollaboration, resetLocalIdentity } from '@/hooks/useYjsCollaboration';
import { useResponsiveLayout } from '@/hooks/useResponsiveLayout';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import type { KeyboardBarCommand } from '@/components/layout/MobileKeyboardBar';
import { getDB } from '@/db/schema';
import { DEFAULT_SIGNALING } from '@/services/signalingConfig';
import { isVirtualFile, type VFSNode, type VirtualDirectory } from '@/types/workspace';
import {
  DEFAULT_MONACO_CONFIG,
  type ActivityBarTab,
  type BottomPanelTab,
  type DiagnosticItem,
  type EditorTab,
  type MonacoEditorConfig,
  type SearchMatch,
} from '@/types/editor';
import { getFileName, getParentPath } from '@/utils/pathUtils';
import { isIndexedDBAvailable } from '@/db/schema';

const WORKSPACE_ID = 'default-workspace';
const DEFAULT_ROOM_ID = 'collab-workspace-lan';

const SETTINGS_STORAGE_KEY = 'LANCodeCollab:editor-config';
const LAYOUT_STORAGE_KEY = 'LANCodeCollab:layout';
const SIDEBAR_DEFAULT_WIDTH = 260;
const PANEL_DEFAULT_HEIGHT = 220;

interface LayoutState {
  sidebarWidth: number;
  panelHeight: number;
}

function readStoredJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? ({ ...fallback, ...(JSON.parse(raw) as object) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function WorkspacePage() {
  const viewport = useResponsiveLayout();
  const vfs = useVFS(WORKSPACE_ID);
  const [roomId, setRoomId] = useState(DEFAULT_ROOM_ID);
  const [signalingServers, setSignalingServersState] = useState<string[]>(DEFAULT_SIGNALING.servers);

  const collab = useYjsCollaboration({
    roomId,
    enabled: vfs.workspace !== null,
    signalingServers,
  });

  // ── layout + view state ────────────────────────────────────────────────────
  const [layout, setLayout] = useState<LayoutState>({
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    panelHeight: PANEL_DEFAULT_HEIGHT,
  });
  const [activityTab, setActivityTab] = useState<ActivityBarTab>('explorer');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<BottomPanelTab>('lan-debug');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'files' | 'commands'>('files');
  const [config, setConfig] = useState<MonacoEditorConfig>(DEFAULT_MONACO_CONFIG);
  const [output, setOutput] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [storageBytes, setStorageBytes] = useState(0);
  const [cursor, setCursor] = useState<{ line: number; column: number; selectionLength: number } | null>(null);

  const editorRef = useRef<MonacoEditorNamespace.IStandaloneCodeEditor | null>(null);
  const [editorReady, setEditorReady] = useState(false);

  // `null` until the client has probed storage: the server has no `window`, so
  // resolving the capability during SSR would render the fallback markup and
  // break hydration.
  const [storageAvailable, setStorageAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    setStorageAvailable(isIndexedDBAvailable());
  }, []);

  // ── persisted preferences ──────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setConfig(readStoredJson<MonacoEditorConfig>(SETTINGS_STORAGE_KEY, DEFAULT_MONACO_CONFIG));
    setLayout(readStoredJson<LayoutState>(LAYOUT_STORAGE_KEY, layout));
    setSidebarOpen(window.innerWidth >= 1024);
    // Storage is read once on mount; later writes are push-based.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(config));
    } catch {
      // Storage denials must never break the editor.
    }
  }, [config]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    root.dataset.theme = config.theme === 'vs-light' ? 'light' : 'dark';
  }, [config.theme]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.style.setProperty('--sidebar-width', `${layout.sidebarWidth}px`);
    document.documentElement.style.setProperty('--panel-height', `${layout.panelHeight}px`);
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Ignore quota failures — the layout is cosmetic.
    }
  }, [layout]);

  // ── derived workspace state ────────────────────────────────────────────────
  const activeFileId = vfs.workspace?.activeFileId ?? null;
  const activeFile = useMemo(
    () => vfs.nodes.find((node) => node.id === activeFileId && isVirtualFile(node)) ?? null,
    [activeFileId, vfs.nodes],
  );

  const tabs = useMemo<EditorTab[]>(
    () =>
      (vfs.workspace?.openFileIds ?? [])
        .map((fileId) => vfs.nodes.find((node) => node.id === fileId))
        .filter((node): node is VFSNode => Boolean(node) && node!.type === 'file')
        .map((node) => ({
          fileId: node!.id,
          filePath: node!.path,
          fileName: node!.name,
          language: node!.language,
          isDirty: false,
          isPinned: false,
        })),
    [vfs.nodes, vfs.workspace?.openFileIds],
  );

  const siblings = useMemo(() => {
    if (!activeFile) return [];
    const parentPath = getParentPath(activeFile.path);
    return vfs.nodes
      .filter((node) => node.type === 'file' && getParentPath(node.path) === parentPath)
      .map((node) => node.name);
  }, [activeFile, vfs.nodes]);

  const logOutput = useCallback((line: string) => {
    setOutput((current) => [...current.slice(-200), line]);
  }, []);

  useEffect(() => {
    if (!collab.identity) return;
    logOutput(`[${new Date().toLocaleTimeString()}] joined as ${collab.identity.name}`);
    // Only on identity change: this is a join banner, not a render log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab.identity?.name]);

  // ── storage usage ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
    let cancelled = false;

    const measure = async () => {
      const estimate = await navigator.storage.estimate();
      if (!cancelled && typeof estimate.usage === 'number') setStorageBytes(estimate.usage);
    };

    void measure();
    const timer = window.setInterval(measure, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [vfs.nodes.length]);

  // ── workspace mutations ────────────────────────────────────────────────────
  const handleCreateFile = useCallback(
    async (parent: VirtualDirectory | null, name?: string) => {
      const resolved = name ?? window.prompt('New file name', 'untitled.ts');
      if (!resolved) return;
      const result = await vfs.createFile(parent?.id ?? null, resolved);
      if (!result.ok && result.error) logOutput(`create file failed: ${result.error}`);
    },
    [logOutput, vfs],
  );

  const handleCreateDirectory = useCallback(
    async (parent: VirtualDirectory | null, name?: string) => {
      const resolved = name ?? window.prompt('New folder name', 'new-folder');
      if (!resolved) return;
      const result = await vfs.createDirectory(parent?.id ?? null, resolved);
      if (!result.ok && result.error) logOutput(`create folder failed: ${result.error}`);
    },
    [logOutput, vfs],
  );

  const handleRename = useCallback(
    async (node: VFSNode, nextName: string) => {
      const result = await vfs.renameNode(node.id, nextName);
      if (!result.ok && result.error) logOutput(`rename failed: ${result.error}`);
    },
    [logOutput, vfs],
  );

  const handleDelete = useCallback(
    async (node: VFSNode) => {
      if (!window.confirm(`Delete ${node.path}? Peers keep their own copy until they reload.`)) return;
      const result = await vfs.deleteNode(node.id);
      if (!result.ok && result.error) logOutput(`delete failed: ${result.error}`);
    },
    [logOutput, vfs],
  );

  const handleOpenMatch = useCallback(
    (match: SearchMatch) => {
      void vfs.openFile(match.fileId);
      setActivityTab('explorer');
    },
    [vfs],
  );

  const handleExport = useCallback(() => {
    void (async () => {
      const db = getDB();
      const [nodes, contents, workspaces] = await Promise.all([
        db.nodes.toArray(),
        db.contents.toArray(),
        db.workspaces.toArray(),
      ]);
      const payload = {
        format: 'lancodecollab/workspace',
        version: 1,
        exportedAt: new Date().toISOString(),
        workspace: vfs.workspace,
        nodes,
        contents,
        workspaces,
        crdt: collab.doc ? Array.from(Y.encodeStateAsUpdate(collab.doc)) : null,
      };

      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${roomId}-snapshot.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      logOutput(`exported snapshot for room ${roomId}`);
    })();
  }, [collab.doc, logOutput, roomId, vfs.workspace]);

  const handleImport = useCallback(
    (file: File) => {
      void (async () => {
        try {
          const parsed = JSON.parse(await file.text()) as {
            format?: string;
            nodes?: VFSNode[];
            contents?: { contentId: string; plainText: string; updatedAt: number }[];
            crdt?: number[] | null;
          };
          if (parsed.format !== 'lancodecollab/workspace') {
            logOutput('import failed: unrecognised snapshot format');
            return;
          }

          const db = getDB();
          await db.transaction('rw', db.nodes, db.contents, async () => {
            await db.nodes.bulkPut((parsed.nodes ?? []).filter((node) => node.workspaceId === WORKSPACE_ID));
            await db.contents.bulkPut(
              (parsed.contents ?? []).map((content) => ({
                contentId: content.contentId,
                binaryState: new Uint8Array(0),
                plainText: content.plainText,
                size: content.plainText.length,
                updatedAt: content.updatedAt,
              })),
            );
          });

          if (parsed.crdt && collab.doc) {
            Y.applyUpdate(collab.doc, new Uint8Array(parsed.crdt), 'snapshot-import');
          }

          await vfs.refresh();
          logOutput(`imported snapshot (${(parsed.nodes ?? []).length} nodes)`);
        } catch (importError) {
          logOutput(`import failed: ${importError instanceof Error ? importError.message : 'unknown error'}`);
        }
      })();
    },
    [collab.doc, logOutput, vfs],
  );

  // ── editor bridge ──────────────────────────────────────────────────────────
  const handleEditorReady = useCallback((editor: MonacoEditorNamespace.IStandaloneCodeEditor | null) => {
    editorRef.current = editor;
    setEditorReady(Boolean(editor));
  }, []);

  const handleKeyboardInsert = useCallback((text: string) => {
    editorRef.current?.trigger('mobile-keyboard-bar', 'type', { text });
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
      default:
        break;
    }
  }, []);

  // ── command palette ────────────────────────────────────────────────────────
  const commands = useMemo<CommandPaletteCommand[]>(
    () => [
      {
        id: 'view.explorer',
        label: 'View: Show Explorer',
        category: 'View',
        shortcut: '⌘1',
        action: () => {
          setActivityTab('explorer');
          setSidebarOpen(true);
        },
      },
      {
        id: 'view.search',
        label: 'View: Show Search',
        category: 'View',
        shortcut: '⌘2',
        action: () => {
          setActivityTab('search');
          setSidebarOpen(true);
        },
      },
      {
        id: 'view.collaboration',
        label: 'View: Show Collaboration',
        category: 'View',
        shortcut: '⌘3',
        action: () => {
          setActivityTab('collaboration');
          setSidebarOpen(true);
        },
      },
      {
        id: 'view.settings',
        label: 'View: Show Settings',
        category: 'View',
        action: () => {
          setActivityTab('settings');
          setSidebarOpen(true);
        },
      },
      {
        id: 'file.new',
        label: 'File: New Untitled File',
        category: 'File',
        action: () => void handleCreateFile(null),
      },
      {
        id: 'panel.toggle',
        label: 'View: Toggle Panel',
        category: 'View',
        action: () => setPanelOpen((open) => !open),
      },
      {
        id: 'editor.format',
        label: 'Editor: Format Document',
        category: 'Editor',
        shortcut: '⇧⌥F',
        action: () => editorRef.current?.getAction('editor.action.formatDocument')?.run(),
      },
      {
        id: 'collab.reconnect',
        label: 'Collaboration: Reconnect Provider',
        category: 'Collaboration',
        action: () => collab.reconnect(),
      },
      {
        id: 'collab.export',
        label: 'Collaboration: Export Workspace Snapshot',
        category: 'Collaboration',
        action: () => handleExport(),
      },
      {
        id: 'settings.resetIdentity',
        label: 'Collaboration: Reset Peer Identity',
        category: 'Collaboration',
        action: () => {
          resetLocalIdentity();
          logOutput('identity reset — reloading to apply');
          window.setTimeout(() => window.location.reload(), 400);
        },
      },
    ],
    [collab.reconnect, handleCreateFile, handleExport, logOutput],
  );

  const paletteFiles = useMemo(
    () =>
      vfs.nodes
        .filter(isVirtualFile)
        .map((node) => ({ id: node.id, label: node.name, path: node.path, language: node.language })),
    [vfs.nodes],
  );

  const runCommand = useCallback(
    (command: CommandPaletteCommand) => {
      void command.action();
      logOutput(`ran command: ${command.label}`);
    },
    [logOutput],
  );

  // ── keyboard shortcuts ─────────────────────────────────────────────────────
  useKeyboardShortcuts(
    useMemo(
      () => [
        {
          id: 'workbench.action.quickOpen',
          key: 'p',
          mod: true,
          description: 'Go to file',
          display: '⌘P',
          handler: () => {
            setPaletteMode('files');
            setPaletteOpen(true);
          },
        },
        {
          id: 'workbench.action.commandPalette',
          key: 'p',
          mod: true,
          shift: true,
          description: 'Command palette',
          display: '⇧⌘P',
          handler: () => {
            setPaletteMode('commands');
            setPaletteOpen(true);
          },
        },
        {
          id: 'workbench.action.toggleSidebar',
          key: 'b',
          mod: true,
          description: 'Toggle sidebar',
          display: '⌘B',
          handler: () => setSidebarOpen((open) => !open),
        },
        {
          id: 'workbench.action.togglePanel',
          key: '`',
          mod: true,
          description: 'Toggle panel',
          display: '⌘`',
          handler: () => setPanelOpen((open) => !open),
        },
        {
          id: 'workbench.action.closeEditor',
          key: 'w',
          mod: true,
          description: 'Close active editor',
          display: '⌘W',
          handler: () => {
            if (activeFileId) void vfs.closeFile(activeFileId);
          },
        },
        {
          id: 'workbench.action.dismiss',
          key: 'Escape',
          description: 'Dismiss overlays',
          display: 'Esc',
          allowInEditor: true,
          handler: () => {
            setPaletteOpen(false);
            if (viewport.isMobile) setSidebarOpen(false);
          },
        },
      ],
      [activeFileId, vfs, viewport.isMobile],
    ),
    { enabled: !paletteOpen },
  );

  // ── sidebar content ────────────────────────────────────────────────────────
  const sidebarContent = (() => {
    switch (activityTab) {
      case 'search':
        return <GlobalSearchView onOpenMatch={handleOpenMatch} />;
      case 'collaboration':
        return (
          <CollaborationView
            roomId={roomId}
            onRoomIdChange={setRoomId}
            connection={collab.connection}
            peers={collab.peers}
            pendingPeerCount={0}
            signalingServers={signalingServers}
            onSignalingServersChange={setSignalingServersState}
            onApplySignaling={() => collab.setSignalingServers(signalingServers)}
            localClientId={collab.identity?.clientId ?? 0}
            isHost={collab.peers.length === 0}
            onReconnect={collab.reconnect}
            onExport={handleExport}
            onImport={handleImport}
            error={vfs.error}
          />
        );
      case 'settings':
        return (
          <SettingsView
            config={config}
            onConfigChange={(patch) => setConfig((current) => ({ ...current, ...patch }))}
            onResetConfig={() => setConfig(DEFAULT_MONACO_CONFIG)}
            theme={config.theme}
            onThemeChange={(theme) => setConfig((current) => ({ ...current, theme }))}
            identity={collab.identity}
            onRename={collab.renameSelf}
            onResetIdentity={() => {
              resetLocalIdentity();
              collab.renameSelf(`Peer${Math.floor(Math.random() * 900 + 100)}`);
            }}
            storageBytes={storageBytes}
            nodeCount={vfs.nodes.length}
            workspaceCount={vfs.workspace ? 1 : 0}
          />
        );
      case 'explorer':
      default:
        return (
          <FileExplorerView
            nodes={vfs.nodes}
            activeFileId={activeFileId}
            loading={vfs.loading}
            error={vfs.error}
            expandedIds={vfs.expandedIds}
            busy={vfs.busy}
            onToggleDirectory={(directory) => vfs.toggleDirectory(directory.id)}
            onOpenFile={(node) => void vfs.openFile(node.id)}
            onRename={(node, name) => void handleRename(node, name)}
            onDelete={(node) => void handleDelete(node)}
            onCreateFile={(parent) => void handleCreateFile(parent)}
            onCreateDirectory={(parent) => void handleCreateDirectory(parent)}
            onRetry={() => void vfs.refresh()}
          />
        );
    }
  })();

  // ── fatal runtime guard ────────────────────────────────────────────────────
  if (storageAvailable === false) {
    return (
      <main className="flex h-full w-full items-center justify-center bg-vscode-bg p-6 text-center">
        <div className="max-w-md">
          <h1 className="text-sm font-semibold text-vscode-active-fg">Local storage is unavailable</h1>
          <p className="mt-2 text-xs text-vscode-description-fg">
            This editor stores every file in IndexedDB so it can work fully offline. Your browser is
            blocking IndexedDB — private browsing modes often do. Enable site storage and reload.
          </p>
        </div>
      </main>
    );
  }

  return (
    <>
      <VSCodeShell
        activityTab={activityTab}
        onActivityTabChange={(tab) => {
          setActivityTab(tab);
          if (viewport.isMobile) setSidebarOpen(true);
        }}
        sidebarOpen={sidebarOpen}
        onSidebarToggle={() => setSidebarOpen((open) => !open)}
        sidebarContent={sidebarContent}
        sidebarWidth={layout.sidebarWidth}
        onSidebarResize={(width) => setLayout((current) => ({ ...current, sidebarWidth: width }))}
        tabs={tabs}
        activeFileId={activeFileId}
        activePath={activeFile?.path ?? ''}
        siblings={siblings}
        onSelectTab={(fileId) => void vfs.openFile(fileId)}
        onCloseTab={(fileId) => void vfs.closeFile(fileId)}
        onNavigatePath={() => setActivityTab('explorer')}
        editor={
          <MonacoWrapper
            doc={collab.doc}
            fileId={activeFileId}
            filePath={activeFile?.path ?? ''}
            language={activeFile?.language ?? 'plaintext'}
            value={activeFile ? '' : ''}
            provider={collab.provider}
            config={config}
            onEditorReady={handleEditorReady}
            onDiagnosticsChange={setDiagnostics}
            onCursorChange={(position, selectionLength) =>
              setCursor({ line: position.line, column: position.column, selectionLength })
            }
            onContentChange={(next) => {
              if (activeFileId) void vfs.saveFileContent(activeFileId, next);
            }}
          />
        }
        panelOpen={panelOpen}
        panelTab={panelTab}
        panelHeight={layout.panelHeight}
        onPanelTabChange={setPanelTab}
        onPanelToggle={() => setPanelOpen((open) => !open)}
        onPanelClose={() => setPanelOpen(false)}
        onPanelResize={(height) => setLayout((current) => ({ ...current, panelHeight: height }))}
        output={output}
        diagnostics={diagnostics}
        lanLogs={collab.logs}
        lanStats={collab.stats}
        onClearLanLogs={collab.clearLogs}
        onExportLanLogs={() => {
          const blob = new Blob([collab.logs.map((entry) => JSON.stringify(entry)).join('\n')], {
            type: 'text/plain',
          });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `${roomId}-lan.log`;
          anchor.click();
          URL.revokeObjectURL(url);
        }}
        onOpenDiagnostic={(diagnostic) => {
          if (diagnostic.fileId !== 'active' && diagnostic.fileId !== activeFileId) {
            void vfs.openFile(diagnostic.fileId);
          }
        }}
        connectionState={collab.connection.connectionState}
        peerCount={collab.peers.length}
        language={activeFile?.language ?? null}
        cursor={cursor}
        workspaceName={vfs.workspace?.name ?? 'Workspace'}
        roomId={roomId}
        problemsCount={diagnostics.length}
        isMobile={viewport.isMobile}
        isTablet={viewport.isTablet}
        viewportHeight={viewport.height}
        keyboardBarVisible={viewport.isMobile || viewport.keyboardOpen}
        onKeyboardInsert={handleKeyboardInsert}
        onKeyboardCommand={handleKeyboardCommand}
        keyboardBarDisabled={!editorReady}
      />

      <CommandPaletteModal
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        files={paletteFiles}
        commands={commands}
        initialMode={paletteMode}
        onOpenFile={(fileId) => void vfs.openFile(fileId)}
        onRunCommand={runCommand}
      />
    </>
  );
}

/** Re-exported for the quick-open label of a single file. */
export function paletteLabel(fileName: string): string {
  return getFileName(fileName);
}