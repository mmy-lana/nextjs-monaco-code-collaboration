'use client';

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

/**
 * The handlers a tooltip anchor may already own. Each is composed (chained)
 * rather than replaced, so wrapping a control never silently disables it.
 */
export interface TooltipAnchorProps {
  'aria-describedby'?: string;
  onPointerEnter?: (event: React.PointerEvent) => void;
  onPointerLeave?: (event: React.PointerEvent) => void;
  onPointerDown?: (event: React.PointerEvent) => void;
  onPointerUp?: (event: React.PointerEvent) => void;
  onPointerCancel?: (event: React.PointerEvent) => void;
  onFocus?: (event: React.FocusEvent) => void;
  onBlur?: (event: React.FocusEvent) => void;
}

export interface TooltipProps {
  /** Tooltip body. Kept short — VS Code truncates beyond ~60 characters. */
  content: ReactNode;
  /** Exactly one focusable/activatable element. */
  children: ReactElement<TooltipAnchorProps>;
  placement?: TooltipPlacement;
  /** Hover dwell time in milliseconds before the tooltip appears. */
  delay?: number;
  /** How long a touch press must be held before the tooltip appears. */
  holdDelay?: number;
  disabled?: boolean;
  testId?: string;
}

/**
 * Hybrid tooltip: hover on pointer devices, press-and-hold on touch devices.
 *
 * Touch has no hover state, so a long press is the only discoverable way to
 * surface the hint. The tooltip is inert (`pointer-events: none`) and dismissed
 * on scroll, pointer-up or Escape, so it can never swallow a tap.
 */
export function Tooltip({
  content,
  children,
  placement = 'top',
  delay = 400,
  holdDelay = 500,
  disabled = false,
  testId,
}: TooltipProps) {
  const tooltipId = useId();
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerTypeRef = useRef<'mouse' | 'touch' | 'pen'>('mouse');

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    setVisible(false);
    setCoords(null);
  }, [clearTimers]);

  const show = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const offset = 8;

    let top = rect.top - offset;
    let left = rect.left + rect.width / 2;

    if (placement === 'bottom') top = rect.bottom + offset;
    if (placement === 'left') {
      top = rect.top + rect.height / 2;
      left = rect.left - offset;
    }
    if (placement === 'right') {
      top = rect.top + rect.height / 2;
      left = rect.right + offset;
    }

    // Flip to the opposite side when the preferred side overflows.
    if (placement === 'top' && top < 48) top = rect.bottom + offset;
    if (placement === 'bottom' && top > window.innerHeight - 48) top = rect.top - offset;
    if (placement === 'left' && left < 0) left = rect.right + offset;
    if (placement === 'right' && left > window.innerWidth - 120) left = rect.left - offset;

    setCoords({ top, left });
    setVisible(true);
  }, [placement]);

  const scheduleShow = useCallback(
    (pointerType: 'mouse' | 'touch' | 'pen') => {
      pointerTypeRef.current = pointerType;
      clearTimers();
      if (pointerType === 'mouse') {
        timerRef.current = setTimeout(() => show(), delay);
      } else {
        holdTimerRef.current = setTimeout(() => show(), holdDelay);
      }
    },
    [clearTimers, delay, holdDelay, show],
  );

  useEffect(() => {
    if (!visible) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    const handleScroll = () => hide();

    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [visible, hide]);

  useEffect(() => clearTimers, [clearTimers]);

  const anchor = cloneElement(children, {
    'aria-describedby': visible ? tooltipId : undefined,
    onPointerEnter: (event: React.PointerEvent) => {
      children.props.onPointerEnter?.(event);
      if (disabled) return;
      scheduleShow((event.pointerType || 'mouse') as 'mouse' | 'touch' | 'pen');
    },
    onPointerLeave: (event: React.PointerEvent) => {
      children.props.onPointerLeave?.(event);
      // Touch pointers fire leave immediately after the tap; keep the tooltip.
      if (pointerTypeRef.current === 'mouse') hide();
    },
    onPointerDown: (event: React.PointerEvent) => {
      children.props.onPointerDown?.(event);
      if (disabled) return;
      scheduleShow((event.pointerType || 'touch') as 'mouse' | 'touch' | 'pen');
    },
    onPointerUp: (event: React.PointerEvent) => {
      children.props.onPointerUp?.(event);
      if (pointerTypeRef.current !== 'mouse') hide();
    },
    onPointerCancel: () => hide(),
    onFocus: (event: React.FocusEvent) => {
      children.props.onFocus?.(event);
      if (disabled) return;
      show();
    },
    onBlur: (event: React.FocusEvent) => {
      children.props.onBlur?.(event);
      hide();
    },
  });

  const transform =
    placement === 'left'
      ? 'translate(-100%, -50%)'
      : placement === 'right'
        ? 'translate(0, -50%)'
        : placement === 'bottom'
          ? 'translate(-50%, 0)'
          : 'translate(-50%, -100%)';

  const tooltip =
    visible && coords ? (
      <div
        id={tooltipId}
        role="tooltip"
        data-testid={testId}
        style={{ top: coords.top, left: coords.left, transform }}
        className="pointer-events-none fixed z-[80] max-w-[280px] rounded-sm border border-vscode-border bg-vscode-menu-bg px-2 py-1 text-[11px] leading-snug text-vscode-active-fg shadow-md shadow-black/40"
      >
        {content}
      </div>
    ) : null;

  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        {anchor}
      </span>
      {tooltip && typeof document !== 'undefined' ? createPortal(tooltip, document.body) : null}
    </>
  );
}