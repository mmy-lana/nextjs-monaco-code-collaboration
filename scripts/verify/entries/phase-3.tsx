import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FileExplorerView } from '@/components/domain/FileExplorerView';
import { EditorTabs } from '@/components/molecules/EditorTabs';
import { BreadcrumbBar } from '@/components/molecules/BreadcrumbBar';
import { PeerAvatarGroup } from '@/components/molecules/PeerAvatarGroup';
import { CommandPaletteModal } from '@/components/molecules/CommandPaletteModal';
import { MobileKeyboardBar } from '@/components/layout/MobileKeyboardBar';
import { CollaborationView } from '@/components/domain/CollaborationView';
import { GlobalSearchView, searchContents } from '@/components/domain/GlobalSearchView';
import { LanDebugConsole } from '@/components/domain/LanDebugConsole';
import type { VFSNode, VirtualDirectory, VirtualFile } from '@/types/workspace';
import type { EditorTab, SearchMatch } from '@/types/editor';
import type { LanLogEntry, LanMeshStats, PeerUser, RoomConnectionInfo } from '@/types/collaboration';

/** Every callback fired by the harness surfaces here for the suite to assert. */
const events: string[] = [];

const record = (event: string): void => {
  events.push(event);
};

const now = 1_700_000_000_000;

const directory = (id: string, name: string, parentId: string | null, parentPath: string): VirtualDirectory => ({
  id,
  workspaceId: 'phase3',
  parentId,
  name,
  type: 'directory',
  path: `${parentPath}/${name}`,
  language: 'plaintext',
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  size: 0,
});

const file = (
  id: string,
  name: string,
  parentId: string | null,
  parentPath: string,
  language: string,
): VirtualFile => ({
  id,
  workspaceId: 'phase3',
  parentId,
  name,
  type: 'file',
  path: `${parentPath}/${name}`,
  extension: name.split('.').pop() ?? '',
  language,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  size: 128,
  contentId: id,
});

const FIXTURE_NODES: VFSNode[] = [
  directory('src', 'src', null, ''),
  directory('hooks', 'hooks', 'src', '/src'),
  file('index-ts', 'index.ts', 'src', '/src', 'typescript'),
  file('usevfs-ts', 'useVFS.ts', 'hooks', '/src/hooks', 'typescript'),
  file('readme-md', 'README.md', null, '', 'markdown'),
];

const FIXTURE_TABS: EditorTab[] = [
  { fileId: 'index-ts', filePath: '/src/index.ts', fileName: 'index.ts', language: 'typescript', isDirty: false, isPinned: true },
  { fileId: 'usevfs-ts', filePath: '/src/hooks/useVFS.ts', fileName: 'useVFS.ts', language: 'typescript', isDirty: true, isPinned: false },
];

const FIXTURE_PEERS: PeerUser[] = [
  { clientId: 11, name: 'Ada Lovelace', color: '#f87171', cursor: { line: 4, column: 2 }, selection: null, activeFileId: 'index-ts', lastActive: now + 5_000, isHost: true },
  { clientId: 22, name: 'Grace Hopper', color: '#22d3ee', cursor: null, selection: null, activeFileId: null, lastActive: now - 120_000, isHost: false },
  { clientId: 33, name: 'Alan Turing', color: '#a3e635', cursor: null, selection: null, activeFileId: null, lastActive: now, isHost: false },
];

const FIXTURE_CONNECTION: RoomConnectionInfo = {
  roomId: 'collab-workspace-lan',
  connectionState: 'connected',
  peerCount: 3,
  signalingServers: ['ws://localhost:4444'],
  webrtcSupported: true,
};

const FIXTURE_LOG: LanLogEntry[] = [
  { id: 'l1', timestamp: now, level: 'info', channel: 'signaling', message: 'connecting to ws://localhost:4444' },
  { id: 'l2', timestamp: now + 1, level: 'warn', channel: 'webrtc', message: 'signaling unreachable, using BroadcastChannel' },
  { id: 'l3', timestamp: now + 2, level: 'success', channel: 'awareness', message: 'peer 22 announced' },
];

const FIXTURE_STATS: LanMeshStats = {
  roomId: 'collab-workspace-lan',
  peerCount: 3,
  signalingConnected: false,
  signalingServers: ['ws://localhost:4444'],
  broadcastChannelSupported: true,
  persistenceSynced: true,
  bytesSent: 2048,
  bytesReceived: 8192,
  updatedAt: now,
};

const FIXTURE_MATCHES: SearchMatch[] = [
  { fileId: 'index-ts', filePath: '/src/index.ts', lineNumber: 12, lineText: 'const db = getDB();', matchStart: 11, matchEnd: 16 },
  { fileId: 'usevfs-ts', filePath: '/src/hooks/useVFS.ts', lineNumber: 3, lineText: '  const db = getDB();', matchStart: 13, matchEnd: 18 },
];

function Phase3Harness() {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(['src']));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activeFileId, setActiveFileId] = useState<string | null>('index-ts');
  const [signalingServers, setSignalingServers] = useState<string[]>(['ws://localhost:4444']);
  const [keyboardBarVisible, setKeyboardBarVisible] = useState(true);
  const [logEntries, setLogEntries] = useState<LanLogEntry[]>(FIXTURE_LOG);
  const [explorerNodes, setExplorerNodes] = useState<VFSNode[]>(FIXTURE_NODES);
  const [explorerError, setExplorerError] = useState<string | null>(null);

  const toggleDirectory = useCallback((node: VirtualDirectory) => {
    record(`toggle:${node.id}`);
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, []);

  const openFile = useCallback((node: VirtualFile) => {
    record(`open:${node.id}`);
    setActiveFileId(node.id);
  }, []);

  const renameNode = useCallback((node: VFSNode, nextName: string) => {
    record(`rename:${node.id}:${nextName}`);
    setExplorerNodes((current) =>
      current.map((candidate) =>
        candidate.id === node.id ? { ...candidate, name: nextName } : candidate,
      ),
    );
  }, []);

  const deleteNode = useCallback((node: VFSNode) => {
    record(`delete:${node.id}`);
  }, []);

  const createFile = useCallback((parent: VirtualDirectory | null) => {
    record(`create-file:${parent?.id ?? 'root'}`);
  }, []);

  const createDirectory = useCallback((parent: VirtualDirectory | null) => {
    record(`create-dir:${parent?.id ?? 'root'}`);
  }, []);

  const openMatch = useCallback((match: SearchMatch) => {
    record(`open-match:${match.fileId}:${match.lineNumber}`);
  }, []);

  const paletteFiles = useMemo(
    () =>
      FIXTURE_NODES.filter((node): node is VirtualFile => node.type === 'file').map((node) => ({
        id: node.id,
        label: node.name,
        path: node.path,
        language: node.language,
      })),
    [],
  );

  const paletteCommands = useMemo(
    () => [
      { id: 'cmd-format', label: 'Format Document', category: 'Editor', shortcut: '⇧⌥F' },
      { id: 'cmd-save', label: 'Save Workspace', category: 'File' },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-6 p-4" style={{ background: 'var(--vscode-bg)' }} data-testid="phase3-root">
      <section className="h-[420px] w-[320px] border border-vscode-border">
        <FileExplorerView
          nodes={explorerNodes}
          activeFileId={activeFileId}
          loading={false}
          error={explorerError}
          expandedIds={expandedIds}
          busy={false}
          onToggleDirectory={toggleDirectory}
          onOpenFile={openFile}
          onRename={renameNode}
          onDelete={deleteNode}
          onCreateFile={createFile}
          onCreateDirectory={createDirectory}
          onRetry={() => {
            record('explorer-retry');
            setExplorerError(null);
          }}
        />
      </section>

      <section className="w-[600px]">
        <EditorTabs
          tabs={FIXTURE_TABS}
          activeFileId={activeFileId}
          onSelect={(fileId) => record(`tab-select:${fileId}`)}
          onClose={(fileId) => record(`tab-close:${fileId}`)}
          onPinToggle={(fileId, pinned) => record(`tab-pin:${fileId}:${pinned}`)}
        />
        <BreadcrumbBar
          path="/src/hooks/useVFS.ts"
          siblings={['useVFS.ts', 'useVFS.test.ts']}
          onNavigate={(path) => record(`breadcrumb:${path}`)}
          onSelectSibling={(name) => record(`sibling:${name}`)}
        />
      </section>

      <section className="w-[320px]">
        <PeerAvatarGroup peers={FIXTURE_PEERS} pendingCount={1} max={2} onSelectPeer={(peer) => record(`peer:${peer.clientId}`)} />
        <PeerAvatarGroup peers={[]} />
      </section>

      <section className="w-[420px]">
        <button
          type="button"
          data-testid="toggle-palette"
          className="mb-2 h-7 rounded-sm bg-vscode-button-secondary px-2 text-xs"
          onClick={() => setPaletteOpen((value) => !value)}
        >
          Toggle palette
        </button>
        <button
          type="button"
          data-testid="toggle-keyboard-bar"
          className="mb-2 ml-2 h-7 rounded-sm bg-vscode-button-secondary px-2 text-xs"
          onClick={() => setKeyboardBarVisible((value) => !value)}
        >
          Toggle keyboard bar
        </button>

        <CommandPaletteModal
          open={paletteOpen}
          onClose={() => {
            record('palette-close');
            setPaletteOpen(false);
          }}
          files={paletteFiles}
          commands={paletteCommands.map((command) => ({
            ...command,
            action: () => record(`command:${command.id}`),
          }))}
          onOpenFile={(fileId) => record(`palette-open:${fileId}`)}
          onRunCommand={(command) => {
            record(`palette-command:${command.id}`);
            return command.action();
          }}
        />
      </section>

      <section className="w-[420px]">
        <MobileKeyboardBar
          visible={keyboardBarVisible}
          onInsert={(text) => record(`insert:${text}`)}
          onCommand={(command) => record(`kbd:${command}`)}
        />
      </section>

      <section className="h-[420px] w-[320px] border border-vscode-border">
        <CollaborationView
          roomId="collab-workspace-lan"
          onRoomIdChange={(roomId) => record(`room:${roomId}`)}
          connection={FIXTURE_CONNECTION}
          peers={FIXTURE_PEERS}
          pendingPeerCount={1}
          signalingServers={signalingServers}
          onSignalingServersChange={(servers) => {
            record(`signaling:${servers.join('|')}`);
            setSignalingServers(servers);
          }}
          onApplySignaling={() => record('signaling-apply')}
          localClientId={1}
          isHost
          onReconnect={() => record('reconnect')}
          onExport={() => record('export')}
          onImport={(fileHandle) => record(`import:${fileHandle.name}`)}
          error={null}
        />
      </section>

      <section className="h-[360px] w-[420px] border border-vscode-border">
        <GlobalSearchView injectedResults={FIXTURE_MATCHES} onOpenMatch={openMatch} />
      </section>

      <section className="h-[320px] w-[560px] border border-vscode-border">
        <LanDebugConsole
          entries={logEntries}
          stats={FIXTURE_STATS}
          onClear={() => {
            record('log-clear');
            setLogEntries([]);
          }}
          onExport={() => record('log-export')}
        />
      </section>

      <section className="flex gap-2">
        <button
          type="button"
          data-testid="explorer-break"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2 text-xs"
          onClick={() => setExplorerError('IndexedDB upgrade was blocked by another tab.')}
        >
          Break explorer
        </button>
        <button
          type="button"
          data-testid="explorer-empty"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2 text-xs"
          onClick={() => setExplorerNodes([])}
        >
          Empty explorer
        </button>
        <button
          type="button"
          data-testid="explorer-restore"
          className="h-7 rounded-sm bg-vscode-button-secondary px-2 text-xs"
          onClick={() => {
            setExplorerError(null);
            setExplorerNodes(FIXTURE_NODES);
          }}
        >
          Restore explorer
        </button>
      </section>
    </div>
  );
}

export interface Phase3Api {
  events: string[];
  reset: () => void;
  searchProbe: {
    results: SearchMatch[];
    emptyQuery: number;
    caseInsensitive: number;
    perFileCap: number;
  };
}

export function mountPhase3(container: HTMLElement): void {
  // The entry self-mounts when injected into a loaded document *and* the suite
  // calls the explicit bridge; mounting twice would create two React roots on
  // one container.
  window.__phase3MountCount = (window.__phase3MountCount ?? 0) + 1;
  if (window.__phase3Root) return;
  window.__phase3Root = true;

  createRoot(container).render(<Phase3Harness />);

  const paths = new Map<string, string>([
    ['index-ts', '/src/index.ts'],
    ['usevfs-ts', '/src/hooks/useVFS.ts'],
  ]);

  window.__phase3 = {
    get events() {
      return [...events];
    },
    reset: () => {
      events.length = 0;
    },
    searchProbe: {
      results: searchContents(
        'getdb',
        [
          { contentId: 'index-ts', plainText: 'const db = getDB();\nconst other = getDB();' },
          { contentId: 'usevfs-ts', plainText: 'nothing here' },
        ],
        paths,
      ),
      emptyQuery: searchContents('', [{ contentId: 'a', plainText: 'x' }], paths).length,
      caseInsensitive: searchContents('GETDB', [{ contentId: 'a', plainText: 'value getdb()' }], paths)
        .length,
      perFileCap: searchContents(
        'x',
        [{ contentId: 'a', plainText: 'x\nx\nx\nx\nx' }],
        paths,
        2,
      ).length,
    },
  };
}

declare global {
  interface Window {
    __phase3?: Phase3Api;
    __phase3Mount?: () => void;
    __phase3Root?: boolean;
    __phase3MountCount?: number;
  }
}

const tryMount = (): void => {
  const container = document.getElementById('phase3-container');
  if (container) mountPhase3(container);
};

window.__phase3Mount = tryMount;

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', tryMount);
} else {
  tryMount();
}

declare global {
  interface Window {
    __phase3Mount?: () => void;
  }
}