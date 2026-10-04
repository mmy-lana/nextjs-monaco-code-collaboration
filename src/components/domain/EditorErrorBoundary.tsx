'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { ActionButton } from '@/components/primitives/ActionButton';

export interface EditorErrorBoundaryProps {
  children: ReactNode;
  /** Shown in the fallback so the user knows which surface failed. */
  label?: string;
}

interface EditorErrorBoundaryState {
  error: Error | null;
}

/**
 * Contains failures raised while mounting or rendering the editor surface.
 *
 * Without a boundary, a rejected Monaco chunk, a worker failure or a bad model
 * attachment propagates to the root and unmounts the entire IDE shell — losing
 * the file tree, the tab strip and the user's place. Scoping the failure to the
 * editor keeps the workspace navigable and recoverable.
 */
export class EditorErrorBoundary extends Component<
  EditorErrorBoundaryProps,
  EditorErrorBoundaryState
> {
  override state: EditorErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): EditorErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The error is surfaced in the fallback UI; this keeps the stack in the
    // browser console so a support session can read it.
    console.error('Editor surface failed to render:', error, info.componentStack);
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        data-testid="editor-error-boundary"
        className="flex h-full min-h-0 w-full items-center justify-center bg-vscode-editor-bg p-6"
      >
        <div className="max-w-md text-center">
          <AlertTriangle
            size={20}
            aria-hidden="true"
            className="mx-auto text-vscode-error-fg"
          />
          <h2 className="mt-3 text-sm font-semibold text-vscode-active-fg">
            {this.props.label ?? 'The editor'} could not start
          </h2>
          <p className="mt-2 break-words text-xs text-vscode-description-fg">
            Your files are safe in local storage. Reload the editor surface to try again; if it keeps
            failing, clear the site data and reload the workspace.
          </p>
          <p className="mt-2 break-words font-mono text-[11px] text-vscode-description-fg">
            {error.message}
          </p>
          <ActionButton
            testId="editor-error-retry"
            size="sm"
            variant="primary"
            className="mt-4"
            icon={<RefreshCw size={13} aria-hidden="true" />}
            onClick={this.handleRetry}
          >
            Retry
          </ActionButton>
        </div>
      </div>
    );
  }
}

export default EditorErrorBoundary;