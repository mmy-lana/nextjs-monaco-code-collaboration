/**
 * Editor-facing domain model: tab strip, Monaco options, panel/activity routing,
 * diagnostics and command palette entries.
 */

export interface EditorTab {
  fileId: string;
  filePath: string;
  fileName: string;
  language: string;
  isDirty: boolean;
  isPinned: boolean;
}

export interface MonacoEditorConfig {
  theme: 'vs-dark' | 'vs-light' | 'hc-black';
  fontSize: number;
  tabSize: number;
  wordWrap: 'on' | 'off' | 'wordWrapColumn' | 'bounded';
  minimap: {
    enabled: boolean;
  };
  lineNumbers: 'on' | 'off' | 'relative';
  readOnly: boolean;
  /** Handled via application save hooks; not forwarded directly to the constructor. */
  formatOnSave: boolean;
  cursorBlinking: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
  cursorStyle: 'line' | 'block' | 'underline';
}

export const DEFAULT_MONACO_CONFIG: MonacoEditorConfig = {
  theme: 'vs-dark',
  fontSize: 14,
  tabSize: 2,
  wordWrap: 'on',
  minimap: { enabled: true },
  lineNumbers: 'on',
  readOnly: false,
  formatOnSave: true,
  cursorBlinking: 'smooth',
  cursorStyle: 'line',
};

export type ActivityBarTab = 'explorer' | 'search' | 'collaboration' | 'settings';

export type BottomPanelTab = 'terminal' | 'output' | 'problems' | 'lan-debug';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticItem {
  id: string;
  fileId: string;
  filePath: string;
  message: string;
  severity: DiagnosticSeverity;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  source: string;
}

export interface CommandPaletteItem {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void | Promise<void>;
}

/** Which corpus the command palette is searching: workspace files or commands. */
export type CommandPaletteMode = 'files' | 'commands';

export interface CommandPaletteResult {
  mode: CommandPaletteMode;
  items: CommandPaletteItem[];
  query: string;
}

/** Single hit produced by the local IndexedDB full-text search. */
export interface SearchMatch {
  fileId: string;
  filePath: string;
  lineNumber: number;
  lineText: string;
  /** Character offsets of the match inside `lineText`. */
  matchStart: number;
  matchEnd: number;
}