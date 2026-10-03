/**
 * Runtime capability and platform detection.
 *
 * Every helper is SSR-safe: on the server it returns the conservative default
 * so the first client render matches the server markup.
 */

/** Minimum comfortable touch target, per the project's breakpoint matrix. */
export const MIN_TOUCH_TARGET_PX = 44;

/** Chromium-only client hints exposed on `navigator.userAgentData`. */
interface UserAgentData {
  platform?: string;
}

declare global {
  interface Navigator {
    userAgentData?: UserAgentData;
  }
}

export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

export function isApplePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  return /Mac|iPhone|iPod|iPad/.test(platform);
}

export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  if (/Android.*Mobile|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
    return true;
  }
  // iPadOS 13+ reports a desktop UA but exposes touch points.
  return isApplePlatform() && (navigator.maxTouchPoints ?? 0) > 1;
}

export function isTabletDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return /iPad|Android(?!.*Mobile)|Tablet|Silk/i.test(navigator.userAgent);
}

export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'unknown';

export function getBrowserFamily(): BrowserFamily {
  if (typeof navigator === 'undefined') return 'unknown';
  const userAgent = navigator.userAgent;
  if (/Edg\//i.test(userAgent)) return 'edge';
  if (/Firefox\//i.test(userAgent)) return 'firefox';
  if (/Chrome\//i.test(userAgent) && !/Chromium/i.test(userAgent)) return 'chrome';
  if (/Safari\//i.test(userAgent)) return 'safari';
  return 'unknown';
}

export type OperatingSystem = 'macOS' | 'iOS' | 'Windows' | 'Android' | 'Linux' | 'Unknown';

export function getOperatingSystem(): OperatingSystem {
  if (typeof navigator === 'undefined') return 'Unknown';
  const userAgent = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iOS';
  if (/Mac OS X/i.test(userAgent)) return 'macOS';
  if (/Windows/i.test(userAgent)) return 'Windows';
  if (/Android/i.test(userAgent)) return 'Android';
  if (/Linux|X11/i.test(userAgent)) return 'Linux';
  return 'Unknown';
}

/**
 * Detects whether a software keyboard is plausibly driving input. iOS Safari
 * does not fire `beforeinput` for punctuation keys, so pointer-type is the
 * reliable signal there.
 */
export function isVirtualKeyboardLikely(pointerType: string): boolean {
  return pointerType !== 'mouse' && pointerType !== 'pen';
}

/** True when the device can join a WebRTC mesh. */
export function supportsWebRTC(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    typeof window.RTCPeerConnection === 'function' &&
    typeof window.RTCDataChannel === 'function' &&
    typeof navigator !== 'undefined'
  );
}

/** Cross-tab same-origin sync channel used when signaling is unreachable. */
export function supportsBroadcastChannel(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.BroadcastChannel === 'function';
}

/** `true` for the coarse-pointer primary input used by touch-first layouts. */
export function prefersCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export type ColorScheme = 'dark' | 'light' | 'system';

export function getPreferredColorScheme(): ColorScheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Device pixel ratio clamped so HiDPI rendering cannot exhaust GPU memory. */
export function getSafeDevicePixelRatio(max = 2): number {
  if (typeof window === 'undefined') return 1;
  return Math.min(window.devicePixelRatio || 1, max);
}