'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { EditorTab } from '@/types/editor';

export interface EditorTabsProps {
  tabs: readonly EditorTab[];
  activeFileId: string | null;
  onSelect: (fileId: string) => void;
  onClose: (fileId: string) => void;
  /** Drag-and-drop reordering; omitted when the shell does not support it. */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onPinToggle?: (fileId: string, pinned: boolean) => void;
}

const LANGUAGE_ACCENTS: Record<string, string> = {
  typescript: 'text-[#4fc1ff]',
  javascript: 'text-[#f0db4f]',
  json: 'text-[#f0db4f]',
  python: 'text-[#6a9955]',
  rust: 'text-[#e5c07b]',
  go: 'text-[#4fc1ff]',
  markdown: 'text-[#9cdcfe]',
  css: 'text-[#6a9fb5]',
  html: 'text-[#e34c26]',
  yaml: 'text-[#c586c0]',
  shell: 'text-[#89d185]',
};

/**
 * Horizontal editor tab strip.
 *
 * The strip scrolls horizontally on narrow screens and exposes explicit
 * scroll affordances on desktop; tab actions (close) are always rendered rather
 * than revealed on hover so they remain reachable on touch.
 */
export function EditorTabs({
  tabs,
  activeFileId,
  onSelect,
  onClose,
  onReorder,
  onPinToggle,
}: EditorTabsProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const syncScrollState = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    setCanScrollLeft(strip.scrollLeft > 1);
    setCanScrollRight(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
  }, []);

  useEffect(() => {
    syncScrollState();
    const strip = stripRef.current;
    if (!strip) return undefined;

    const observer = new ResizeObserver(syncScrollState);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [syncScrollState, tabs.length]);

  const scrollBy = useCallback((delta: number) => {
    stripRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, tab: EditorTab, index: number) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect(tab.fileId);
        return;
      }
      if (event.key === 'Delete' || (event.key === 'w' && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        onClose(tab.fileId);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowRight') {
        event.preventDefault();
        const next = tabs[index + 1] ?? tabs[0];
        if (next) onSelect(next.fileId);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowLeft') {
        event.preventDefault();
        const previous = tabs[index - 1] ?? tabs[tabs.length - 1];
        if (previous) onSelect(previous.fileId);
      }
    },
    [onClose, onSelect, tabs],
  );

  const commitReorder = useCallback(() => {
    if (dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
      onReorder?.(dragIndex, dropIndex);
    }
    setDragIndex(null);
    setDropIndex(null);
  }, [dragIndex, dropIndex, onReorder]);

  return (
    <div className="flex h-[var(--tab-height)] shrink-0 items-stretch border-b border-vscode-border bg-vscode-tabs-bg">
      {canScrollLeft ? (
        <button
          type="button"
          aria-label="Scroll tabs left"
          onClick={() => scrollBy(-160)}
          className="flex w-6 shrink-0 items-center justify-center text-vscode-description-fg hover:bg-vscode-button-hover"
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
      ) : null}

      <div
        ref={stripRef}
        role="tablist"
        aria-label="Open editors"
        data-testid="editor-tabstrip"
        onScroll={syncScrollState}
        className="scrollbar-thin flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        {tabs.length === 0 ? (
          <p className="flex items-center px-3 text-[11px] text-vscode-description-fg" data-testid="editor-tabs-empty">
            No open editors — select a file from the explorer.
          </p>
        ) : (
          tabs.map((tab, index) => {
            const isActive = tab.fileId === activeFileId;
            const accent = LANGUAGE_ACCENTS[tab.language] ?? 'text-vscode-description-fg';

            return (
              <div
                key={tab.fileId}
                role="tab"
                aria-selected={isActive}
                aria-label={`${tab.fileName}${tab.isDirty ? ', unsaved changes' : ''}`}
                tabIndex={isActive ? 0 : -1}
                title={tab.filePath}
                data-testid={`editor-tab-${tab.fileId}`}
                data-active={isActive}
                draggable={Boolean(onReorder)}
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => {
                  if (!onReorder) return;
                  event.preventDefault();
                  setDropIndex(index);
                }}
                onDragEnd={commitReorder}
                onKeyDown={(event) => handleKeyDown(event, tab, index)}
                onClick={() => onSelect(tab.fileId)}
                className={`group flex min-w-[120px] max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-vscode-border px-2 text-xs transition-colors ${
                  isActive
                    ? 'border-t-2 border-t-vscode-accent bg-vscode-tab-active-bg text-vscode-active-fg'
                    : 'border-t-2 border-t-transparent bg-vscode-tabs-bg text-vscode-description-fg hover:bg-vscode-list-hover'
                }`}
              >
                {tab.isPinned && onPinToggle ? (
                  <button
                    type="button"
                    aria-label={`Unpin ${tab.fileName}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPinToggle(tab.fileId, false);
                    }}
                    className="shrink-0 text-[10px] hover:text-vscode-active-fg"
                  >
                    📌
                  </button>
                ) : null}

                <span aria-hidden="true" className={`shrink-0 ${accent}`}>
                  ●
                </span>
                <span className="min-w-0 flex-1 truncate">{tab.fileName}</span>

                {tab.isDirty ? (
                  <span
                    title="Unsaved changes"
                    aria-label="Unsaved changes"
                    data-testid={`editor-tab-dirty-${tab.fileId}`}
                    className="h-2 w-2 shrink-0 rounded-full bg-vscode-description-fg"
                  />
                ) : null}

                <button
                  type="button"
                  aria-label={`Close ${tab.fileName}`}
                  data-testid={`editor-tab-close-${tab.fileId}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.fileId);
                  }}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-vscode-description-fg hover:bg-vscode-button-hover hover:text-vscode-active-fg md:h-5 md:w-5"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            );
          })
        )}
      </div>

      {canScrollRight ? (
        <button
          type="button"
          aria-label="Scroll tabs right"
          onClick={() => scrollBy(160)}
          className="flex w-6 shrink-0 items-center justify-center text-vscode-description-fg hover:bg-vscode-button-hover"
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}