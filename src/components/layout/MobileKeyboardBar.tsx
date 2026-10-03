'use client';

import { memo } from 'react';
import { IndentIncrease, IndentDecrease, Redo2, Undo2 } from 'lucide-react';

export type KeyboardBarCommand = 'indent' | 'outdent' | 'undo' | 'redo' | 'undoSelection' | 'redoSelection';

export interface MobileKeyboardBarProps {
  visible: boolean;
  /** Number of spaces inserted per indent step. */
  indentSize?: number;
  /** Inserts literal text at the caret (brackets, semicolons, …). */
  onInsert: (text: string) => void;
  /** Runs an editor command (indent, undo, redo). */
  onCommand: (command: KeyboardBarCommand) => void;
  /** Disabled while the editor is loading or read-only. */
  disabled?: boolean;
}

const INSERT_KEYS: { label: string; insert: string; ariaLabel: string }[] = [
  { label: 'Tab', insert: '\t', ariaLabel: 'Insert tab character' },
  { label: '{', insert: '{', ariaLabel: 'Insert opening brace' },
  { label: '}', insert: '}', ariaLabel: 'Insert closing brace' },
  { label: '[', insert: '[', ariaLabel: 'Insert opening bracket' },
  { label: ']', insert: ']', ariaLabel: 'Insert closing bracket' },
  { label: '(', insert: '(', ariaLabel: 'Insert opening parenthesis' },
  { label: ')', insert: ')', ariaLabel: 'Insert closing parenthesis' },
  { label: ';', insert: ';', ariaLabel: 'Insert semicolon' },
  { label: '=', insert: '=', ariaLabel: 'Insert equals sign' },
  { label: '"', insert: '"', ariaLabel: 'Insert double quote' },
  { label: "'", insert: "'", ariaLabel: 'Insert single quote' },
  { label: '`', insert: '`', ariaLabel: 'Insert backtick' },
];

/**
 * Auxiliary input tray rendered directly above the software keyboard.
 *
 * Mobile keyboards omit the keys developers need most (brackets, indentation,
 * undo), so they are surfaced here as 44px-tall physical buttons rather than
 * relying on long-press or hover affordances that touch cannot express.
 */
function MobileKeyboardBarComponent({
  visible,
  indentSize = 2,
  onInsert,
  onCommand,
  disabled = false,
}: MobileKeyboardBarProps) {
  if (!visible) return null;

  return (
    <div
      className="mobile-keyboard-bar activity-bar-mobile"
      role="toolbar"
      aria-label="Editor quick input"
      data-testid="mobile-keyboard-bar"
    >
      <button
        type="button"
        aria-label="Indent"
        data-testid="keyboard-bar-indent"
        disabled={disabled}
        onClick={() => onCommand('indent')}
        className="!min-w-11 disabled:opacity-40"
      >
        <IndentIncrease size={16} aria-hidden="true" />
      </button>

      <button
        type="button"
        aria-label="Outdent"
        data-testid="keyboard-bar-outdent"
        disabled={disabled}
        onClick={() => onCommand('outdent')}
        className="!min-w-11 disabled:opacity-40"
      >
        <IndentDecrease size={16} aria-hidden="true" />
      </button>

      {INSERT_KEYS.map((key) => (
        <button
          key={key.insert}
          type="button"
          aria-label={key.ariaLabel}
          data-testid={`keyboard-bar-insert-${key.insert}`}
          data-insert={key.insert}
          disabled={disabled}
          onClick={() => onInsert(key.insert)}
          className="disabled:opacity-40"
        >
          {key.label}
        </button>
      ))}

      <button
        type="button"
        aria-label="Undo"
        data-testid="keyboard-bar-undo"
        disabled={disabled}
        onClick={() => onCommand('undo')}
        className="!min-w-11 disabled:opacity-40"
      >
        <Undo2 size={16} aria-hidden="true" />
      </button>

      <button
        type="button"
        aria-label="Redo"
        data-testid="keyboard-bar-redo"
        disabled={disabled}
        onClick={() => onCommand('redo')}
        className="!min-w-11 disabled:opacity-40"
      >
        <Redo2 size={16} aria-hidden="true" />
      </button>

      <span className="ml-auto hidden shrink-0 px-2 text-[10px] text-vscode-description-fg md:inline">
        indent = {indentSize} spaces
      </span>
    </div>
  );
}

export const MobileKeyboardBar = memo(MobileKeyboardBarComponent);
MobileKeyboardBar.displayName = 'MobileKeyboardBar';