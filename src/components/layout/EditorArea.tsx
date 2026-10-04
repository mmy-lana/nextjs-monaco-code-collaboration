'use client';

import { useCallback, useRef } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { EditorTabs } from '@/components/molecules/EditorTabs';
import { BreadcrumbBar } from '@/components/molecules/BreadcrumbBar';
import { ResizableSplitter } from '@/components/primitives/ResizableSplitter';
import type { EditorTab } from '@/types/editor';

export interface EditorAreaProps {
  tabs: readonly EditorTab[];
  activeFileId: string | null;
  /** Breadcrumb path of the active file. */
  activePath: string;
  /** Sibling names used by the breadcrumb tail affordance. */
  siblings: readonly string[];
  sidebarVisible: boolean;
  isMobile: boolean;
  onSelectTab: (fileId: string) => void;
  onCloseTab: (fileId: string) => void;
  onReorderTabs?: (fromIndex: number, toIndex: number) => void;
  onToggleSidebar: () => void;
  onNavigatePath: (path: string) => void;
  /** Monaco surface. */
  children: React.ReactNode;
}

/**
 * Tab strip + breadcrumb + editor surface.
 *
 * Owns nothing but layout: the active file, its tabs and the Monaco instance
 * all come from the shell, so the editor can be swapped (split view, mobile
 * drawer) without duplicating tab state.
 */
export function EditorArea({
  tabs,
  activeFileId,
  activePath,
  siblings,
  sidebarVisible,
  isMobile,
  onSelectTab,
  onCloseTab,
  onReorderTabs,
  onToggleSidebar,
  onNavigatePath,
  children,
}: EditorAreaProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleNavigate = useCallback(
    (path: string) => {
      onNavigatePath(path);
    },
    [onNavigatePath],
  );

  return (
    <section
      aria-label="Editor"
      data-testid="editor-area"
      className="flex min-w-0 flex-1 flex-col bg-vscode-editor-bg"
    >
      {!isMobile ? (
        <div className="flex h-[var(--tab-height)] shrink-0 items-center border-b border-vscode-border bg-vscode-tabs-bg pl-1">
          <button
            type="button"
            aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
            data-testid="toggle-sidebar"
            onClick={onToggleSidebar}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-vscode-description-fg hover:bg-vscode-button-hover hover:text-vscode-active-fg"
          >
            {sidebarVisible ? (
              <PanelLeftClose size={14} aria-hidden="true" />
            ) : (
              <PanelLeftOpen size={14} aria-hidden="true" />
            )}
          </button>
        </div>
      ) : (
        <div className="flex h-[var(--tab-height)] shrink-0 items-center border-b border-vscode-border bg-vscode-tabs-bg pl-1">
          <button
            type="button"
            aria-label="Open sidebar"
            data-testid="toggle-sidebar"
            onClick={onToggleSidebar}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-vscode-description-fg hover:bg-vscode-button-hover hover:text-vscode-active-fg"
          >
            <PanelLeftOpen size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      <EditorTabs
        tabs={tabs}
        activeFileId={activeFileId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onReorder={onReorderTabs}
      />

      <BreadcrumbBar
        path={activePath}
        siblings={siblings}
        onNavigate={handleNavigate}
        onSelectSibling={onSelectTab}
      />

      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" data-testid="editor-surface">
        {children}
      </div>
    </section>
  );
}

/** Splitter used between the sidebar and the editor on desktop widths. */
export function SidebarSplitter(props: {
  size: number;
  onResize: (size: number) => void;
}): React.ReactElement {
  return (
    <ResizableSplitter
      testId="sidebar-splitter"
      orientation="vertical"
      label="Resize sidebar"
      size={props.size}
      minSize={200}
      maxSize={500}
      onResize={props.onResize}
    />
  );
}

/**
 * Splitter between the editor and the bottom panel.
 *
 * `maxSize` is supplied by the shell rather than read from `window` here: a
 * render-time window read would differ between the server and the client's
 * first paint and break hydration.
 */
export function PanelSplitter(props: {
  size: number;
  maxSize: number;
  onResize: (size: number) => void;
}): React.ReactElement {
  return (
    <ResizableSplitter
      testId="panel-splitter"
      orientation="horizontal"
      label="Resize panel"
      size={props.size}
      minSize={120}
      maxSize={props.maxSize}
      invert
      onResize={props.onResize}
    />
  );
}