'use client';

import { useEffect, useRef } from 'react';

export type ShortcutScope = 'global' | 'editor';

export interface KeyboardShortcut {
  /** Canonical id, e.g. `workbench.action.quickOpen`. */
  id: string;
  /** `key` as reported by `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  /** Requires Command on macOS / Control elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** When true the shortcut also fires while focus sits inside the editor. */
  allowInEditor?: boolean;
  description: string;
  /** Display form shown in menus and the palette, e.g. `⌘P`. */
  display: string;
  handler: (event: KeyboardEvent) => void;
  scope?: ShortcutScope;
}

export interface UseKeyboardShortcutsOptions {
  /** Disables every binding (used while a modal owns the keyboard). */
  enabled?: boolean;
  /** Element the listener is attached to; defaults to `document`. */
  target?: HTMLElement | null;
}

const isMac = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPod|iPad/.test(navigator.platform ?? navigator.userAgent ?? '');
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
};

/**
 * Monaco is the one place where unhandled keys (typing, Ctrl+A) must still work.
 * Its textarea is matched by the stable `.monaco-editor textarea` class rather
 * than by content, which React controls.
 */
const isEditorTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && Boolean(target.closest('.monaco-editor'));

/**
 * Central keyboard registry.
 *
 * One `keydown` listener drives the whole IDE: every command declares its own
 * combination, so bindings can be surfaced in menus and the palette without
 * duplicating `keydown` handlers across components.
 */
export function useKeyboardShortcuts(
  shortcuts: readonly KeyboardShortcut[],
  { enabled = true, target = null }: UseKeyboardShortcutsOptions = {},
): void {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    const node: HTMLElement | Document = target ?? document;
    const mac = isMac();

    const handleKeyDown = (event: Event): void => {
      const keyboardEvent = event as KeyboardEvent;
      const inEditor = isEditorTarget(keyboardEvent.target);
      const inField = isEditableTarget(keyboardEvent.target);

      const key = keyboardEvent.key.toLowerCase();
      const modPressed = mac ? keyboardEvent.metaKey : keyboardEvent.ctrlKey;
      const otherModPressed = mac ? keyboardEvent.ctrlKey : keyboardEvent.metaKey;

      for (const shortcut of shortcutsRef.current) {
        if (shortcut.key.toLowerCase() !== key) continue;
        if (Boolean(shortcut.mod) !== modPressed) continue;
        if (Boolean(shortcut.shift) !== keyboardEvent.shiftKey) continue;
        if (Boolean(shortcut.alt) !== keyboardEvent.altKey) continue;
        if (inEditor && !shortcut.allowInEditor) continue;
        // Typing in a text field must never trigger a bare-letter binding.
        if (inField && !shortcut.mod && !shortcut.alt) continue;
        // The non-primary modifier must not be held for a plain binding.
        if (!shortcut.mod && otherModPressed) continue;

        keyboardEvent.preventDefault();
        keyboardEvent.stopPropagation();
        shortcut.handler(keyboardEvent);
        return;
      }
    };

    node.addEventListener('keydown', handleKeyDown, true);
    return () => node.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled, target]);
}

/** Formats a combination for display on the current platform. */
export function formatShortcut(shortcut: Pick<KeyboardShortcut, 'key' | 'mod' | 'shift' | 'alt'>): string {
  if (typeof navigator === 'undefined') return shortcut.key.toUpperCase();
  const mac = /Mac|iPhone|iPod|iPad/.test(navigator.platform ?? navigator.userAgent ?? '');
  const parts: string[] = [];
  if (shortcut.mod) parts.push(mac ? '⌘' : 'Ctrl');
  if (shortcut.shift) parts.push(mac ? '⇧' : 'Shift');
  if (shortcut.alt) parts.push(mac ? '⌥' : 'Alt');
  parts.push(shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  return mac ? parts.join('') : parts.join('+');
}