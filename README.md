# Real-Time Code Collaboration Editor

A browser-based, zero-server collaborative code editor modeled after the Visual Studio Code Web interface. It enables real-time, peer-to-peer pair programming over a Local Area Network (LAN) or across browser tabs without sending code through a centralized cloud database.

- Repository: https://github.com/mmy-lana/nextjs-monaco-code-collaboration
- Live Demo: https://nextjs-monaco-code-collaboration.vercel.app

---

## What is this project for?

Traditional collaborative editors rely on hosted backends, proprietary document servers, or cloud databases that store source code on third-party infrastructure. 

This project solves that dependency by providing a self-contained, offline-first development environment:
- **Zero Central Database:** All files, directory trees, and editor settings live inside the browser's IndexedDB engine.
- **P2P Conflict-Free Sync:** Edits merge automatically across collaborators using Yjs Conflict-free Replicated Data Types (CRDTs). Concurrent edits converge deterministically without merge conflicts or data loss.
- **Air-Gapped & LAN-Ready:** Designed to run in restricted, privacy-sensitive, or air-gapped network environments where an internet connection is unavailable.
- **Authentic VS Code Web Layout:** Features the Activity Bar, collapsible Primary Sidebar, drag-to-resize splitters, multi-tab editor groups, breadcrumbs, command palette, and an expandable bottom diagnostics panel.

---

## Mini Q&A

### How does real-time collaboration work without a central server?
The editor pairs peers directly over WebRTC data channels. Peers exchange initial connection metadata (SDP offers and ICE candidates) through a lightweight local signaling server (`ws://<host>:4444`). Once connected, all operational document deltas, cursor positions, and selection ranges pass directly peer-to-peer. When running multiple tabs on the same machine without a signaling server, the application automatically falls back to browser-level `BroadcastChannel` communication.

### What happens if I lose my network connection or go offline?
You retain full editing capabilities. All file tree structures and plain-text snapshots commit locally to IndexedDB via Dexie (`LANCodeCollab-meta`), while document CRDT updates commit to `y-indexeddb` (`LANCodeCollab-crdt-<roomId>`). When reconnected to peers, Yjs automatically merges all offline edits into the shared document without prompting for manual resolution.

### Can collaborators edit different files at the same time?
Yes. The root Yjs document maintains an isolated `Y.Text` instance per virtual file (`files.<fileId>`). Edits to distinct files never contend on the same CRDT node. Remote updates are mirrored to local IndexedDB snapshots in the background, ensuring background peer edits persist even if you switch tabs.

### Why does the status bar show "Local Mesh" instead of "WebRTC Mesh"?
"Local Mesh" indicates that the editor is actively synchronizing across tabs within the same browser session using the browser's `BroadcastChannel` API. This occurs when no external WebRTC signaling server is running. Once a signaling server is detected and peers connect over WebRTC, the status chip automatically updates to "WebRTC Mesh".

### How does the live Vercel deployment handle collaboration?
Because Vercel hosts serverless frontend assets and does not run persistent WebSocket servers, the live deployment operates in "Local Mesh" mode by default. You can open multiple tabs on the same browser to test real-time collaboration. For multi-device collaboration on the live site, enter a public or LAN WebRTC signaling address (e.g., `wss://your-signaling-host`) in the Collaboration panel.

### Does this editor work on mobile devices?
Yes. The interface is optimized for viewports from 360px to 430px. The sidebar transforms into a slide-over modal drawer, the activity bar shifts to a safe-area-padded bottom navigation bar, and an on-screen accessory bar engages above the virtual keyboard to provide brackets, semicolons, tabs, indentation, and undo/redo controls.

### Why are Monaco web workers bundled locally instead of via CDN?
To maintain air-gapped LAN support. External CDN scripts fail in offline environments. All Monaco language services (TypeScript, JSON, CSS, HTML, and base editor workers) are pre-bundled using `esbuild` into `public/monaco/` and served directly from the application origin.

---

## How to Navigate the Interface

```
+---+------------------+-----------------------------------------------+
|   | PRIMARY SIDEBAR  | EDITOR TABS: [ welcome.ts * ] [ README.md ]  |
| A |                  +-----------------------------------------------+
| C | [Explorer]       | BREADCRUMBS: src > welcome.ts                 |
| T |                  +-----------------------------------------------+
| I | - src/           |                                               |
| V |   - welcome.ts   |               MONACO EDITOR                   |
| I | - README.md      |          (Syntax Highlight + Cursors)         |
| T |                  |                                               |
| Y |                  +-----------------------------------------------+
|   |                  | BOTTOM PANEL: [Terminal] [Output] [LAN Debug] |
+---+------------------+-----------------------------------------------+
| STATUS BAR: Workspace · Room · Transport · Ln 1, Col 1 · UTF-8 · TS  |
+----------------------------------------------------------------------+
```

### 1. Activity Bar (Leftmost Strip)
- **Explorer (`EX`):** Shows the virtual directory tree, file actions, and creation buttons.
- **Search (`SR`):** Fast, full-text case-insensitive search across all IndexedDB file contents.
- **Collaboration (`CO`):** Displays room configuration, active peer roster, signaling endpoint settings, and workspace snapshot import/export.
- **Settings (`ST`):** Configures editor font size, tab sizing, word wrap, line numbers, cursor styles, color themes (`vs-dark`, `vs-light`, `hc-black`), and peer display name.

### 2. Primary Sidebar
- Expandable and collapsible via `Cmd+B` / `Ctrl+B` or the toggle icon.
- Resizable via drag-and-drop pointer splitter.
- File tree rows provide a three-dot action trigger (`...`) for Rename, Copy Path, and Delete without relying on desktop hover states.

### 3. Editor Area
- **Tab Strip:** Reorderable, scrollable list of open files with unsaved indicators and close buttons.
- **Breadcrumb Bar:** Displays virtual path segments with quick ancestor navigation.
- **Editor Canvas:** Full Monaco code surface supporting multi-cursor editing, syntax highlighting, and color-coded remote peer caret tags.

### 4. Bottom Panel
- Toggleable via `` Cmd+` `` / `` Ctrl+` `` or the footer trigger.
- **Terminal:** Interactive workspace command line.
- **Output:** Live execution and workspace activity log.
- **Problems:** File diagnostics and linting markers.
- **LAN Debug:** Live transport telemetry, packet counts, bytes sent/received, and connection logs.

### 5. Status Bar (Footer)
- Shows workspace and room identifiers.
- Diagnostics indicator (`Errors / Warnings`).
- Real-time transport badge: `Local Mesh` (BroadcastChannel) or `WebRTC Mesh` (P2P connected).
- Live cursor position (`Ln X, Col Y`), selection character count, encoding, and language mode.

### 6. Command Palette & Quick Open
- Press `Cmd+P` / `Ctrl+P` to fuzzy-search and jump to any workspace file.
- Press `Cmd+Shift+P` / `Ctrl+Shift+P` (or press `Tab` within Quick Open) to access workbench and editor commands.

---

## How to Use

### Prerequisites
- Node.js (v18.18 or higher recommended)
- `pnpm` (strictly required)

### Local Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/mmy-lana/nextjs-monaco-code-collaboration.git
   cd nextjs-monaco-code-collaboration
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```

3. **Start the development environment:**
   ```bash
   pnpm run dev
   ```
   *Note: This command compiles the Monaco workers, binds the Next.js server to `0.0.0.0:3000`, and starts the integrated WebRTC signaling server concurrently on port `4444`.*

4. **Open in browser:**
   Navigate to `http://localhost:3000`.

---

### Collaboration Scenarios

#### Scenario A: Same-Device Multi-Tab Collaboration (No Setup Required)
1. Open `http://localhost:3000` in two separate tabs or windows.
2. Both tabs connect automatically using `BroadcastChannel` under the room `collab-workspace-lan`.
3. Type in one tab; watch the text and colored remote cursor update in real-time in the other.

#### Scenario B: Cross-Device Local Network (LAN) Pairing
1. Find the local IP address of the host machine running `pnpm run dev` (e.g., `192.168.1.15`).
2. On a second laptop, tablet, or phone on the same Wi-Fi network, open:
   ```
   http://192.168.1.15:3000
   ```
3. Open the **Collaboration** tab in the sidebar.
4. Verify that both devices use the same **Room ID** (default: `collab-workspace-lan`).
5. Ensure the signaling server input points to the host machine (e.g., `ws://192.168.1.15:4444`). The app auto-detects this from the serving hostname.
6. The status bar will switch to **WebRTC Mesh**, showing `1 peer`. Edits will now synchronize across both physical devices.

#### Scenario C: Offline Air-Gapped Mode
1. Disconnect your Wi-Fi or unplug your Ethernet cable.
2. The editor continues to work with no loss of functionality.
3. Every keystroke is saved to local IndexedDB storage.
4. Multiple local tabs continue to synchronize seamlessly via `BroadcastChannel`.

---

## Keyboard Shortcuts

| Shortcut (macOS) | Shortcut (Windows/Linux) | Action |
|---|---|---|
| `Cmd + P` | `Ctrl + P` | Quick Open (Search Files) |
| `Cmd + Shift + P` | `Ctrl + Shift + P` | Command Palette |
| `Cmd + B` | `Ctrl + B` | Toggle Primary Sidebar |
| `` Cmd + ` `` | `` Ctrl + ` `` | Toggle Bottom Panel |
| `Cmd + W` | `Ctrl + W` | Close Active Editor Tab |
| `Shift + Alt + F` | `Shift + Alt + F` | Format Document |
| `Escape` | `Escape` | Close Dialogs / Modals / Palette |

---

## Available Scripts

| Command | Description |
|---|---|
| `pnpm run dev` | Builds Monaco workers and boots Next.js + signaling server |
| `pnpm run signaling` | Runs the standalone WebRTC signaling server on port 4444 |
| `pnpm run build` | Builds Monaco workers and compiles the Next.js production build |
| `pnpm run start` | Runs the compiled production server |
| `pnpm run typecheck` | Validates TypeScript types across the codebase (`tsc --noEmit`) |
| `pnpm run build:workers`| Compiles standalone Monaco language service workers to `public/monaco/` |
| `pnpm run verify` | Runs automated headless Chrome verification test suites |
| `pnpm run verify:all` | Runs all 5 verification phases (400+ checks across desktop & mobile) |

---

## Technical Stack & Architecture

- **Framework:** Next.js 16 (App Router), React 19
- **Code Editor:** Monaco Editor (ESM Workers via local origin)
- **CRDT Sync Engine:** Yjs, `y-webrtc`, `y-indexeddb`
- **Metadata Database:** Dexie.js (IndexedDB wrapper)
- **Styling:** Tailwind CSS v4, custom VS Code CSS design tokens
- **Icons:** Lucide React
- **Test Harness:** Puppeteer Core driving headless Chrome instances
