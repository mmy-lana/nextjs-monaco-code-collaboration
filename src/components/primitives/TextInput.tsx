'use client';

import {
  forwardRef,
  useCallback,
  useId,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { twMerge } from 'tailwind-merge';

export type TextInputSize = 'sm' | 'md';
export type TextInputTone = 'default' | 'error';

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange'> {
  value: string;
  /** Fires on every keystroke with the raw input value. */
  onChange: (value: string) => void;
  /** Fired on Enter — quick-open and the new-file flow commit through this. */
  onEnter?: (value: string) => void;
  /** Fired on Escape — overlays dismiss through this. */
  onEscape?: () => void;
  size?: TextInputSize;
  tone?: TextInputTone;
  /** Validation message rendered beneath the field. */
  errorMessage?: string | null;
  /** Accessible label. Rendered visually hidden unless `hideLabel` is false. */
  label: string;
  hideLabel?: boolean;
  /** Leading glyph. */
  icon?: ReactNode;
  /** Shows a trailing clear button whenever the field is non-empty. */
  clearable?: boolean;
  /** Escape hatch for focus management (quick open, rename, modals). */
  inputRef?: React.Ref<HTMLInputElement>;
  testId?: string;
}

const SIZE_CLASSES: Record<TextInputSize, string> = {
  sm: 'h-6 px-1.5 text-xs',
  md: 'h-8 min-h-11 px-2 text-sm md:min-h-8',
};

export const TextInput = forwardRef<HTMLDivElement, TextInputProps>(function TextInput(
  {
    value,
    onChange,
    onEnter,
    onEscape,
    size = 'md',
    tone = 'default',
    errorMessage,
    label,
    hideLabel = true,
    icon,
    clearable = false,
    className,
    disabled,
    inputRef,
    testId,
    placeholder,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const inputId = `text-input-${generatedId}`;
  const errorId = `${inputId}-error`;

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onEnter?.(value);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape?.();
      }
    },
    [onEnter, onEscape, value],
  );

  const showClear = clearable && value.length > 0 && !disabled;
  const isInvalid = tone === 'error' || Boolean(errorMessage);

  return (
    <div ref={ref} className={twMerge('flex w-full flex-col gap-1', className)}>
      <label
        htmlFor={inputId}
        className={hideLabel ? 'sr-only' : 'block text-xs text-vscode-description-fg'}
      >
        {label}
      </label>

      <div
        className={twMerge(
          'flex items-center gap-1.5 rounded-sm border bg-vscode-input-bg transition-colors',
          'focus-within:border-vscode-accent',
          isInvalid ? 'border-vscode-error-fg' : 'border-vscode-input-border',
          SIZE_CLASSES[size],
        )}
      >
        {icon ? (
          <span aria-hidden="true" className="flex shrink-0 items-center text-vscode-description-fg">
            {icon}
          </span>
        ) : null}

        <input
          id={inputId}
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={hideLabel ? label : undefined}
          aria-invalid={isInvalid || undefined}
          aria-describedby={errorMessage ? errorId : undefined}
          data-testid={testId}
          className="min-w-0 flex-1 bg-transparent text-vscode-input-fg outline-none placeholder:text-vscode-input-placeholder disabled:cursor-not-allowed"
          {...rest}
        />

        {showClear ? (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => onChange('')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-vscode-description-fg hover:bg-vscode-button-hover hover:text-vscode-active-fg"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">
              <path d="M8 1a7 7 0 1 0 4.19 12.6l-2.4-2.4A5 5 0 1 1 13 8a4.96 4.96 0 0 1-1.4 3.4l1.42 1.42A7 7 0 0 0 8 1Zm2.83 3.83 1.41-1.41L10.4 1.6 9 1.59 8.17 2.4l1.42 1.42L8.42 5 9 5.59l1.17-1.18 1.42 1.42L13.42 7.4 14 6.83l-1.17-1.18L14 4.48Z" />
            </svg>
          </button>
        ) : null}
      </div>

      {errorMessage ? (
        <p id={errorId} role="alert" className="text-[11px] leading-tight text-vscode-error-fg">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
});