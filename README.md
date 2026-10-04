# Real-Time LAN Code Collaboration Editor

A VS Code–style collaborative code editor that runs entirely in the browser. There is no
hosted backend: files live in IndexedDB, peers find each other over WebRTC, and two devices
on the same local network converge through a Yjs CRDT — with or without an internet
connection.

## Stack

| Concern | Choice |
|---|---|
| App shell | Next.js 16 (App Router), React 19, Tailwind CSS v4 |
| Editor | Monaco, loaded client-side and served from the app's own origin |
| Realtime | Yjs CRDT + `y-webrtc` (LAN mesh) + `y-indexeddb` (local persistence) |
| Storage | Dexie (`LANCodeCollab-meta`) for structure, `y-indexeddb` for document state |
| Verification | Puppeteer Core driving headless Google Chrome |

## Getting started

```bash
pnpm install
pnpm run dev          # http://localhost:3000, bound to every interface
```

`dev` and `build` bundle the Monaco language-service workers first; see
[Workers](#monaco-workers) below.

### Reaching the dev server from another host

The dev server binds `0.0.0.0`, so `http://<your-lan-ip>:3000` and alternate
loopback addresses such as `http://127.0.2.2:3000` both serve the app. That
needs two things working together:

- `next dev -H 0.0.0.0`, so the port is not confined to `127.0.0.1`.
- `allowedDevOrigins` in `next.config.ts`, because Next.js answers `/_next/*`
  requests — including the HMR WebSocket upgrade — only to `localhost` and
  `*.localhost` unless a host is listed. A refused upgrade does not merely cost
  you hot reload: the Turbopack dev client never finishes booting, so the page
  sits on its server-rendered shell with no hydration and no workspace.

Loopback aliases (`127.*`), the RFC 1918 private ranges and `*.local` are
allowlisted. The rule is development-only — it is gated behind `opts.dev` — so
`next build` and `next start` are unaffected. Note that each host is a separate
browser partition: the workspace is stored per origin, so opening the app on a
second address seeds its own starter tree.

### Pairing two devices

1. Run the app on both devices.
2. Open **Collaboration** in the activity bar.
3. Set the same **Room ID** on both (the default is `collab-workspace-lan`).
4. Start a signaling server on one machine and enter its address in **Signaling servers**:

   ```bash
   pnpm exec y-webrtc-signaling --port 4444
   # then use ws://<that-machine-ip>:4444 on both devices
   ```

With no signaling server the editor still syncs between tabs of the same browser through
`BroadcastChannel`, and every keystroke is persisted locally regardless.

## Scripts

| Command | Purpose |
|---|---|
| `pnpm run dev` | Build workers, then start the dev server on all interfaces |
| `pnpm run build` | Build workers, then a production build |
| `pnpm run start` | Serve the production build |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm run build:workers` | Rebuild only the Monaco worker bundles |
| `pnpm run verify` | Run one or more verification phases in headless Chrome |
| `pnpm run verify:all` | Run every verification phase |

## Architecture

```
src/
├── app/            Root shell (layout, page) and the global design tokens
├── components/
│   ├── primitives/ ActionButton, TextInput, DropdownMenu, Tooltip, ResizableSplitter, ModalOverlay
│   ├── layout/     VSCodeShell, ActivityBar, PrimarySidebar, EditorArea, BottomPanel, StatusBar,
│   │               MobileKeyboardBar
│   ├── molecules/  FileTreeNode, EditorTabs, BreadcrumbBar, PeerAvatarGroup, CommandPaletteModal
│   └── domain/     MonacoDynamic/MonacoWrapper, FileExplorerView, GlobalSearchView,
│                   CollaborationView, LanDebugConsole, SettingsView
├── db/             Dexie schema and storage guards
├── hooks/          useVFS, useYjsCollaboration, useMonacoBinding, useResponsiveLayout,
│                   useKeyboardShortcuts
├── services/       signalingConfig, yjsProvider (pure session factory), languageDetector
├── types/          Workspace, collaboration and editor domain models
└── utils/          pathUtils, colorGenerator, platform
```

Three boundaries are worth calling out:

- **`services/yjsProvider.ts` imports no React.** It owns the Yjs document, the WebRTC
  provider and IndexedDB persistence; `useYjsCollaboration` owns the lifecycle.
- **Layout height never uses `100vh`.** `useResponsiveLayout` publishes `--vh`,
  `--keyboard-height` and `--keyboard-bar-height` from `window.visualViewport`, because
  `100vh` is wrong on iOS and Android the moment a software keyboard opens.
- **Structure and content are stored separately.** Dexie owns the tree (nodes, workspace
  metadata); Yjs owns the document. `contents.plainText` is kept as a search snapshot so
  full-text search works with the network switched off.

## Offline and conflict resolution

- **Persistence** — every edit commits to the CRDT in memory and is flushed to IndexedDB.
  A reload, crash or network loss loses nothing.
- **Conflicts** — Yjs merges concurrent edits from any number of peers. Peers that edited
  while partitioned converge on reconnect without a merge prompt.
- **Identity** — the peer name and cursor colour persist in `localStorage`, so a reload
  keeps the same colour and label.
- **Signaling** — only used to bootstrap peer discovery. Document traffic travels directly
  over WebRTC data channels.

## Monaco workers

`pnpm run build:workers` bundles the Monaco language services into `public/monaco/`. The
app needs its own worker bundles because `new Worker(new URL('./x.js', import.meta.url))` is
copied verbatim as a static asset by the bundler, which leaves the bare `monaco-editor`
import unresolvable in the browser — and serving them locally is also what keeps the
editor working on an air-gapped network.

## Verification

Every phase is verified in headless Google Chrome through real input events, real
IndexedDB and a real two-tab WebRTC mesh. The browser always runs with a throwaway profile
in the OS temp directory, so no installed browser (or its profile) is ever opened, locked
or closed.

```bash
pnpm run verify -- --phases=1,3     # selected phases
pnpm run verify -- --headed          # watch it run
VERIFY_URL=http://127.0.0.1:3210 pnpm run verify:all
```

| Phase | Coverage |
|---|---|
| 1 | Types, Dexie schema, path/language/colour/platform utilities (103 checks) |
| 2 | Design tokens and the six UI primitives (78 checks) |
| 3 | Molecules and feature components (84 checks) |
| 4 | VFS, CRDT sync, Monaco binding, viewport engine — including two tabs in one room (59 checks) |
| 5 | The assembled shell at 360 / 390 / 430 / 768 / 1440 px (100 checks) |

Phases 1–4 mount their React harness on a dedicated blank origin so the harness and the
running application never share a DOM; phase 5 drives the real application.

Screenshots from the responsive checks are written to `.verify/`.

## Environment

Copy `.env.example` to `.env.local` to override the defaults:

```
NEXT_PUBLIC_DEFAULT_SIGNALING_SERVER=ws://localhost:4444
```