'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTouchDevice } from '@/utils/platform';

export type ViewportOrientation = 'portrait' | 'landscape';

export interface ViewportState {
  /** Visual viewport width in CSS pixels. */
  width: number;
  /** Visual viewport height in CSS pixels (keyboard-aware). */
  height: number;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  keyboardOpen: boolean;
  /** Pixels covered by the software keyboard, 0 when it is closed. */
  keyboardHeight: number;
  orientation: ViewportOrientation;
  isTouch: boolean;
  /** Height of the accessory bar that sits above the keyboard. */
  keyboardBarHeight: number;
}

/** Matches the breakpoint matrix: mobile < 768px, tablet < 1024px. */
export const MOBILE_BREAKPOINT = 768;
export const TABLET_BREAKPOINT = 1024;

/**
 * A keyboard taller than this is treated as "open". Small deltas are pinch-zoom
 * or browser-UI collapse, which must not toggle the accessory bar.
 */
export const KEYBOARD_OPEN_THRESHOLD_PX = 150;

/** Height of the mobile quick-input bar, mirrored into `--keyboard-bar-height`. */
export const KEYBOARD_BAR_HEIGHT_PX = 40;

const SSR_VIEWPORT: ViewportState = {
  width: 1024,
  height: 768,
  isMobile: false,
  isTablet: false,
  isDesktop: true,
  keyboardOpen: false,
  keyboardHeight: 0,
  orientation: 'landscape',
  isTouch: false,
  keyboardBarHeight: 0,
};

const readViewport = (): ViewportState => {
  if (typeof window === 'undefined') return SSR_VIEWPORT;

  const visualViewport = window.visualViewport;
  const width = Math.round(visualViewport ? visualViewport.width : window.innerWidth);
  const windowHeight = window.innerHeight;
  const height = Math.round(visualViewport ? visualViewport.height : window.innerHeight);

  const keyboardHeight = Math.max(0, windowHeight - height);
  const keyboardOpen = keyboardHeight > KEYBOARD_OPEN_THRESHOLD_PX;

  return {
    width,
    height,
    isMobile: width < MOBILE_BREAKPOINT,
    isTablet: width >= MOBILE_BREAKPOINT && width < TABLET_BREAKPOINT,
    isDesktop: width >= TABLET_BREAKPOINT,
    keyboardOpen,
    keyboardHeight,
    orientation: height >= width ? 'portrait' : 'landscape',
    isTouch: isTouchDevice(),
    keyboardBarHeight: keyboardOpen ? KEYBOARD_BAR_HEIGHT_PX : 0,
  };
};

/**
 * Tracks the *visual* viewport and publishes the derived metrics as CSS custom
 * properties.
 *
 * `100vh` is wrong on iOS and Android: it reports the viewport with the URL bar
 * expanded and never shrinks when the software keyboard opens, which clips the
 * bottom of the editor. Every layout dimension is therefore computed from
 * `--vh`, `--keyboard-bar-height` and `--statusbar-height` instead.
 */
export function useResponsiveLayout(): ViewportState {
  const [viewport, setViewport] = useState<ViewportState>(SSR_VIEWPORT);
  const frameRef = useRef<number | null>(null);

  const publish = useCallback((next: ViewportState) => {
    setViewport(next);

    const root = document.documentElement;
    root.style.setProperty('--vh', `${next.height * 0.01}px`);
    root.style.setProperty('--keyboard-height', `${next.keyboardHeight}px`);
    root.style.setProperty('--keyboard-bar-height', `${next.keyboardBarHeight}px`);
    root.style.setProperty(
      '--statusbar-height',
      next.isMobile ? '28px' : '24px',
    );
  }, []);

  const measure = useCallback(() => {
    // Visual viewport events can fire several times per frame during a keyboard
    // animation; coalescing keeps layout thrash to one write per frame.
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      publish(readViewport());
    });
  }, [publish]);

  useEffect(() => {
    publish(readViewport());

    const visualViewport = window.visualViewport;
    if (visualViewport) {
      visualViewport.addEventListener('resize', measure);
      visualViewport.addEventListener('scroll', measure);
    }
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (visualViewport) {
        visualViewport.removeEventListener('resize', measure);
        visualViewport.removeEventListener('scroll', measure);
      }
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [measure, publish]);

  return viewport;
}