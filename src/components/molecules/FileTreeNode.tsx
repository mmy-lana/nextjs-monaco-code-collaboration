'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Copy,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { ActionButton } from '@/components/primitives/ActionButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/primitives/DropdownMenu';
import {
  isVirtualDirectory,
  isVirtualFile,
  type VFSNode,
  type VirtualDirectory,
  type VirtualFile,
} from '@/types/workspace';
import { validateNodeName } from '@/utils/pathUtils';

export interface FileTreeNodeProps {
  node: VFSNode;
  /** Nesting depth, used for indentation and aria-level. */
  depth: number;
  expandedIds: ReadonlySet<string>;
  activeFileId: string | null;
  /** Pre-built adjacency map: parent id → ordered children. */
  childrenByParent: ReadonlyMap<string | null, readonly VFSNode[]>;
  onToggleDirectory: (node: VirtualDirectory) => void;
  onOpenFile: (node: VirtualFile) => void;
  onRename: (node: VFSNode, nextName: string) => void;
  onDelete: (node: VFSNode) => void;
  onCreateFile: (parent: VirtualDirectory) => void;
  onCreateDirectory: (parent: VirtualDirectory) => void;
  /** Disabled while a create/rename operation is in flight. */
  busy?: boolean;
}

/** Language → glyph accent, mirroring VS Code's file icon colouring. */
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
 * One row of the file tree.
 *
 * Every mutation is exposed through an explicit "…" trigger rather than a CSS
 * `:hover` affordance, because hover does not exist on touch. Rows keep a 44px
 * minimum height on phones and collapse to VS Code density from `md` upwards.
 */
function FileTreeNodeComponent({
  node,
  depth,
  expandedIds,
  activeFileId,
  childrenByParent,
  onToggleDirectory,
  onOpenFile,
  onRename,
  onDelete,
  onCreateFile,
  onCreateDirectory,
  busy = false,
}: FileTreeNodeProps) {
  const isDirectory = isVirtualDirectory(node);
  const isFile = isVirtualFile(node);
  const isExpanded = isDirectory && expandedIds.has(node.id);
  const isActive = isFile && node.id === activeFileId;

  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isRenaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [isRenaming]);

  const children = useMemo(
    () => childrenByParent.get(node.id) ?? [],
    [childrenByParent, node.id],
  );

  const startRename = useCallback(() => {
    setDraftName(node.name);
    setRenameError(null);
    setIsRenaming(true);
  }, [node.name]);

  const cancelRename = useCallback(() => {
    setIsRenaming(false);
    setRenameError(null);
    setDraftName(node.name);
  }, [node.name]);

  const commitRename = useCallback(() => {
    const trimmed = draftName.trim();
    if (trimmed === node.name) {
      cancelRename();
      return;
    }
    const validation = validateNodeName(trimmed);
    if (!validation.valid) {
      setRenameError(validation.reason);
      return;
    }
    setRenameError(null);
    setIsRenaming(false);
    onRename(node, trimmed);
  }, [cancelRename, draftName, node, onRename]);

  const menuItems = useMemo<DropdownMenuItem[]>(() => {
    const items: DropdownMenuItem[] = [];

    if (isDirectory) {
      const directoryNode = node as VirtualDirectory;
      items.push(
        {
          id: 'new-file',
          label: 'New File…',
          icon: <FilePlus2 size={13} />,
          onSelect: () => onCreateFile(directoryNode),
        },
        {
          id: 'new-folder',
          label: 'New Folder…',
          icon: <FolderPlus size={13} />,
          onSelect: () => onCreateDirectory(directoryNode),
        },
        { id: 'sep', label: '', separatorBefore: true, disabled: true, onSelect: () => undefined },
      );
    }

    items.push(
      {
        id: 'rename',
        label: 'Rename…',
        shortcut: 'F2',
        icon: <Pencil size={13} />,
        disabled: busy,
        onSelect: startRename,
      },
      {
        id: 'copy-path',
        label: 'Copy Path',
        icon: <Copy size={13} />,
        onSelect: () => {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            void navigator.clipboard.writeText(node.path).catch(() => undefined);
          }
        },
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <Trash2 size={13} />,
        tone: 'danger',
        disabled: busy,
        onSelect: () => onDelete(node),
      },
    );

    return items;
  }, [busy, node, onCreateDirectory, onCreateFile, onDelete, isDirectory, startRename]);

  const activate = useCallback(() => {
    if (isDirectory) onToggleDirectory(node as VirtualDirectory);
    else if (isFile) onOpenFile(node as VirtualFile);
  }, [isDirectory, isFile, node, onOpenFile, onToggleDirectory]);

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isRenaming) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
        return;
      }
      if (event.key === 'F2') {
        event.preventDefault();
        startRename();
      }
    },
    [activate, isRenaming, startRename],
  );

  const accentClass = LANGUAGE_ACCENTS[node.language] ?? 'text-vscode-description-fg';
  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  const row = isRenaming ? (
    <div
      className="flex min-h-11 items-center gap-1 px-2 md:min-h-[22px]"
      style={indent}
      data-testid={`file-tree-row-${node.id}`}
    >
      <input
        ref={renameInputRef}
        value={draftName}
        aria-label={`Rename ${node.name}`}
        data-testid={`file-tree-rename-input-${node.id}`}
        onChange={(event) => {
          setDraftName(event.target.value);
          setRenameError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitRename();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelRename();
          }
        }}
        className={`min-w-0 flex-1 rounded-sm border bg-vscode-input-bg px-1 py-0.5 text-xs outline-none focus:border-vscode-accent ${
          renameError ? 'border-vscode-error-fg' : 'border-vscode-input-border'
        }`}
      />
      <ActionButton
        size="sm"
        variant="ghost"
        aria-label={`Confirm rename of ${node.name}`}
        testId={`file-tree-rename-confirm-${node.id}`}
        onClick={commitRename}
      >
        ✓
      </ActionButton>
      <ActionButton
        size="sm"
        variant="ghost"
        aria-label={`Cancel rename of ${node.name}`}
        testId={`file-tree-rename-cancel-${node.id}`}
        onClick={cancelRename}
      >
        ✕
      </ActionButton>
    </div>
  ) : (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isActive}
      aria-expanded={isDirectory ? isExpanded : undefined}
      tabIndex={0}
      data-testid={`file-tree-row-${node.id}`}
      data-node-path={node.path}
      data-node-type={node.type}
      onClick={activate}
      onKeyDown={handleRowKeyDown}
      style={indent}
      className={`group flex min-h-11 cursor-pointer items-center gap-1 pr-1 text-xs transition-colors md:min-h-[22px] ${
        isActive
          ? 'bg-vscode-list-active text-vscode-active-fg'
          : 'text-vscode-fg hover:bg-vscode-list-hover'
      }`}
    >
      {isDirectory ? (
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-100 ${isExpanded ? 'rotate-90' : ''}`}
        />
      ) : (
        <span aria-hidden="true" className="w-3.5 shrink-0" />
      )}

      {isDirectory ? (
        isExpanded ? (
          <FolderOpen size={14} aria-hidden="true" className="shrink-0 text-[#dcb67a]" />
        ) : (
          <Folder size={14} aria-hidden="true" className="shrink-0 text-[#dcb67a]" />
        )
      ) : (
        <FileIcon size={14} aria-hidden="true" className={`shrink-0 ${accentClass}`} />
      )}

      <span className="min-w-0 flex-1 truncate" data-testid={`file-tree-label-${node.id}`}>
        {node.name}
      </span>

      {isDirectory && children.length > 0 ? (
        <span className="shrink-0 rounded-full bg-vscode-badge-bg px-1.5 text-[10px] leading-4 text-vscode-fg">
          {children.length}
        </span>
      ) : null}

      <span className="shrink-0" onClick={(event) => event.stopPropagation()}>
        <DropdownMenu
          testId={`file-tree-menu-${node.id}`}
          triggerLabel={`Actions for ${node.name}`}
          align="end"
          items={menuItems}
          trigger={
            <span
              data-testid={`file-tree-more-${node.id}`}
              className="flex h-11 w-11 items-center justify-center rounded-sm text-vscode-description-fg hover:bg-vscode-button-hover hover:text-vscode-active-fg md:h-6 md:w-6"
            >
              <MoreHorizontal size={14} aria-hidden="true" />
            </span>
          }
        />
      </span>

      </div>
  );

  if (!isDirectory) {
    return (
      <>
        {row}
        {renameError ? (
          <p role="alert" className="px-2 text-[11px] text-vscode-error-fg">
            {renameError}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      {row}
      {renameError ? (
        <p role="alert" className="px-2 text-[11px] text-vscode-error-fg">
          {renameError}
        </p>
      ) : null}
      {isExpanded ? (
        <div role="group">
          {children.map((child) => (
            <FileTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              activeFileId={activeFileId}
              childrenByParent={childrenByParent}
              onToggleDirectory={onToggleDirectory}
              onOpenFile={onOpenFile}
              onRename={onRename}
              onDelete={onDelete}
              onCreateFile={onCreateFile}
              onCreateDirectory={onCreateDirectory}
              busy={busy}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

export const FileTreeNode = memo(FileTreeNodeComponent);
FileTreeNode.displayName = 'FileTreeNode';