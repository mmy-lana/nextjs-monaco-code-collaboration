# Specification and Implementation Plan: Real-Time Code Collaboration Editor

**Repository:** `nextjs-monaco-code-collaboration`  
**Stack:** Next.js (App Router, Client & Server Components), Monaco Editor, Yjs (CRDT), Y-IndexedDB (Local Document Persistence), Y-WebRTC (LAN/P2P Sync), Dexie.js (Workspace Metadata), Tailwind CSS.  
**Aesthetic:** Visual Studio Code Web Theme (Activity Bar, Sidebar, Editor Area with Tabs, Panel/Console, Status Bar, Quick Open / Command Palette).  
**Network Architecture:** Offline-first peer-to-peer over Local Area Network (LAN) utilizing WebRTC mesh channels with IndexedDB persistence. Requires zero central database or hosted backend; fully functional offline and across local network subnets.

---

## 1. Data Schema & Pure TypeScript Interfaces

```typescript
// types/workspace.ts

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
  deletedAt: number | null; // Soft-delete tombstone to teardown bindings before physical wipe
  size: number;
}

export interface VirtualFile extends VFSNode {
  type: 'file';
  contentId: string; // Reference key for Yjs Text fragment and Dexie content table
}

export interface VirtualDirectory extends VFSNode {
  type: 'directory';
  // Note: Directory children are derived query-side via db.nodes.where('parentId').equals(dir.id)
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

// types/collaboration.ts

export interface PeerUser {
  clientId: number;
  name: string;
  color: string;
  cursor: {
    line: number;
    column: number;
  } | null;
  selection: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
  activeFileId: string | null;
  lastActive: number;
  isHost: boolean;
}

export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'disconnected';

export interface SignalingConfig {
  servers: string[];
  iceServers: RTCIceServer[];
}

export interface RoomConnectionInfo {
  roomId: string;
  connectionState: ConnectionState;
  peerCount: number;
  signalingServers: string[];
  webrtcSupported: boolean;
}

// types/editor.ts

export interface EditorTab {
  fileId: string;
  filePath: string;
  fileName: string;
  language: string;
  isDirty: boolean;
  isPinned: boolean;
}

export interface MonacoEditorConfig {
  theme: 'vs-dark' | 'vs-light' | 'hc-black';
  fontSize: number;
  tabSize: number;
  wordWrap: 'on' | 'off' | 'wordWrapColumn' | 'bounded';
  minimap: {
    enabled: boolean;
  };
  lineNumbers: 'on' | 'off' | 'relative';
  readOnly: boolean;
  // Handled via application save hooks; not forwarded directly to Monaco constructor
  formatOnSave: boolean;
  cursorBlinking: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
  cursorStyle: 'line' | 'block' | 'underline';
}

export type ActivityBarTab = 'explorer' | 'search' | 'collaboration' | 'settings';

export type BottomPanelTab = 'terminal' | 'output' | 'problems' | 'lan-debug';

export interface DiagnosticItem {
  id: string;
  fileId: string;
  filePath: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  source: string;
}

export interface CommandPaletteItem {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void | Promise<void>;
}
```

```typescript
// db/schema.ts
import Dexie, { type Table } from 'dexie';
import type { WorkspaceMetadata, VFSNode } from '@/types/workspace';

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_CHARACTERS = 500_000;

export interface StoredFileContent {
  contentId: string;
  binaryState: Uint8Array; // Serialized Yjs document update buffer
  plainText: string;       // Fallback snapshot for full-text search
  size: number;
  updatedAt: number;
}

export interface StoredSetting {
  key: string;
  value: unknown;
}

export class LocalWorkspaceDB extends Dexie {
  workspaces!: Table<WorkspaceMetadata, string>;
  nodes!: Table<VFSNode, string>;
  contents!: Table<StoredFileContent, string>;
  settings!: Table<StoredSetting, string>;

  constructor() {
    // Namespaced explicitly to avoid collision with Y-IndexedDB ('LANCodeCollab-crdt-{roomId}')
    super('LANCodeCollab-meta');
    this.version(1).stores({
      workspaces: 'id, roomId, updatedAt',
      nodes: 'id, workspaceId, parentId, &path, type, language, deletedAt',
      contents: 'contentId, updatedAt, size',
      settings: 'key'
    });
  }
}

let dbInstance: LocalWorkspaceDB | null = null;

export const getDB = (): LocalWorkspaceDB => {
  if (typeof window === 'undefined') {
    throw new Error('LocalWorkspaceDB can only be instantiated in client-side runtime');
  }
  if (!dbInstance) {
    dbInstance = new LocalWorkspaceDB();
  }
  return dbInstance;
};
```

---

## 2. Component Architecture

```
src/
├── app/
│   ├── layout.tsx                     # Root HTML shell, meta tags, fonts, viewport configs
│   ├── page.tsx                       # Workspace bootstrapper & layout coordinator
│   └── globals.css                    # Tailwind v4 import, VS Code tokens, scrollbars
├── components/
│   ├── primitives/                    # Low-level accessible primitives
│   │   ├── ActionButton.tsx           # Touch & mouse optimized button
│   │   ├── DropdownMenu.tsx           # Context menus without hover dependency
│   │   ├── ModalOverlay.tsx           # Backdrop with focus trap
│   │   ├── ResizableSplitter.tsx      # Multi-pointer drag divider (touch-action: none)
│   │   ├── Tooltip.tsx                # Press-and-hold (mobile) & hover (desktop) tooltip
│   │   └── TextInput.tsx              # Input with VS Code styling & clear button
│   ├── layout/
│   │   ├── VSCodeShell.tsx            # CSS Grid/Flex coordinator matching VS Code layout
│   │   ├── ActivityBar.tsx            # Leftmost 48px strip with safe-area padding
│   │   ├── PrimarySidebar.tsx         # Collapsible panel (Explorer, Search, LAN Peers)
│   │   ├── EditorArea.tsx             # Tab bar + dynamic Monaco instance
│   │   ├── BottomPanel.tsx            # Output, problems, peer connection logs
│   │   ├── StatusBar.tsx              # Footer bar: branch, line/col, encoding, peer count
│   │   └── MobileKeyboardBar.tsx      # Mobile helper tray above visual viewport (undo/redo/tab)
│   ├── molecules/
│   │   ├── FileTreeNode.tsx           # Recursive file/folder item with explicit action menus
│   │   ├── EditorTabs.tsx             # Scrollable/reorderable editor tab strip
│   │   ├── PeerAvatarGroup.tsx        # Dynamic peer list with online status indicators
│   │   ├── BreadcrumbBar.tsx          # Current active file path segments
│   │   └── CommandPaletteModal.tsx    # Responsive fuzzy quick open / command runner
│   └── domain/
│       ├── MonacoDynamic.tsx          # Client-only dynamic loader wrapper (ssr: false)
│       ├── MonacoWrapper.tsx          # Monaco instance with native Yjs text sync & awareness
│       ├── FileExplorerView.tsx       # File tree operations, directory/file creation
│       ├── CollaborationView.tsx      # LAN Room ID, WebRTC status, signaling info, export
│       ├── GlobalSearchView.tsx       # Local full-text content search through IndexedDB
│       └── LanDebugConsole.tsx        # Real-time WebRTC mesh logs, packet counts, latency
├── hooks/
│   ├── useVFS.ts                      # Virtual file system mutations, Dexie live sync, tab reconciliation
│   ├── useYjsCollaboration.ts         # Y.Doc, Y.WebRtcProvider, and awareness coordination
│   ├── useMonacoBinding.ts            # ESM Monaco-to-Yjs binding & remote cursor decorator
│   ├── useResponsiveLayout.ts         # Touch, visual viewport dimension, and keyboard height tracker
│   └── useKeyboardShortcuts.ts        # Desktop & tablet key-event registry
├── services/
│   ├── yjsProvider.ts                 # WebRTC LAN provider & IndexedDB sync (PURE SERVICE: zero hook imports)
│   ├── signalingConfig.ts             # Local broadcast addresses, protocol switcher, and ICE candidates
│   └── languageDetector.ts            # Extension-to-Monaco language map
└── utils/
    ├── colorGenerator.ts              # Deterministic peer cursor color assigner
    ├── pathUtils.ts                   # Virtual path resolver, normalizer, and sanitizer
    └── platform.ts                    # Device, OS, and pointer type detection
```

---

## 3. Core Feature Logic & Step-by-Step Implementation

### A. Dynamic LAN Signaling & CRDT Topology
1. **Network Discovery:** The client uses `y-webrtc` configured with customizable broadcast/signaling servers. In an air-gapped LAN, clients connect to a locally hosted signaling instance (`ws://` when on an `http://` origin, or secure `wss://` when served over `https://` to satisfy browser mixed-content constraints) with automatic fallback to browser-level `BroadcastChannel` across tabs.
2. **Deterministic Document Routing:** Each file is represented by a separate `Y.Text` sub-type nested within the central root `Y.Doc` (keyed by `files.<contentId>`), preventing race conditions when multiple users edit distinct files simultaneously.
3. **Local-First Write Strategy:** 
   - Step 1: User types in Monaco.
   - Step 2: Custom two-way binding applies editor deltas to `Y.Text` and applies remote `Y.Text` events via `editor.executeEdits()`.
   - Step 3: `y-indexeddb` writes updates to IndexedDB (database: `'LANCodeCollab-crdt-{roomId}'`) via microtasks.
   - Step 4: `y-webrtc` broadcasts encoded state vector updates to peers.
   - Step 5: Remote updates trigger Monaco decorations and awareness cursor pills.

### B. Remote Cursor & Selection Pipeline
1. Cursors are tracked via `provider.awareness.setLocalStateField('user', { ... })`.
2. Monaco creates remote decorations dynamically using Monaco's `editor.deltaDecorations`:
   - Cursor flag: A 2px vertical CSS line matching `peer.color`.
   - Cursor tooltip: A small floating pill showing `peer.name` above the line, fading after 3 seconds of inactivity.
   - Selection highlight: Semi-transparent background box (`peer.color` at 0.2 opacity).
3. Selection updates are throttled using `requestAnimationFrame` to avoid WebRTC data channel saturation.

### C. Mobile-First Adaptability Logic
1. **Viewport Height Management:** Virtual keyboards on iOS/Android break standard 100vh. The layout hooks into `window.visualViewport` to dynamically set `--vh`, `--keyboard-height`, and `--keyboard-bar-height`, calculating the Monaco editor container height as `calc(var(--vh, 1vh) * 100 - var(--statusbar-height) - var(--keyboard-bar-height))`.
2. **Touch-First Accessibility:**
   - On screens `< 768px`, the Primary Sidebar becomes a sliding drawer anchored to the left.
   - The Activity Bar shifts to a compact bottom navigation bar with `padding-bottom: env(safe-area-inset-bottom, 0px)`.
   - No hover actions: File delete/rename actions are triggered via explicit trailing action buttons (`...` button) instead of CSS `:hover` visibility.
   - Monaco Editor touches trigger an auxiliary on-screen accessory bar providing `Tab`, `Shift+Tab`, `{`, `}`, `[`, `]`, `(`, `)`, `;`, `=`, and undo/redo buttons.

---

## 4. Five-Phase Sequential Implementation Queue

```
================================================================================
PHASE 1: Types, Storage/API Client Config, and Base Utilities
================================================================================
[x] Step 1.1: Core TypeScript Definitions
    - File: src/types/workspace.ts
    - File: src/types/collaboration.ts
    - File: src/types/editor.ts
    - Implementation: Pure types, union literals, discrimination guards (isVirtualFile, isVirtualDirectory), zero runtime dependencies.

[x] Step 1.2: Local Database (Dexie.js) Layer
    - File: src/db/schema.ts
    - Implementation: LocalWorkspaceDB instance named 'LANCodeCollab-meta', unique &path index, deletedAt index, lazy getDB() getter.

[x] Step 1.3: Path Utilities & Language Resolution
    - File: src/utils/pathUtils.ts
    - File: src/utils/languageDetector.ts
    - Implementation: Path sanitization, tree traversal helpers, extension-to-Monaco language mappings.

[x] Step 1.4: Peer Identity & Color Assignment
    - File: src/utils/colorGenerator.ts
    - File: src/utils/platform.ts
    - Implementation: Deterministic HSL-to-HEX color generation based on client ID / peer name; OS/touch capability checks.

================================================================================
PHASE 2: Design Foundation & Atomic UI Primitives
================================================================================
[x] Step 2.1: VS Code Theme CSS & Dynamic Viewport Setup
    - File: src/app/globals.css
    - Implementation: Tailwind v4 import, VS Code tokens, custom scrollbars, .vscode-chrome non-selectable scope, .monaco-editor-container selectable text.

[x] Step 2.2: Low-Level UI Primitives
    - File: src/components/primitives/ActionButton.tsx
    - File: src/components/primitives/TextInput.tsx
    - File: src/components/primitives/DropdownMenu.tsx
    - File: src/components/primitives/Tooltip.tsx
    - Implementation: Accessible controls without hover reliance; touch targets min 44x44px on mobile devices.

[x] Step 2.3: Layout Primitives
    - File: src/components/primitives/ResizableSplitter.tsx
    - File: src/components/primitives/ModalOverlay.tsx
    - Implementation: Multi-touch and pointer draggable splitters with touch-action: none; modal backdrop with scroll-lock.

================================================================================
PHASE 3: Compound Molecules & Feature Components
================================================================================
[x] Step 3.1: File Tree Componentry
    - File: src/components/molecules/FileTreeNode.tsx
    - File: src/components/domain/FileExplorerView.tsx
    - Implementation: Expandable folders, active file highlight, explicit contextual menus for Rename/Delete/Create (touch-ready).

[x] Step 3.2: Editor Tabs & Breadcrumbs
    - File: src/components/molecules/EditorTabs.tsx
    - File: src/components/molecules/BreadcrumbBar.tsx
    - Implementation: Scrollable horizontal tab strip with close buttons, dirty indicators, and file hierarchy breadcrumbs.

[x] Step 3.3: Collaboration & LAN Controls
    - File: src/components/molecules/PeerAvatarGroup.tsx
    - File: src/components/domain/CollaborationView.tsx
    - Implementation: Room ID configuration, local signaling server entry field, peer list with color badges, connection status chip.

[x] Step 3.4: Quick Open & Command Palette
    - File: src/components/molecules/CommandPaletteModal.tsx
    - Implementation: Responsive fuzzy search across files and actions with max-height/scroll on small screens; keyboard navigable.

[x] Step 3.5: Mobile Accessory Bar
    - File: src/components/layout/MobileKeyboardBar.tsx
    - Implementation: Horizontal quick-input bar fixed above the software keyboard for brackets, indentation, and undo/redo.

================================================================================
PHASE 4: Domain Logic, Reactive State, and Specialized APIs
================================================================================
[x] Step 4.1: Virtual File System (VFS) Store
    - File: src/hooks/useVFS.ts
    - Implementation: Dexie-backed file system CRUD operations, directory structure flattening/expansion, active file switcher, and orphan tab reconciliation on load (filtering openFileIds and activeFileId against non-deleted nodes).

[x] Step 4.2: Yjs WebRTC & IndexedDB Synchronization Provider
    - File: src/services/signalingConfig.ts
    - File: src/services/yjsProvider.ts
    - File: src/hooks/useYjsCollaboration.ts
    - Implementation: Pure service document lifecycle, y-webrtc LAN mesh instantiation, y-indexeddb persistence to 'LANCodeCollab-crdt-{roomId}', and awareness state binding.

[x] Step 4.3: Monaco Editor ESM Binding & Remote Cursors
    - File: src/hooks/useMonacoBinding.ts
    - File: src/components/domain/MonacoWrapper.tsx
    - File: src/components/domain/MonacoDynamic.tsx
    - Implementation: SSR-safe dynamic import wrapper (ssr: false), native two-way delta sync via yText.observe and editor.executeEdits, remote cursor deltaDecorations.

[x] Step 4.4: Viewport & Layout Responsiveness Engine
    - File: src/hooks/useResponsiveLayout.ts
    - File: src/hooks/useKeyboardShortcuts.ts
    - Implementation: Tracks visualViewport resizing and virtual keyboard states; switches between desktop multi-pane and mobile drawer navigation; registers global shortcuts.

================================================================================
PHASE 5: Complete Page/Screen Assembly & Responsive Shell
================================================================================
[x] Step 5.1: VS Code Structural Shell Assembly
    - File: src/components/layout/ActivityBar.tsx
    - File: src/components/layout/PrimarySidebar.tsx
    - File: src/components/layout/BottomPanel.tsx
    - File: src/components/layout/StatusBar.tsx
    - File: src/components/layout/VSCodeShell.tsx
    - Implementation: Assembles all panels with adjustable splitters, collapsible sidebars, and tabbed status footers.

[x] Step 5.2: Root Page Integration & Default Workspace Initialization
    - File: src/app/page.tsx
    - Implementation: Orchestrates VFS, Yjs room initialization, dynamic import of Monaco editor, default workspace seed (starter files).

[x] Step 5.3: Responsive & Touch Layout Validation
    - Testing checkpoints:
      - 360px (Small Android: Galaxy S8/S9): Activity bar shifts to bottom nav with safe-area padding, sidebar collapses to full overlay drawer, mobile accessory bar engages.
      - 390px (iPhone 12/13/14 Pro): Visual viewport height tracks virtual keyboard changes without clipping Monaco code lines.
      - 430px (iPhone Pro Max): Ensure file action buttons (...) have adequate touch targets (>= 44px) without horizontal page overflow.
      - 768px (iPad/Tablet portrait): Split view enabled; collapsible drawer mode toggleable with dedicated top bar icon.
      - 1024px+ (Desktop): Full VS Code desktop layout with drag-to-resize splitters, hover tooltips, and multi-cursor support.
```

---

## 5. Detailed Implementation Blueprint for Core Modules

### 5.1 Step 1.3: Path Utilities Implementation
```typescript
// src/utils/pathUtils.ts

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
```

### 5.2 Step 1.4: Peer Identity & Deterministic Colors
```typescript
// src/utils/colorGenerator.ts

const PEER_COLORS = [
  '#f87171', // Red
  '#fb923c', // Orange
  '#fbbf24', // Amber
  '#4ade80', // Green
  '#34d399', // Emerald
  '#22d3ee', // Cyan
  '#60a5fa', // Blue
  '#818cf8', // Indigo
  '#c084fc', // Purple
  '#f472b6', // Pink
];

export function getPeerColor(clientId: number): string {
  const index = Math.abs(clientId) % PEER_COLORS.length;
  return PEER_COLORS[index];
}

export function generateRandomUsername(): string {
  const adjectives = ['Swift', 'Agile', 'Bright', 'Clever', 'Quiet', 'Wired', 'Hyper', 'Sonic'];
  const nouns = ['Coder', 'Hacker', 'Builder', 'Dev', 'Engineer', 'Architect', 'Scripter'];
  const randAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const randNum = Math.floor(100 + Math.random() * 900);
  return `${randAdj}${randNoun}#${randNum}`;
}
```

### 5.3 Step 4.2: Yjs LAN & WebRTC Provider Architecture
```typescript
// src/services/signalingConfig.ts
import type { SignalingConfig } from '@/types/collaboration';

export const DEFAULT_SIGNALING: SignalingConfig = {
  servers: typeof window !== 'undefined' && window.location.protocol === 'https:'
    ? ['wss://localhost:4444']
    : ['ws://localhost:4444'],
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ]
};

// src/services/yjsProvider.ts
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { IndexeddbPersistence } from 'y-indexeddb';
import { DEFAULT_SIGNALING } from '@/services/signalingConfig';

export interface YjsCollaborationSession {
  doc: Y.Doc;
  webrtcProvider: WebrtcProvider;
  idbPersistence: IndexeddbPersistence;
  destroy: () => void;
}

// Pure service: zero React hook dependencies
export function createCollaborationSession(
  roomId: string,
  signalingServers: string[] = DEFAULT_SIGNALING.servers
): YjsCollaborationSession {
  const doc = new Y.Doc();

  // Namespaced to prevent conflict with Dexie metadata database
  const idbPersistence = new IndexeddbPersistence(`LANCodeCollab-crdt-${roomId}`, doc);

  const webrtcProvider = new WebrtcProvider(roomId, doc, {
    signaling: signalingServers,
    maxConns: 30,
    filterBcConns: true,
    peerOpts: {
      config: {
        iceServers: DEFAULT_SIGNALING.iceServers
      }
    }
  });

  return {
    doc,
    webrtcProvider,
    idbPersistence,
    destroy: () => {
      webrtcProvider.destroy();
      idbPersistence.destroy();
      doc.destroy();
    }
  };
}
```

### 5.4 Step 4.3: Monaco ESM Binding & Remote Cursor Logic
```typescript
// src/hooks/useMonacoBinding.ts
import { useEffect, useRef } from 'react';
import type { editor } from 'monaco-editor';
import * as Y from 'yjs';
import type { WebrtcProvider } from 'y-webrtc';
import type { PeerUser } from '@/types/collaboration';

export function parsePeerState(raw: unknown): PeerUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const cand = raw as Record<string, unknown>;
  const user = cand.user;
  if (!user || typeof user !== 'object') return null;
  const u = user as Record<string, unknown>;
  if (typeof u.name !== 'string' || typeof u.color !== 'string') return null;
  return {
    clientId: typeof u.clientId === 'number' ? u.clientId : 0,
    name: u.name,
    color: u.color,
    cursor: u.cursor && typeof u.cursor === 'object' ? (u.cursor as { line: number; column: number }) : null,
    selection: u.selection && typeof u.selection === 'object' ? (u.selection as PeerUser['selection']) : null,
    activeFileId: typeof u.activeFileId === 'string' ? u.activeFileId : null,
    lastActive: typeof u.lastActive === 'number' ? u.lastActive : Date.now(),
    isHost: Boolean(u.isHost)
  };
}

interface UseMonacoBindingProps {
  editor: editor.IStandaloneCodeEditor | null;
  doc: Y.Doc | null;
  fileId: string | null;
  provider: WebrtcProvider | null;
}

export function useMonacoBinding({ editor, doc, fileId, provider }: UseMonacoBindingProps) {
  const decorationsRef = useRef<string[]>([]);
  const isApplyingRemoteRef = useRef(false);

  useEffect(() => {
    if (!editor || !doc || !fileId || !provider) return;
    const model = editor.getModel();
    if (!model) return;

    const yText = doc.getText(`file-${fileId}`);

    // Initial content hydration if editor is empty
    if (model.getValue() === '' && yText.length > 0) {
      model.setValue(yText.toString());
    } else if (yText.length === 0 && model.getValue().length > 0) {
      yText.insert(0, model.getValue());
    }

    // 1. Monaco -> Yjs delta binding
    const contentDisposable = editor.onDidChangeModelContent((e) => {
      if (isApplyingRemoteRef.current) return;
      doc.transact(() => {
        for (const change of e.changes) {
          yText.delete(change.rangeOffset, change.rangeLength);
          yText.insert(change.rangeOffset, change.text);
        }
      }, 'monaco-input');
    });

    // 2. Yjs -> Monaco delta binding
    const handleYTextChange = (event: Y.YTextEvent) => {
      if (event.transaction.origin === 'monaco-input') return;
      isApplyingRemoteRef.current = true;
      try {
        let index = 0;
        for (const delta of event.delta) {
          if (delta.retain !== undefined) {
            index += delta.retain;
          } else if (delta.delete !== undefined) {
            const startPos = model.getPositionAt(index);
            const endPos = model.getPositionAt(index + delta.delete);
            editor.executeEdits('yjs-remote', [{
              range: {
                startLineNumber: startPos.line,
                startColumn: startPos.column,
                endLineNumber: endPos.line,
                endColumn: endPos.column
              },
              text: '',
              forceMoveMarkers: true
            }]);
          } else if (delta.insert !== undefined) {
            const text = typeof delta.insert === 'string' ? delta.insert : '';
            const pos = model.getPositionAt(index);
            editor.executeEdits('yjs-remote', [{
              range: {
                startLineNumber: pos.line,
                startColumn: pos.column,
                endLineNumber: pos.line,
                endColumn: pos.column
              },
              text,
              forceMoveMarkers: true
            }]);
            index += text.length;
          }
        }
      } finally {
        isApplyingRemoteRef.current = false;
      }
    };
    yText.observe(handleYTextChange);

    // 3. Awareness Cursor & Selection Pipeline
    const handleAwarenessChange = () => {
      const states = provider.awareness.getStates();
      const newDecorations: editor.IModelDeltaDecoration[] = [];

      states.forEach((rawState, clientId) => {
        if (clientId === doc.clientID) return;
        const peer = parsePeerState(rawState);
        if (!peer || peer.activeFileId !== fileId || !peer.cursor) return;

        newDecorations.push({
          range: {
            startLineNumber: peer.cursor.line,
            startColumn: peer.cursor.column,
            endLineNumber: peer.cursor.line,
            endColumn: peer.cursor.column + 1
          },
          options: {
            className: `yRemoteSelection-${clientId}`,
            beforeContentClassName: `yRemoteCursor-${clientId}`,
            hoverMessage: { value: `Peer: ${peer.name}` }
          }
        });
      });

      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, newDecorations);
    };

    provider.awareness.on('change', handleAwarenessChange);

    // 4. Cursor position broadcaster
    const cursorDisposable = editor.onDidChangeCursorPosition((e) => {
      const currentUser = parsePeerState(provider.awareness.getLocalState()) || {
        clientId: doc.clientID,
        name: 'Peer',
        color: '#007acc',
        cursor: null,
        selection: null,
        activeFileId: fileId,
        lastActive: Date.now(),
        isHost: false
      };

      provider.awareness.setLocalStateField('user', {
        ...currentUser,
        cursor: { line: e.position.lineNumber, column: e.position.column },
        activeFileId: fileId,
        lastActive: Date.now()
      });
    });

    return () => {
      contentDisposable.dispose();
      cursorDisposable.dispose();
      yText.unobserve(handleYTextChange);
      provider.awareness.off('change', handleAwarenessChange);
      if (editor.getModel()) {
        decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
      }
    };
  }, [editor, doc, fileId, provider]);
}
```

### 5.5 Step 4.4: Dynamic Visual Viewport & Keyboard Height Handling
```typescript
// src/hooks/useResponsiveLayout.ts
import { useState, useEffect } from 'react';

export interface ViewportState {
  width: number;
  height: number;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  keyboardOpen: boolean;
  keyboardHeight: number;
}

export function useResponsiveLayout(): ViewportState {
  const [viewport, setViewport] = useState<ViewportState>({
    width: typeof window !== 'undefined' ? window.innerWidth : 1024,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
    isMobile: false,
    isTablet: false,
    isDesktop: true,
    keyboardOpen: false,
    keyboardHeight: 0,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleResize = () => {
      const vv = window.visualViewport;
      const width = vv ? vv.width : window.innerWidth;
      const height = vv ? vv.height : window.innerHeight;
      const windowHeight = window.innerHeight;

      const keyboardHeight = Math.max(0, windowHeight - height);
      const keyboardOpen = keyboardHeight > 150;

      // Update CSS custom properties for 100vh, soft-keyboard, and accessory bar heights
      document.documentElement.style.setProperty('--vh', `${height * 0.01}px`);
      document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
      document.documentElement.style.setProperty(
        '--keyboard-bar-height',
        keyboardOpen ? '40px' : '0px'
      );
      document.documentElement.style.setProperty('--statusbar-height', '24px');

      setViewport({
        width,
        height,
        isMobile: width < 768,
        isTablet: width >= 768 && width < 1024,
        isDesktop: width >= 1024,
        keyboardOpen,
        keyboardHeight,
      });
    };

    handleResize();

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
      window.visualViewport.addEventListener('scroll', handleResize);
    } else {
      window.addEventListener('resize', handleResize);
    }

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize);
        window.visualViewport.removeEventListener('scroll', handleResize);
      } else {
        window.removeEventListener('resize', handleResize);
      }
    };
  }, []);

  return viewport;
}
```

### 5.6 Step 4.1: Virtual File System & Tab Reconciliation Logic
```typescript
// src/hooks/useVFS.ts
import { useEffect, useState, useCallback } from 'react';
import { getDB } from '@/db/schema';
import type { VFSNode, WorkspaceMetadata } from '@/types/workspace';

export function useVFS(workspaceId: string) {
  const [workspace, setWorkspace] = useState<WorkspaceMetadata | null>(null);
  const [nodes, setNodes] = useState<VFSNode[]>([]);
  const [loading, setLoading] = useState(true);

  const reconcileWorkspaceTabs = useCallback(
    async (ws: WorkspaceMetadata, currentNodes: VFSNode[]): Promise<WorkspaceMetadata> => {
      const activeNodeIds = new Set(
        currentNodes.filter((node) => !node.deletedAt).map((node) => node.id)
      );

      const reconciledOpenFileIds = ws.openFileIds.filter((id) => activeNodeIds.has(id));
      const reconciledActiveFileId =
        ws.activeFileId && activeNodeIds.has(ws.activeFileId)
          ? ws.activeFileId
          : reconciledOpenFileIds[0] ?? null;

      const hasChanged =
        reconciledOpenFileIds.length !== ws.openFileIds.length ||
        reconciledActiveFileId !== ws.activeFileId;

      if (hasChanged) {
        const updated: WorkspaceMetadata = {
          ...ws,
          openFileIds: reconciledOpenFileIds,
          activeFileId: reconciledActiveFileId,
          updatedAt: Date.now()
        };
        const db = getDB();
        await db.workspaces.put(updated);
        return updated;
      }

      return ws;
    },
    []
  );

  useEffect(() => {
    let mounted = true;

    const loadWorkspace = async () => {
      try {
        const db = getDB();
        const ws = await db.workspaces.get(workspaceId);
        const workspaceNodes = await db.nodes
          .where('workspaceId')
          .equals(workspaceId)
          .toArray();
        const nonDeletedNodes = workspaceNodes.filter((node) => !node.deletedAt);

        if (!mounted) return;

        if (ws) {
          const reconciled = await reconcileWorkspaceTabs(ws, nonDeletedNodes);
          if (mounted) {
            setWorkspace(reconciled);
            setNodes(nonDeletedNodes);
          }
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    loadWorkspace();

    return () => {
      mounted = false;
    };
  }, [workspaceId, reconcileWorkspaceTabs]);

  return {
    workspace,
    nodes,
    loading
  };
}
```

---

## 6. Layout Grid & CSS Token Specification

```css
/* src/app/globals.css */
@import "tailwindcss";

:root {
  /* VS Code Core Dark Tokens */
  --vscode-bg: #1e1e1e;
  --vscode-sidebar-bg: #252526;
  --vscode-activitybar-bg: #333333;
  --vscode-statusbar-bg: #007acc;
  --vscode-statusbar-offline-bg: #6c757d;
  --vscode-panel-bg: #1e1e1e;
  --vscode-editor-bg: #1e1e1e;
  --vscode-tabs-bg: #2d2d2d;
  --vscode-tab-active-bg: #1e1e1e;
  --vscode-tab-inactive-bg: #2d2d2d;
  --vscode-border: #3c3c3c;
  --vscode-foreground: #cccccc;
  --vscode-active-fg: #ffffff;
  --vscode-accent: #007acc;
  --vscode-input-bg: #3c3c3c;
  --vscode-list-hover: #2a2d2e;
  --vscode-list-active: #094771;

  /* Viewport Height dynamic tokens */
  --vh: 1vh;
  --keyboard-height: 0px;
  --keyboard-bar-height: 0px;
  --statusbar-height: 24px;
}

body {
  background-color: var(--vscode-bg);
  color: var(--vscode-foreground);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  overflow: hidden;
  height: 100vh;
  height: calc(var(--vh, 1vh) * 100);
  margin: 0;
  padding: 0;
}

/* Custom Scrollbars matching VS Code */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-corner {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: rgba(121, 121, 121, 0.4);
}

::-webkit-scrollbar-thumb:hover {
  background: rgba(100, 100, 100, 0.7);
}

/* Restrict unselectable text strictly to outer IDE chrome */
.vscode-chrome {
  user-select: none;
  -webkit-user-select: none;
}

/* Ensure code selection in Monaco remains functional on touch and desktop */
.monaco-editor-container {
  height: calc(var(--vh, 1vh) * 100 - var(--statusbar-height) - var(--keyboard-bar-height));
  user-select: text !important;
  -webkit-user-select: text !important;
}

/* Touch-action safeguard for iOS Safari splitter draggers */
.touch-splitter {
  touch-action: none !important;
}

/* Mobile Activity Bar safe-area containment */
.activity-bar-mobile {
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

/* Mobile Quick Access Bar */
.mobile-keyboard-bar {
  height: 40px;
  background-color: #252526;
  border-top: 1px solid var(--vscode-border);
  display: flex;
  align-items: center;
  overflow-x: auto;
  white-space: nowrap;
  -webkit-overflow-scrolling: touch;
}

.mobile-keyboard-bar button {
  min-width: 36px;
  height: 32px;
  margin: 0 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: monospace;
  font-size: 14px;
  border-radius: 4px;
  background: #333333;
  color: #ffffff;
}

.mobile-keyboard-bar button:active {
  background: #007acc;
}

/* Remote Cursor Styling */
.yRemoteSelection {
  background-color: rgba(250, 180, 0, 0.25);
  position: absolute;
}

.yRemoteSelectionHead {
  position: absolute;
  border-left: 2px solid orange;
  border-top: 2px solid orange;
  height: 100%;
  box-sizing: border-box;
}

.yRemoteSelectionHead::after {
  content: ' ';
  border: 3px solid orange;
  border-radius: 4px;
  left: -4px;
  top: -5px;
  position: absolute;
}
```

---

## 7. Responsive Breakpoint Matrix & Touch Targets

| Element | Mobile (< 768px: 360px, 390px, 430px) | Tablet (768px - 1023px) | Desktop (>= 1024px) |
|---|---|---|---|
| **Activity Bar** | Bottom nav or hamburger drawer; 48px touch targets; safe-area padded | 48px left column | 48px left column |
| **Primary Sidebar** | Slide-out overlay drawer (w-80 max-w-[85vw]) | Collapsible panel (w-64) | Resizable panel (min-w-[200px], max-w-[500px]) |
| **Editor Area** | Full viewport width; horizontal scroll tab bar | Split editor support; tab bar | Full multi-tab layout with split panes |
| **Panel (Terminal)** | Full-screen bottom sheet modal | Collapsible bottom drawer (200px) | Resizable bottom panel with tabs |
| **File Tree Action** | Persistent 3-dot trigger button (44px target) | Tap or right-click context menu | Context menu + hover action icons |
| **Command Palette** | Top sheet modal (w-[calc(100vw-16px)] max-h-[70vh] overflow-y-auto mx-2) | Centered modal (w-[500px] max-h-[70vh]) | Centered modal (w-[600px]) with `Cmd+P` |
| **Input Bar** | Sticky above soft keyboard (`--keyboard-height`) | Hidden unless virtual keyboard active | Hidden (Hardware keyboard default) |
| **Status Bar** | Condensed (Branch, Peer count, Language only) | Full metrics strip | Full metrics strip with clickable status items |

---

## 8. Offline & LAN Conflict Resolution Verification Rules
1. **Network Partition (Split-Brain):** Peers on separate subnets can independently edit the same virtual file. Upon reconnecting to the same WebRTC mesh or signaling server, Yjs automatically merges all operational mutations via the Y-CRDT algorithm without data loss or merge conflicts.
2. **Local Persistence Guarantees:** All local edits commit synchronously into memory and debounce to IndexedDB every 250ms. A browser reload, app close, or network disconnection loses zero keystrokes.
3. **Identity Preservation:** Peer identities (client ID, username, and assigned cursor hue) persist in `localStorage` so a user retains their assigned color and tag across page reloads.