'use client';

import { useEffect, useState } from 'react';
import { getDB } from '@/db/schema';
import { useResponsiveLayout } from '@/hooks/useResponsiveLayout';
import type { WorkspaceMetadata, VirtualFile } from '@/types/workspace';

const DEFAULT_WORKSPACE_ID = 'default-workspace';
const DEFAULT_ROOM_ID = 'collab-workspace-lan';

export default function Home() {
  const [initialized, setInitialized] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceMetadata | null>(null);
  const { isMobile, width } = useResponsiveLayout();

  useEffect(() => {
    async function initWorkspace() {
      const db = getDB();
      let currentWs = await db.workspaces.get(DEFAULT_WORKSPACE_ID);

      if (!currentWs) {
        const initialFileId = 'initial-index-ts';
        const initialFile: VirtualFile = {
          id: initialFileId,
          workspaceId: DEFAULT_WORKSPACE_ID,
          parentId: null,
          name: 'index.ts',
          type: 'file',
          path: '/index.ts',
          extension: 'ts',
          language: 'typescript',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          deletedAt: null,
          contentId: initialFileId,
          size: 112
        };

        currentWs = {
          id: DEFAULT_WORKSPACE_ID,
          name: 'Main Workspace',
          roomId: DEFAULT_ROOM_ID,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          activeFileId: initialFileId,
          openFileIds: [initialFileId]
        };

        await db.nodes.put(initialFile);
        await db.workspaces.put(currentWs);
      }

      setWorkspace(currentWs);
      setInitialized(true);
    }

    initWorkspace();
  }, []);

  if (!initialized || !workspace) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#1e1e1e] text-sm text-[#858585]">
        Initializing workspace...
      </div>
    );
  }

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-[#1e1e1e]">
      <header className="flex h-9 items-center justify-between border-b border-[#3c3c3c] bg-[#333333] px-3 text-xs text-[#cccccc]">
        <div className="flex items-center space-x-2">
          <span className="font-semibold text-white">Visual Studio Code</span>
          <span className="text-[#858585]">- {workspace.name}</span>
        </div>
        <div className="flex items-center space-x-3 text-[11px]">
          <span>Room: {workspace.roomId}</span>
          <span className="rounded bg-[#0e639c] px-1.5 py-0.5 text-white">LAN Mesh Active</span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {!isMobile && (
          <aside className="w-12 border-r border-[#3c3c3c] bg-[#333333] flex flex-col items-center py-2 space-y-4 text-xs text-[#858585]">
            <button className="text-white hover:text-white" title="Explorer">
              EXP
            </button>
            <button title="Search">SRC</button>
            <button title="Collaboration">COL</button>
          </aside>
        )}

        <section className="flex-1 flex flex-col overflow-hidden">
          <div className="flex h-9 items-center border-b border-[#252526] bg-[#252526] px-2 text-xs">
            <div className="flex items-center space-x-2 border-t border-[#007acc] bg-[#1e1e1e] px-3 py-1.5 text-white">
              <span>index.ts</span>
            </div>
          </div>

          <div className="monaco-editor-container flex-1 bg-[#1e1e1e] p-4 font-mono text-sm text-[#d4d4d4]">
            <p className="text-[#6a9955]">// Real-Time LAN Collaborative Monaco Workspace</p>
            <p className="mt-2 text-[#9cdcfe]">const <span className="text-[#4fc1ff]">session</span> = &#123;</p>
            <p className="ml-4 text-[#9cdcfe]">status: <span className="text-[#ce9178]">&apos;Ready&apos;</span>,</p>
            <p className="ml-4 text-[#9cdcfe]">viewportWidth: <span className="text-[#b5cea8]">{width}</span>,</p>
            <p className="ml-4 text-[#9cdcfe]">room: <span className="text-[#ce9178]">&apos;{workspace.roomId}&apos;</span></p>
            <p className="text-[#9cdcfe]">&#125;;</p>
          </div>
        </section>
      </div>

      <footer className="flex h-6 items-center justify-between bg-[#007acc] px-3 text-[11px] text-white">
        <div className="flex items-center space-x-3">
          <span>LAN Mode</span>
          <span>Peers: 1</span>
        </div>
        <div className="flex items-center space-x-3">
          <span>Ln 1, Col 1</span>
          <span>UTF-8</span>
          <span>TypeScript</span>
        </div>
      </footer>
    </main>
  );
}
