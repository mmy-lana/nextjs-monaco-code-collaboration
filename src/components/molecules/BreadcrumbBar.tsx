'use client';

import { memo, useMemo } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import { getBreadcrumbSegments } from '@/utils/pathUtils';

export interface BreadcrumbBarProps {
  /** Absolute virtual path of the active file. */
  path: string;
  /** Invoked with the path prefix a segment points at. */
  onNavigate?: (path: string) => void;
  /** Invoked when the user picks a sibling file from the same folder. */
  onSelectSibling?: (fileName: string) => void;
  /** File names available in the active directory, used for the tail menu. */
  siblings?: readonly string[];
}

/**
 * File hierarchy trail shown above the editor.
 *
 * Segments are plain buttons rather than links so the trail keeps working
 * offline; every ancestor resolves through the callback so navigation stays
 * host-local (peers follow their own cursor).
 */
function BreadcrumbBarComponent({
  path,
  onNavigate,
  onSelectSibling,
  siblings = [],
}: BreadcrumbBarProps) {
  const segments = useMemo(() => getBreadcrumbSegments(path), [path]);

  const pathForIndex = useMemo(
    () => segments.map((_, index) => `/${segments.slice(0, index + 1).join('/')}`),
    [segments],
  );

  return (
    <nav
      aria-label="File path"
      data-testid="breadcrumb-bar"
      className="flex h-[var(--breadcrumb-height)] shrink-0 items-center gap-0.5 overflow-x-auto bg-vscode-editor-bg px-2 text-[11px] text-vscode-description-fg scrollbar-thin"
    >
      {segments.length === 0 ? (
        <span data-testid="breadcrumb-empty">No file selected</span>
      ) : (
        segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          const isDirectory = !isLast;

          return (
            <span key={`${segment}-${index}`} className="flex shrink-0 items-center gap-0.5">
              {index > 0 ? (
                <ChevronRight size={12} aria-hidden="true" className="shrink-0 opacity-60" />
              ) : null}

              {isDirectory && onNavigate ? (
                <button
                  type="button"
                  data-testid={`breadcrumb-segment-${index}`}
                  onClick={() => onNavigate(pathForIndex[index])}
                  className="flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-vscode-list-hover hover:text-vscode-active-fg"
                >
                  <Folder size={12} aria-hidden="true" />
                  {segment}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid={`breadcrumb-segment-${index}`}
                  aria-current={isLast ? 'page' : undefined}
                  onClick={() => {
                    if (isLast && onSelectSibling) onSelectSibling(segment);
                    else onNavigate?.(pathForIndex[index]);
                  }}
                  className={`flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-vscode-list-hover hover:text-vscode-active-fg ${
                    isLast ? 'font-medium text-vscode-fg' : ''
                  }`}
                >
                  {segment}
                  {isLast && siblings.length > 0 ? (
                    <span aria-hidden="true" className="opacity-60">
                      ▾
                    </span>
                  ) : null}
                </button>
              )}
            </span>
          );
        })
      )}
    </nav>
  );
}

export const BreadcrumbBar = memo(BreadcrumbBarComponent);
BreadcrumbBar.displayName = 'BreadcrumbBar';