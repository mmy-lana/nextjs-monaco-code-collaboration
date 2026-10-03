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
  formatOnSave: boolean;
  cursorBlinking: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
  cursorStyle: 'line' | 'block' | 'underline';
}

export type ActivityBarTab = 'explorer' | 'search' | 'collaboration' | 'settings';

export type BottomPanelTab = 'terminal' | 'output' | 'problems' | 'lan-debug';

export interface DiagnosticItem {
  id: string;
  fileId: string;
  filePath: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
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
