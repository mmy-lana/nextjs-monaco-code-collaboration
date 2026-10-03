'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { twMerge } from 'tailwind-merge';

export type SplitterOrientation = 'vertical' | 'horizontal';

export interface ResizableSplitterProps {
  orientation: SplitterOrientation;
  /** Current size of the resizable pane, in pixels. */
  size: number;
  minSize: number;
  maxSize: number;
  /** Fires continuously while dragging and on every keyboard nudge. */
  onResize: (nextSize: number) => void;
  /** Fired once when a drag gesture completes. */
  onResizeEnd?: (finalSize: number) => void;
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
  /** Keyboard nudge step in pixels. */
  step?: number;
  /** Inverts the drag direction (used for right-hand / bottom panes). */
  invert?: boolean;
  className?: string;
  testId?: string;
}

/**
 * Pointer-events splitter supporting mouse, pen and multi-touch.
 *
 * `touch-action: none` (applied globally via `.touch-splitter`) is what stops
 * iOS Safari from stealing the gesture for scrolling. Pointer capture keeps the
 * drag alive when the pointer leaves the 1px rail mid-gesture, and arrow keys
 * provide an accessible non-pointer resize path.
 */
export function ResizableSplitter({
  orientation,
  size,
  minSize,
  maxSize,
  onResize,
  onResizeEnd,
  label,
  step = 16,
  invert = false,
  className,
  testId,
}: ResizableSplitterProps) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ pointer: number; position: number } | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const latestSizeRef = useRef(size);

  useEffect(() => {
    latestSizeRef.current = size;
  }, [size]);

  const clamp = useCallback(
    (value: number) => Math.min(maxSize, Math.max(minSize, Math.round(value))),
    [maxSize, minSize],
  );

  const beginDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== undefined && event.button !== 0 && event.pointerType === 'mouse') return;
      event.preventDefault();

      const position = orientation === 'vertical' ? event.clientX : event.clientY;
      startRef.current = { pointer: position, position: size };
      activePointerRef.current = event.pointerId;
      setDragging(true);

      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is unavailable on some older WebKit builds; the
        // document-level listeners below still complete the gesture.
      }
    },
    [orientation, size],
  );

  const moveDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || !startRef.current || activePointerRef.current !== event.pointerId) return;
      event.preventDefault();

      const position = orientation === 'vertical' ? event.clientX : event.clientY;
      const delta = position - startRef.current.pointer;
      const signedDelta = invert ? -delta : delta;
      const next = clamp(startRef.current.position + signedDelta);

      latestSizeRef.current = next;
      onResize(next);
    },
    [clamp, dragging, invert, onResize, orientation],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      if (activePointerRef.current !== null && activePointerRef.current !== event.pointerId) return;

      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Nothing to release when capture was never acquired.
      }

      startRef.current = null;
      activePointerRef.current = null;
      setDragging(false);
      onResizeEnd?.(latestSizeRef.current);
    },
    [dragging, onResizeEnd],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const decreaseKey = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
      const increaseKey = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';

      const isDecrease = event.key === decreaseKey || (invert && event.key === increaseKey);
      const isIncrease = event.key === increaseKey || (invert && event.key === decreaseKey);

      if (!isDecrease && !isIncrease && event.key !== 'Home' && event.key !== 'End') return;

      event.preventDefault();

      let next: number;
      if (event.key === 'Home') next = minSize;
      else if (event.key === 'End') next = maxSize;
      else next = clamp(size + (isIncrease ? step : -step));

      latestSizeRef.current = next;
      onResize(next);
      onResizeEnd?.(next);
    },
    [clamp, invert, maxSize, minSize, onResize, onResizeEnd, orientation, size, step],
  );

  // A drag that ends outside the window (pointer released over the OS chrome)
  // never fires pointerup on the element, so close it defensively.
  useEffect(() => {
    if (!dragging) return undefined;

    const cancel = () => {
      startRef.current = null;
      activePointerRef.current = null;
      setDragging(false);
      onResizeEnd?.(latestSizeRef.current);
    };

    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);

    return () => {
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [dragging, onResizeEnd]);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(size)}
      aria-valuemin={minSize}
      aria-valuemax={maxSize}
      data-dragging={dragging}
      data-testid={testId}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className={twMerge(
        'touch-splitter',
        orientation === 'vertical' ? 'touch-splitter-vertical' : 'touch-splitter-horizontal',
        className,
      )}
    />
  );
}