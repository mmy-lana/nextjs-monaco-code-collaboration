'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { File as FileIcon, Search, Terminal } from 'lucide-react';
import { ModalOverlay } from '@/components/primitives/ModalOverlay';
import { TextInput } from '@/components/primitives/TextInput';
import type { CommandPaletteMode } from '@/types/editor';

export interface CommandPaletteFile {
  id: string;
  label: string;
  path: string;
  language: string;
}

export interface CommandPaletteCommand {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void | Promise<void>;
}

export interface CommandPaletteModalProps {
  open: boolean;
  onClose: () => void;
  files: readonly CommandPaletteFile[];
  commands: readonly CommandPaletteCommand[];
  /** Corpus opened first. `Tab` toggles between files and commands. */
  initialMode?: CommandPaletteMode;
  onOpenFile: (fileId: string) => void;
  onRunCommand: (command: CommandPaletteCommand) => void | Promise<void>;
}

interface PaletteEntry {
  key: string;
  label: string;
  detail: string;
  shortcut?: string;
  icon: 'file' | 'command';
  run: () => void | Promise<void>;
  /** Lower is better. Negative means "no match". */
  score: number;
}

/**
 * Subsequence fuzzy score. Rewards contiguous runs and word-boundary hits so
 * `utf` ranks `useVFS.ts` above an incidental match, mirroring VS Code's
 * Quick Open ranking. Exported so the ranking itself can be unit-checked.
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  if (!target) return -1;

  const needle = query.toLowerCase();
  const haystack = target.toLowerCase();

  const directIndex = haystack.indexOf(needle);
  if (directIndex === 0) return 1000;
  if (directIndex > 0) return 700 - directIndex;

  let score = 0;
  let cursor = 0;
  let streak = 0;

  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return -1;

    streak = found === cursor && cursor > 0 ? streak + 1 : 0;
    const isBoundary = found === 0 || /[\s/\-_.]/.test(haystack[found - 1] ?? '');
    score += 10 + streak * 6 + (isBoundary ? 8 : 0) - Math.min(found - cursor, 6);

    cursor = found + 1;
  }

  return score - target.length * 0.1;
}

/**
 * Quick Open + command palette.
 *
 * Fully keyboard driven (arrows, Enter, Escape, Tab to switch corpus) and
 * capped to a scrollable list so it stays usable on a 360px phone screen.
 */
export function CommandPaletteModal({
  open,
  onClose,
  files,
  commands,
  initialMode = 'files',
  onOpenFile,
  onRunCommand,
}: CommandPaletteModalProps) {
  const [mode, setMode] = useState<CommandPaletteMode>(initialMode);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setQuery('');
    setActiveIndex(0);
  }, [initialMode, open]);

  const entries = useMemo<PaletteEntry[]>(() => {
    if (mode === 'files') {
      return files
        .map((file) => ({
          key: `file:${file.id}`,
          label: file.label,
          detail: file.path,
          icon: 'file' as const,
          run: () => onOpenFile(file.id),
          score: Math.max(fuzzyScore(query, file.label) * 2, fuzzyScore(query, file.path)),
        }))
        .filter((entry) => query.trim() === '' || entry.score > 0);
    }

    return commands
      .map((command) => ({
        key: `command:${command.id}`,
        label: command.label,
        detail: command.category,
        shortcut: command.shortcut,
        icon: 'command' as const,
        run: () => onRunCommand(command),
        score: Math.max(fuzzyScore(query, command.label) * 2, fuzzyScore(query, command.category)),
      }))
      .filter((entry) => query.trim() === '' || entry.score > 0);
  }, [commands, files, mode, onOpenFile, onRunCommand, query]);

  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)),
    [entries],
  );

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(sortedEntries.length - 1, 0)));
  }, [sortedEntries.length]);

  useEffect(() => {
    const container = listRef.current;
    const active = container?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, sortedEntries.length]);

  const commit = useCallback(() => {
    const entry = sortedEntries[activeIndex];
    if (!entry) return;
    void Promise.resolve(entry.run()).then(onClose);
  }, [activeIndex, onClose, sortedEntries]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Every key handled here must stop propagating: the surrounding
      // ModalOverlay also implements Tab (focus trap) and Escape, and would
      // otherwise move focus to the close button or dismiss twice.
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((index) => (sortedEntries.length === 0 ? 0 : (index + 1) % sortedEntries.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((index) =>
          sortedEntries.length === 0 ? 0 : (index - 1 + sortedEntries.length) % sortedEntries.length,
        );
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commit();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        setMode((current) => (current === 'files' ? 'commands' : 'files'));
        setActiveIndex(0);
      }
    },
    [commit, onClose, sortedEntries.length],
  );

  return (
    <ModalOverlay
      testId="command-palette"
      open={open}
      onClose={onClose}
      title={mode === 'files' ? 'Go to File' : 'Command Palette'}
      description={
        mode === 'files'
          ? 'Search every file in this workspace. Press Tab for commands.'
          : 'Run a workspace command. Press Tab to search files.'
      }
      size="lg"
      initialFocusRef={inputRef}
    >
      <div className="flex flex-col gap-2" onKeyDown={handleKeyDown}>
        <TextInput
          inputRef={inputRef}
          testId="command-palette-input"
          label="Quick open query"
          placeholder={mode === 'files' ? 'Search files by name' : 'Search commands'}
          value={query}
          onChange={(value) => {
            setQuery(value);
            setActiveIndex(0);
          }}
          icon={
            mode === 'files' ? (
              <Search size={14} aria-hidden="true" />
            ) : (
              <Terminal size={14} aria-hidden="true" />
            )
          }
          autoFocus
        />

        <div
          ref={listRef}
          role="listbox"
          aria-label={mode === 'files' ? 'Matching files' : 'Matching commands'}
          data-testid="command-palette-list"
          className="max-h-[46vh] min-h-[120px] overflow-y-auto"
        >
          {sortedEntries.length === 0 ? (
            <p
              className="px-2 py-6 text-center text-xs text-vscode-description-fg"
              data-testid="command-palette-empty"
            >
              {mode === 'files'
                ? `No files match “${query}”.`
                : `No commands match “${query}”.`}
            </p>
          ) : (
            sortedEntries.map((entry, index) => (
              <div
                key={entry.key}
                role="option"
                aria-selected={index === activeIndex}
                data-testid={`command-palette-option-${entry.key}`}
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  void Promise.resolve(entry.run()).then(onClose);
                }}
                className={`flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs ${
                  index === activeIndex
                    ? 'bg-vscode-list-active text-vscode-active-fg'
                    : 'text-vscode-fg hover:bg-vscode-list-hover'
                }`}
              >
                {entry.icon === 'file' ? (
                  <FileIcon size={13} aria-hidden="true" className="shrink-0 opacity-70" />
                ) : (
                  <Terminal size={13} aria-hidden="true" className="shrink-0 opacity-70" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                <span className="min-w-0 shrink-0 truncate text-[10px] opacity-70">{entry.detail}</span>
                {entry.shortcut ? (
                  <span className="shrink-0 text-[10px] opacity-70">{entry.shortcut}</span>
                ) : null}
              </div>
            ))
          )}
        </div>

        <p className="text-[10px] text-vscode-description-fg">
          ↑↓ navigate · Enter open · Tab switch corpus · Esc dismiss
        </p>
      </div>
    </ModalOverlay>
  );
}