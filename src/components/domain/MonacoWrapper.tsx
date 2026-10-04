'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { WebrtcProvider } from 'y-webrtc';
import type { editor as MonacoEditorNamespace, IDisposable } from 'monaco-editor';
import { MonacoDynamic, MonacoLoadingFallback } from '@/components/domain/MonacoDynamic';
import { useMonacoBinding } from '@/hooks/useMonacoBinding';
import { DEFAULT_MONACO_CONFIG, type DiagnosticItem, type MonacoEditorConfig } from '@/types/editor';

/**
 * Builds Monaco options from the user-facing config object.
 *
 * Exported so the mapping is directly assertable, and so `formatOnSave` — which
 * the application implements through its own save hook — stays clearly separated
 * from real constructor options.
 */
export function buildMonacoOptions(
  config: MonacoEditorConfig,
): MonacoEditorNamespace.IStandaloneEditorConstructionOptions {
  return {
    theme: config.theme,
    fontSize: config.fontSize,
    tabSize: config.tabSize,
    wordWrap: config.wordWrap,
    lineNumbers: config.lineNumbers,
    readOnly: config.readOnly,
    minimap: { enabled: config.minimap.enabled },
    cursorBlinking: config.cursorBlinking,
    cursorStyle: config.cursorStyle,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    renderWhitespace: 'selection',
    padding: { top: 8, bottom: 8 },
    fontFamily:
      "'SF Mono', 'JetBrains Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  };
}

/** Debounce window before a local edit is written back to IndexedDB. */
export const CONTENT_PERSIST_DEBOUNCE_MS = 250;

export interface MonacoWrapperProps {
  /** CRDT document backing the open file. */
  doc: Y.Doc | null;
  /** File id whose `Y.Text` this editor binds to; `null` when no tab is open. */
  fileId: string | null;
  filePath: string;
  language: string;
  /** Seed text used only when both the model and the CRDT are empty. */
  value: string;
  provider: WebrtcProvider | null;
  config?: MonacoEditorConfig;
  /** Called (debounced) after local edits so the VFS can persist them. */
  onContentChange?: (value: string) => void;
  /** Cursor/selection reporting for the status bar. */
  onCursorChange?: (position: { line: number; column: number }, selectionLength: number) => void;
  /**
   * Receives the live editor instance. The mobile accessory bar uses it to
   * route synthetic key presses into the real editor.
   */
  onEditorReady?: (editor: MonacoEditorNamespace.IStandaloneCodeEditor | null) => void;
  /** Monaco markers (TypeScript/JSON diagnostics) for the Problems panel. */
  onDiagnosticsChange?: (diagnostics: DiagnosticItem[]) => void;
  /** Explicit empty state — no file is open. */
  emptyState?: React.ReactNode;
}

/**
 * Monaco instance wired to the CRDT.
 *
 * Rendering is delegated to `MonacoDynamic` (which owns the client-only Monaco
 * import); this component owns the *behaviour*: option syncing, the two-way
 * Yjs binding, awareness decorations and cursor reporting.
 */
export function MonacoWrapper({
  doc,
  fileId,
  filePath,
  language,
  value,
  provider,
  config = DEFAULT_MONACO_CONFIG,
  onContentChange,
  onCursorChange,
  onEditorReady,
  onDiagnosticsChange,
  emptyState,
}: MonacoWrapperProps) {
  const [editor, setEditor] = useState<MonacoEditorNamespace.IStandaloneCodeEditor | null>(null);
  const [monaco, setMonaco] = useState<typeof import('monaco-editor') | null>(null);
  const cursorDisposableRef = useRef<IDisposable | null>(null);
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  const onDiagnosticsRef = useRef(onDiagnosticsChange);
  onDiagnosticsRef.current = onDiagnosticsChange;
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const options = useMemo(
    () => buildMonacoOptions(config),
    [config],
  );

  const handleMount = useCallback(
    (instance: MonacoEditorNamespace.IStandaloneCodeEditor, monacoInstance: typeof import('monaco-editor')) => {
      setEditor(instance);
      setMonaco(monacoInstance);
    },
    [],
  );

  // ── language registration ───────────────────────────────────────────────────
  useEffect(() => {
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (model && model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }
  }, [editor, language, monaco]);

  // ── option syncing (font size, minimap, read-only, …) ───────────────────────
  useEffect(() => {
    if (!editor) return;
    editor.updateOptions(options);
  }, [editor, options]);

  // ── local edits → debounced persistence ─────────────────────────────────────
  const handleLocalChange = useCallback((next: string) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      onContentChangeRef.current?.(next);
    }, CONTENT_PERSIST_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    },
    [],
  );

  // ── diagnostics (Problems panel) ───────────────────────────────────────────
  useEffect(() => {
    if (!monaco || !editor || !onDiagnosticsRef.current) return undefined;

    const collect = () => {
      const model = editor.getModel();
      const markers = model
        ? monaco.editor.getModelMarkers({ resource: model.uri })
        : monaco.editor.getModelMarkers({});

      const severityOf = (severity: number): DiagnosticItem['severity'] =>
        severity === 8 ? 'warning' : severity === 4 ? 'info' : 'error';

      onDiagnosticsRef.current?.(
        markers.map((marker, index) => ({
          id: `${marker.startLineNumber}-${marker.startColumn}-${index}`,
          fileId: fileId ?? 'active',
          filePath,
          message: marker.message,
          severity: severityOf(marker.severity),
          startLine: marker.startLineNumber,
          startColumn: marker.startColumn,
          endLine: marker.endLineNumber,
          endColumn: marker.endColumn,
          source: marker.source ?? 'monaco',
        })),
      );
    };

    collect();
    const disposable = monaco.editor.onDidChangeMarkers(collect);
    return () => disposable.dispose();
  }, [editor, fileId, filePath, monaco]);

  // Publish the editor instance to the host (accessory bar, shortcuts).
  useEffect(() => {
    if (!editor) return undefined;
    onEditorReadyRef.current?.(editor);
    return () => onEditorReadyRef.current?.(null);
  }, [editor]);

  // ── CRDT binding ────────────────────────────────────────────────────────────
  useMonacoBinding({ editor, doc, fileId, provider, initialContent: value, onLocalChange: handleLocalChange });

  // ── status bar reporting ───────────────────────────────────────────────────
  const reportCursor = useCallback(() => {
    if (!editor) return;
    const position = editor.getPosition();
    const selection = editor.getSelection();
    if (!position) return;

    let selectionLength = 0;
    const model = editor.getModel();
    if (model && selection && !selection.isEmpty()) {
      selectionLength = model.getValueLengthInRange({
        startLineNumber: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLineNumber: selection.endLineNumber,
        endColumn: selection.endColumn,
      });
    }

    onCursorChange?.({ line: position.lineNumber, column: position.column }, selectionLength);
  }, [editor, onCursorChange]);

  useEffect(() => {
    if (!editor) return undefined;

    cursorDisposableRef.current?.dispose();
    cursorDisposableRef.current = editor.onDidChangeCursorSelection(reportCursor);
    reportCursor();

    return () => {
      cursorDisposableRef.current?.dispose();
      cursorDisposableRef.current = null;
    };
  }, [editor, reportCursor]);

  if (!fileId) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center bg-vscode-editor-bg">
        {emptyState ?? (
          <p className="text-xs text-vscode-description-fg" data-testid="editor-empty-state">
            Open a file from the explorer to start editing together.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 w-full" data-testid="monaco-wrapper" data-file-id={fileId}>
      <MonacoDynamic
        path={fileId}
        language={language}
        theme={config.theme}
        value={value}
        options={options}
        onMount={handleMount}
        loadingFallback={<MonacoLoadingFallback />}
      />
    </div>
  );
}

export default MonacoWrapper;