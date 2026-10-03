'use client';

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, FilePlus2, FolderPlus, Loader2, RefreshCw, Search } from 'lucide-react';
import { ActionButton } from '@/components/primitives/ActionButton';
import { FileTreeNode } from '@/components/molecules/FileTreeNode';
import {
  isVirtualDirectory,
  sortVFSNodes,
  VFS_ROOT_PATH,
  type VFSNode,
  type VirtualDirectory,
  type VirtualFile,
} from '@/types/workspace';

export interface FileExplorerViewProps {
  /** Every live node in the workspace, flat. */
  nodes: readonly VFSNode[];
  activeFileId: string | null;
  loading: boolean;
  /** Fatal load error; rendered instead of the tree when set. */
  error: string | null;
  /** Directory ids expanded by the user. */
  expandedIds: ReadonlySet<string>;
  /** Blocks mutating actions while a write is in flight. */
  busy: boolean;
  onToggleDirectory: (node: VirtualDirectory) => void;
  onOpenFile: (node: VirtualFile) => void;
  onRename: (node: VFSNode, nextName: string) => void;
  onDelete: (node: VFSNode) => void;
  onCreateFile: (parent: VirtualDirectory | null) => void;
  onCreateDirectory: (parent: VirtualDirectory | null) => void;
  onRetry: () => void;
  onFilterChange?: (query: string) => void;
}

export const EXPLORER_TITLE = 'Explorer';

/**
 * Sidebar file tree.
 *
 * Tree shape is derived on every render from the flat node list: nodes are
 * grouped by `parentId` (with `null` meaning the workspace root) and sorted
 * directories-first, which keeps the component a pure function of its props.
 */
export function FileExplorerView({
  nodes,
  activeFileId,
  loading,
  error,
  expandedIds,
  busy,
  onToggleDirectory,
  onOpenFile,
  onRename,
  onDelete,
  onCreateFile,
  onCreateDirectory,
  onRetry,
  onFilterChange,
}: FileExplorerViewProps) {
  const [filter, setFilter] = useState('');

  const { childrenByParent, roots, totalFiles } = useMemo(() => {
    const map = new Map<string | null, VFSNode[]>();

    for (const node of nodes) {
      const bucket = map.get(node.parentId);
      if (bucket) bucket.push(node);
      else map.set(node.parentId, [node]);
    }

    for (const [key, bucket] of map.entries()) {
      map.set(key, sortVFSNodes(bucket));
    }

    const files = nodes.filter((node) => node.type === 'file').length;

    return {
      childrenByParent: map,
      roots: map.get(null) ?? sortVFSNodes(nodes.filter((node) => node.parentId === null)),
      totalFiles: files,
    };
  }, [nodes]);

  const filteredRoots = useMemo(() => {
    const trimmed = filter.trim().toLowerCase();
    if (!trimmed) return roots;
    return roots.filter((node) => node.name.toLowerCase().includes(trimmed));
  }, [filter, roots]);

  const handleFilterChange = useCallback(
    (value: string) => {
      setFilter(value);
      onFilterChange?.(value);
    },
    [onFilterChange],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-explorer">
      <header className="flex shrink-0 items-center justify-between px-3 py-2">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-vscode-description-fg">
          {EXPLORER_TITLE}
        </h2>
        <span className="text-[10px] text-vscode-description-fg" data-testid="explorer-file-count">
          {totalFiles} {totalFiles === 1 ? 'file' : 'files'}
        </span>
      </header>

      <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
        <ActionButton
          testId="explorer-new-file"
          size="sm"
          variant="ghost"
          aria-label="New file"
          disabled={busy || loading}
          icon={<FilePlus2 size={14} aria-hidden="true" />}
          onClick={() => onCreateFile(null)}
          className="flex-1 justify-start"
        >
          New File
        </ActionButton>
        <ActionButton
          testId="explorer-new-folder"
          size="sm"
          variant="ghost"
          aria-label="New folder"
          disabled={busy || loading}
          icon={<FolderPlus size={14} aria-hidden="true" />}
          onClick={() => onCreateDirectory(null)}
          className="flex-1 justify-start"
        >
          New Folder
        </ActionButton>
      </div>

      {nodes.length > 8 ? (
        <div className="shrink-0 px-2 pb-2">
          <label className="sr-only" htmlFor="explorer-filter">
            Filter files
          </label>
          <div className="flex items-center gap-1.5 rounded-sm border border-vscode-input-border bg-vscode-input-bg px-2 py-1 focus-within:border-vscode-accent">
            <Search size={12} aria-hidden="true" className="text-vscode-description-fg" />
            <input
              id="explorer-filter"
              data-testid="explorer-filter"
              value={filter}
              onChange={(event) => handleFilterChange(event.target.value)}
              placeholder="Filter files"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-vscode-input-placeholder"
            />
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pb-3" data-testid="explorer-scroll">
        {loading ? (
          <p
            className="flex items-center gap-2 px-3 py-4 text-xs text-vscode-description-fg"
            data-testid="explorer-loading"
          >
            <Loader2 size={14} aria-hidden="true" className="animate-spin" />
            Loading workspace…
          </p>
        ) : error ? (
          <div className="m-2 rounded-sm border border-vscode-error-fg/60 bg-vscode-error-fg/10 p-3" role="alert">
            <p className="flex items-center gap-2 text-xs font-medium text-vscode-error-fg">
              <AlertTriangle size={14} aria-hidden="true" />
              Workspace could not be loaded
            </p>
            <p className="mt-1 break-words text-[11px] text-vscode-fg">{error}</p>
            <ActionButton
              testId="explorer-retry"
              size="sm"
              variant="secondary"
              className="mt-2"
              icon={<RefreshCw size={12} aria-hidden="true" />}
              onClick={onRetry}
            >
              Retry
            </ActionButton>
          </div>
        ) : roots.length === 0 ? (
          <div className="px-3 py-4 text-center" data-testid="explorer-empty">
            <p className="text-xs text-vscode-fg">This workspace is empty</p>
            <p className="mt-1 text-[11px] text-vscode-description-fg">
              Create a file to start collaborating. Everything is stored locally and synced
              peer-to-peer.
            </p>
          </div>
        ) : filteredRoots.length === 0 ? (
          <p className="px-3 py-4 text-xs text-vscode-description-fg" data-testid="explorer-filter-empty">
            No root entries match “{filter}”.
          </p>
        ) : (
          <div role="tree" aria-label="Workspace files">
            {filteredRoots.map((node) => (
              <FileTreeNode
                key={node.id}
                node={node}
                depth={0}
                expandedIds={expandedIds}
                activeFileId={activeFileId}
                childrenByParent={childrenByParent}
                onToggleDirectory={onToggleDirectory}
                onOpenFile={onOpenFile}
                onRename={onRename}
                onDelete={onDelete}
                onCreateFile={(parent) => onCreateFile(parent)}
                onCreateDirectory={(parent) => onCreateDirectory(parent)}
                busy={busy}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-vscode-border px-3 py-1.5 text-[10px] text-vscode-description-fg">
        Root: <code className="font-mono">{VFS_ROOT_PATH}</code> · stored in IndexedDB
      </footer>
    </div>
  );
}