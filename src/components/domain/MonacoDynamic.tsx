'use client';

import dynamic from 'next/dynamic';
import type { editor as MonacoEditorNamespace } from 'monaco-editor';

/**
 * SSR-safe dynamic loader for `@monaco-editor/react`.
 *
 * Monaco must never be part of the server bundle: it touches `window`,
 * `document` and `navigator` at module scope, and it is several megabytes of
 * JavaScript that should never block first paint.
 *
 * The loader is pointed at the *local* `monaco-editor` package rather than the
 * default jsDelivr CDN. That matters here: an air-gapped LAN deployment has no
 * internet access, so a CDN-hosted Monaco would simply fail to load.
 */

export interface MonacoDynamicProps {
  /** Monaco model identity — one model per open file. */
  path: string;
  language: string;
  theme: string;
  value: string;
  options: MonacoEditorNamespace.IStandaloneEditorConstructionOptions;
  onMount: (
    editor: MonacoEditorNamespace.IStandaloneCodeEditor,
    monaco: typeof import('monaco-editor'),
  ) => void;
  loadingFallback?: React.ReactNode;
}

export function MonacoLoadingFallback(): React.ReactElement {
  return (
    <div
      className="flex h-full min-h-0 w-full items-center justify-center bg-vscode-editor-bg"
      data-testid="monaco-loading"
    >
      <div className="flex flex-col items-center gap-3" role="status" aria-live="polite">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-vscode-accent border-t-transparent" />
        <p className="text-xs text-vscode-description-fg">Loading editor engine…</p>
      </div>
    </div>
  );
}

const MonacoEditor = dynamic(
  async () => {
    const [monacoReact, monaco] = await Promise.all([
      import('@monaco-editor/react'),
      import('monaco-editor'),
    ]);

    // Serve Monaco from the app's own origin — required for offline/LAN use.
    monacoReact.loader.config({ monaco });

    const globalScope = window as unknown as { MonacoEnvironment?: unknown };

    // Monaco needs a web worker for its language services; serving it from the
    // same bundle keeps the "no external network" guarantee intact. An existing
    // configuration is respected so a host (or a test harness) can supply its own.
    if (!globalScope.MonacoEnvironment) {
      globalScope.MonacoEnvironment = {
        getWorker(): Worker {
          return new Worker(
            new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
            { type: 'module', name: 'monaco-editor-worker' },
          );
        },
      };
    }

    return monacoReact;
  },
  {
    ssr: false,
    loading: () => <MonacoLoadingFallback />,
  },
);

export function MonacoDynamic({
  path,
  language,
  theme,
  value,
  options,
  onMount,
  loadingFallback,
}: MonacoDynamicProps): React.ReactElement {
  return (
    <div className="monaco-editor-container selectable h-full min-h-0 w-full" data-testid="monaco-editor-root">
      <MonacoEditor
        path={path}
        language={language}
        theme={theme}
        defaultValue={value}
        options={options}
        onMount={onMount}
        loading={loadingFallback ?? <MonacoLoadingFallback />}
        className="h-full"
      />
    </div>
  );
}

export default MonacoDynamic;