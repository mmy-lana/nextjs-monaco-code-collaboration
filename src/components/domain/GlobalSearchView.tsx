'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileSearch, Loader2, SearchX } from 'lucide-react';
import { getDB, type StoredFileContent } from '@/db/schema';
import type { SearchMatch } from '@/types/editor';

export interface GlobalSearchViewProps {
  /** Workspace whose files are scanned; bounds the node lookup. */
  workspaceId?: string;
  /** Pre-computed matches supplied by the host (used by tests and snapshot mode). */
  injectedResults?: readonly SearchMatch[];
  /** Matches per file cap, applied to both injected and queried results. */
  maxMatchesPerFile?: number;
  onOpenMatch: (match: SearchMatch) => void;
  /** Fires when the user commits a result (Enter / click). */
  error?: string | null;
}

const DEBOUNCE_MS = 200;
const DEFAULT_MAX_PER_FILE = 50;

/**
 * Upper bounds for a single scan.
 *
 * Without them a large workspace materialises every stored file — and a single
 * oversized paste can be half a megabyte of characters — into one synchronous
 * scan on the main thread, which locks the UI for the length of the query.
 */
export const MAX_SEARCH_FILES = 2000;
export const MAX_SEARCH_CHARACTERS = 5_000_000;

/**
 * Case-insensitive line scan shared by the live query and the exported helper.
 * Exported so the matching rules can be asserted directly.
 */
export function searchContents(
  query: string,
  contents: readonly Pick<StoredFileContent, 'contentId' | 'plainText'>[],
  filePaths: ReadonlyMap<string, string>,
  maxMatchesPerFile = DEFAULT_MAX_PER_FILE,
): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: SearchMatch[] = [];

  for (const content of contents) {
    const lines = content.plainText.split('\n');
    let fileMatches = 0;

    for (let index = 0; index < lines.length && fileMatches < maxMatchesPerFile; index += 1) {
      const lineText = lines[index];
      const column = lineText.toLowerCase().indexOf(needle);
      if (column === -1) continue;

      matches.push({
        fileId: content.contentId,
        filePath: filePaths.get(content.contentId) ?? '',
        lineNumber: index + 1,
        lineText,
        matchStart: column,
        matchEnd: column + needle.length,
      });
      fileMatches += 1;
    }
  }

  return matches;
}

/**
 * Local full-text search.
 *
 * Queries run straight against the Dexie `contents` table, so search works with
 * no network at all — which is the whole point of an offline-first workspace.
 * Input is debounced and stale responses are discarded by sequence number.
 */
export function GlobalSearchView({
  injectedResults,
  maxMatchesPerFile = DEFAULT_MAX_PER_FILE,
  workspaceId = 'default-workspace',
  onOpenMatch,
  error = null,
}: GlobalSearchViewProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [scanTruncated, setScanTruncated] = useState(false);
  const sequenceRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const runSearch = useCallback(
    async (needle: string) => {
      if (injectedResults) {
        setResults([...injectedResults]);
        setSearching(false);
        setHasSearched(true);
        return;
      }

      if (!needle.trim()) {
        setResults([]);
        setSearching(false);
        setHasSearched(false);
        return;
      }

      const sequence = sequenceRef.current + 1;
      sequenceRef.current = sequence;
      setSearching(true);

      try {
        const db = getDB();

        /*
         * Bounded read: only as many content rows as the scan budget allows are
         * pulled out of IndexedDB, and each one is length-capped before it
         * reaches the matcher.
         */
        const contents = await db.contents.limit(MAX_SEARCH_FILES).toArray();
        const nodes = await db.nodes.where('workspaceId').equals(workspaceId).toArray();

        const filePaths = new Map<string, string>();
        for (const node of nodes) {
          if (node.type === 'file') filePaths.set(node.id, node.path);
        }

        let scannedCharacters = 0;
        let truncated = false;
        const scannable: Pick<StoredFileContent, 'contentId' | 'plainText'>[] = [];

        for (const content of contents) {
          if (scannedCharacters >= MAX_SEARCH_CHARACTERS) {
            truncated = true;
            break;
          }
          const remaining = MAX_SEARCH_CHARACTERS - scannedCharacters;
          const text =
            content.plainText.length > remaining
              ? content.plainText.slice(0, remaining)
              : content.plainText;

          scannedCharacters += text.length;
          scannable.push({ contentId: content.contentId, plainText: text });
        }

        const matches = searchContents(needle, scannable, filePaths, maxMatchesPerFile);
        setScanTruncated(truncated || contents.length >= MAX_SEARCH_FILES);

        // Discard results from a superseded keystroke.
        if (sequenceRef.current !== sequence) return;
        setResults(matches);
      } catch (searchError) {
        if (sequenceRef.current !== sequence) return;
        setResults([]);
        setHasSearched(true);
        setSearching(false);
        throw searchError;
      } finally {
        if (sequenceRef.current === sequence) setSearching(false);
      }
    },
    [injectedResults, maxMatchesPerFile, workspaceId],
  );

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void runSearch(value).catch(() => undefined);
      }, DEBOUNCE_MS);
    },
    [runSearch],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, SearchMatch[]>();
    for (const match of results) {
      const bucket = groups.get(match.filePath);
      if (bucket) bucket.push(match);
      else groups.set(match.filePath, [match]);
    }
    return Array.from(groups.entries());
  }, [results]);

  const totalMatches = results.length;
  const truncated = results.length >= DEFAULT_MAX_PER_FILE || scanTruncated;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="global-search-view">
      <header className="shrink-0 px-3 py-2">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-vscode-description-fg">
          Search
        </h2>
        <label className="sr-only" htmlFor="global-search-input">
          Search in files
        </label>
        <div className="flex items-center gap-1.5 rounded-sm border border-vscode-input-border bg-vscode-input-bg px-2 py-1.5 focus-within:border-vscode-accent">
          <FileSearch size={13} aria-hidden="true" className="shrink-0 text-vscode-description-fg" />
          <input
            id="global-search-input"
            data-testid="global-search-input"
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results.length > 0) onOpenMatch(results[0]);
              if (event.key === 'Escape') setQuery('');
            }}
            placeholder="Search in files"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-vscode-input-placeholder"
          />
          {searching ? (
            <Loader2 size={13} aria-hidden="true" className="shrink-0 animate-spin text-vscode-description-fg" />
          ) : null}
        </div>

        {hasSearched && query.trim() ? (
          <p className="mt-1.5 text-[10px] text-vscode-description-fg" data-testid="search-summary">
            {totalMatches === 0
              ? `No results for “${query.trim()}”`
              : `${totalMatches} result${totalMatches === 1 ? '' : 's'} in ${grouped.length} file${grouped.length === 1 ? '' : 's'}`}
            {truncated && totalMatches > 0 ? ' (showing the first matches per file)' : ''}
          </p>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {error ? (
          <p role="alert" className="px-3 py-2 text-[11px] text-vscode-error-fg">
            {error}
          </p>
        ) : !query.trim() ? (
          <p className="px-3 py-4 text-center text-[11px] text-vscode-description-fg" data-testid="search-idle">
            Type to search every file stored in this workspace. Results come from local IndexedDB —
            no server is contacted.
          </p>
        ) : hasSearched && results.length === 0 ? (
          <div className="px-3 py-6 text-center" data-testid="search-empty">
            <SearchX size={20} aria-hidden="true" className="mx-auto opacity-50" />
            <p className="mt-2 text-xs text-vscode-fg">No matches</p>
            <p className="mt-1 text-[11px] text-vscode-description-fg">
              Try a shorter query, or check that the file has content loaded.
            </p>
          </div>
        ) : (
          grouped.map(([path, matches]) => (
            <section key={path} className="border-b border-vscode-border/60 last:border-b-0">
              <h3
                className="sticky top-0 z-10 truncate bg-vscode-sidebar-bg px-3 py-1 text-[11px] font-medium text-vscode-fg"
                title={path}
              >
                {path}
              </h3>
              {matches.map((match) => (
                <button
                  key={`${match.fileId}-${match.lineNumber}-${match.matchStart}`}
                  type="button"
                  data-testid={`search-result-${match.fileId}-${match.lineNumber}`}
                  onClick={() => onOpenMatch(match)}
                  className="flex w-full items-start gap-2 px-3 py-1 text-left font-mono text-[11px] text-vscode-fg hover:bg-vscode-list-hover"
                >
                  <span className="shrink-0 tabular-nums text-vscode-description-fg">
                    {match.lineNumber}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {match.lineText.slice(0, match.matchStart)}
                    <mark className="bg-vscode-warning-fg/40 text-vscode-active-fg">
                      {match.lineText.slice(match.matchStart, match.matchEnd)}
                    </mark>
                    {match.lineText.slice(match.matchEnd)}
                  </span>
                </button>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}