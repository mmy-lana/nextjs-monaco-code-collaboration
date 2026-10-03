'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { twMerge } from 'tailwind-merge';

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalOverlayProps {
  open: boolean;
  onClose: () => void;
  /** Heading rendered in the title bar. */
  title: string;
  /** Optional supporting copy under the heading. */
  description?: string;
  children?: ReactNode;
  /** Pinned action row rendered under the body. */
  footer?: ReactNode;
  size?: ModalSize;
  /** Element focused when the modal opens (quick-open input, confirm button…). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Element focused when the modal closes; defaults to the opener. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Set false for destructive confirmations that require an explicit choice. */
  closeOnBackdropClick?: boolean;
  testId?: string;
}

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'w-[min(420px,calc(100vw-16px))]',
  md: 'w-[min(500px,calc(100vw-16px))]',
  lg: 'w-[min(600px,calc(100vw-16px))]',
};

/** Elements that can receive focus inside the trapped region. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Modal surface with a real focus trap and body scroll-lock.
 *
 * Tab cycles within the dialog, Escape dismisses it, and focus returns to the
 * element that opened it so keyboard users never lose their place in the IDE.
 */
export function ModalOverlay({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  initialFocusRef,
  returnFocusRef,
  closeOnBackdropClick = true,
  testId,
}: ModalOverlayProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const getFocusable = useCallback((): HTMLElement[] => {
    const dialog = dialogRef.current;
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    // Scroll-lock: the shell is already `overflow: hidden`, but nested panes
    // are independently scrollable, so the body is pinned explicitly too.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTarget = initialFocusRef?.current ?? getFocusable()[0] ?? dialogRef.current;
    focusTarget?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      const restoreTo = returnFocusRef?.current ?? previouslyFocusedRef.current;
      restoreTo?.focus?.();
    };
  }, [open, initialFocusRef, returnFocusRef, getFocusable]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [getFocusable, onClose],
  );

  const handleBackdropClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!closeOnBackdropClick) return;
      if (event.target !== event.currentTarget) return;
      onClose();
    },
    [closeOnBackdropClick, onClose],
  );

  if (!open || typeof document === 'undefined') return null;

  const content = (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 p-2 pt-[10vh] md:items-center md:p-6"
      onMouseDown={handleBackdropClick}
      data-testid={testId ? `${testId}-backdrop` : undefined}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-testid={testId}
        onKeyDown={handleKeyDown}
        className={twMerge(
          'flex max-h-[80vh] flex-col overflow-hidden rounded-sm border border-vscode-border bg-vscode-menu-bg shadow-2xl shadow-black/50',
          'fade-in',
          SIZE_CLASSES[size],
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-vscode-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold text-vscode-active-fg">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-xs text-vscode-description-fg">
                {description}
              </p>
            ) : null}
          </div>

          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            data-testid={testId ? `${testId}-close` : undefined}
            className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-vscode-description-fg hover:bg-vscode-button-hover hover:text-vscode-active-fg"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.75.75 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 1 1-.976 1.133L8 9.06l-3.22 3.22a.749.749 0 0 1-1.275-.326.75.75 0 0 1 .215-.734L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

        {footer ? (
          <footer className="shrink-0 border-t border-vscode-border px-4 py-3">{footer}</footer>
        ) : null}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}