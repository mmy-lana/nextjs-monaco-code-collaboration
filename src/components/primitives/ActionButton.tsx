'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export type ActionButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ActionButtonSize = 'sm' | 'md' | 'lg';

/**
 * Minimum comfortable hit area. Desktop keeps the compact VS Code density;
 * touch surfaces widen to 44px so every control satisfies the project's
 * touch-target rule from the breakpoint matrix.
 */
const SIZE_CLASSES: Record<ActionButtonSize, string> = {
  sm: 'h-6 min-w-6 px-1.5 text-[11px]',
  md: 'h-7 min-w-7 px-2 text-xs',
  lg: 'h-9 min-h-11 min-w-11 px-3 text-sm',
};

const VARIANT_CLASSES: Record<ActionButtonVariant, string> = {
  primary: 'bg-vscode-accent text-white hover:bg-[#1a8ad9] active:bg-[#1177bb]',
  secondary: 'bg-vscode-button-secondary text-vscode-fg hover:bg-vscode-button-hover',
  ghost: 'bg-transparent text-vscode-fg hover:bg-vscode-button-hover',
  danger: 'bg-vscode-button-danger text-white hover:brightness-110',
};

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visible text. Omit when `icon` is provided; `aria-label` is then required. */
  children?: ReactNode;
  /** Leading glyph. */
  icon?: ReactNode;
  /** Trailing glyph (chevrons, badges, …). */
  trailingIcon?: ReactNode;
  variant?: ActionButtonVariant;
  size?: ActionButtonSize;
  /** Renders a spinner and blocks interaction while true. */
  loading?: boolean;
  /** Stretches to the width of the container. */
  block?: boolean;
  testId?: string;
}

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  {
    children,
    icon,
    trailingIcon,
    variant = 'secondary',
    size = 'md',
    loading = false,
    block = false,
    className,
    disabled,
    type = 'button',
    testId,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled === true || loading;

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-testid={testId}
      className={twMerge(
        'inline-flex select-none items-center justify-center gap-1.5 rounded-sm border border-transparent',
        'transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-45',
        SIZE_CLASSES[size],
        VARIANT_CLASSES[variant],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        icon
      )}
      {children ? <span className="truncate">{children}</span> : null}
      {trailingIcon}
    </button>
  );
});