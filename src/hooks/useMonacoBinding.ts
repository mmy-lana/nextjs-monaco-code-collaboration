'use client';

import { useCallback, useEffect, useRef } from 'react';
import type * as Y from 'yjs';
import type {
  editor as MonacoEditorNamespace,
  IDisposable,
  IPosition,
  ISelection,
} from 'monaco-editor';
import type { WebrtcProvider } from 'y-webrtc';
import { getFileText } from '@/services/yjsProvider';
import { hashString } from '@/utils/colorGenerator';
import type { PeerUser } from '@/types/collaboration';

/** Transaction origin for edits authored locally in Monaco. */
export const MONACO_ORIGIN = 'monaco-input';
/** Transaction origin for edits arriving from a peer. */
export const REMOTE_ORIGIN = 'yjs-remote';

/** Peer labels fade out this long after the cursor stops moving. */
export const CURSOR_LABEL_TTL_MS = 3000;

const PEER_STYLE_ELEMENT_ID = 'y-peer-cursor-styles';
const peerColorClasses = new Map<string, string>();

/**
 * Emits (once per colour) a CSS rule that binds `--peer-color` to a generated
 * class name.
 *
 * Monaco decorations cannot carry inline styles, and a per-peer class would leak
 * unbounded rules into the stylesheet, so one small rule per distinct peer
 * colour is the cheapest correct approach.
 */
export function getPeerColorClass(color: string): string {
  const key = color.trim().toLowerCase();
  const cached = peerColorClasses.get(key);
  if (cached) return cached;

  const className = `yPeer-${hashString(key).toString(36)}`;
  peerColorClasses.set(key, className);

  if (typeof document !== 'undefined' && document.head) {
    let style = document.getElementById(PEER_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = PEER_STYLE_ELEMENT_ID;
      document.head.appendChild(style);
    }
    style.appendChild(
      document.createTextNode(`.${className}{--peer-color:${color};}\n`),
    );
  }

  return className;
}

export interface UseMonacoBindingOptions {
  editor: MonacoEditorNamespace.IStandaloneCodeEditor | null;
  doc: Y.Doc | null;
  fileId: string | null;
  provider: WebrtcProvider | null;
  /** Optional seed text used only when both the model and CRDT are empty. */
  initialContent?: string;
  /** Fired on every local edit so the caller can debounce persistence. */
  onLocalChange?: (value: string) => void;
}

/**
 * Parses an untrusted awareness payload into a `PeerUser`.
 *
 * Awareness state crosses the network, so every field is validated before it is
 * allowed anywhere near `deltaDecorations` — a malformed line number would
 * otherwise throw inside Monaco and tear down the editor.
 */
export function parsePeerState(raw: unknown): PeerUser | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Record<string, unknown>;
  const user = candidate.user;
  if (!user || typeof user !== 'object') return null;

  const payload = user as Record<string, unknown>;
  if (typeof payload.name !== 'string' || typeof payload.color !== 'string') return null;

  const readPosition = (value: unknown): { line: number; column: number } | null => {
    if (!value || typeof value !== 'object') return null;
    const position = value as Record<string, unknown>;
    if (typeof position.line !== 'number' || typeof position.column !== 'number') return null;
    if (!Number.isFinite(position.line) || !Number.isFinite(position.column)) return null;
    return { line: Math.max(1, Math.trunc(position.line)), column: Math.max(1, Math.trunc(position.column)) };
  };

  const readSelection = (value: unknown): PeerUser['selection'] => {
    if (!value || typeof value !== 'object') return null;
    const range = value as Record<string, unknown>;
    const keys = ['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn'] as const;
    if (!keys.every((key) => typeof range[key] === 'number' && Number.isFinite(range[key]))) {
      return null;
    }
    return {
      startLineNumber: range.startLineNumber as number,
      startColumn: range.startColumn as number,
      endLineNumber: range.endLineNumber as number,
      endColumn: range.endColumn as number,
    };
  };

  return {
    clientId: typeof payload.clientId === 'number' ? payload.clientId : 0,
    name: payload.name,
    color: payload.color,
    cursor: readPosition(payload.cursor),
    selection: readSelection(payload.selection),
    activeFileId: typeof payload.activeFileId === 'string' ? payload.activeFileId : null,
    lastActive: typeof payload.lastActive === 'number' ? payload.lastActive : Date.now(),
    isHost: Boolean(payload.isHost),
  };
}

/**
 * Two-way binding between a Monaco model and a `Y.Text`.
 *
 * Local edits become CRDT operations tagged with `MONACO_ORIGIN`; remote
 * operations are replayed with `editor.executeEdits`. The origin guard on both
 * sides is what stops an infinite edit loop, and `executeEdits` (rather than
 * `setValue`) is what keeps undo history, selection and folded regions intact.
 */
export function useMonacoBinding({
  editor,
  doc,
  fileId,
  provider,
  initialContent = '',
  onLocalChange,
}: UseMonacoBindingOptions): void {
  const decorationsRef = useRef<string[]>([]);
  const isApplyingRemoteRef = useRef(false);
  const localChangeRef = useRef(onLocalChange);
  localChangeRef.current = onLocalChange;

  const clearRemoteDecorations = useCallback(() => {
    if (!editor) return;
    if (decorationsRef.current.length > 0) {
      editor.deltaDecorations(decorationsRef.current, []);
      decorationsRef.current = [];
    }
  }, [editor]);

  useEffect(() => {
    if (!editor || !doc || !fileId || !provider) return undefined;

    const model = editor.getModel();
    if (!model) return undefined;

    // One `Y.Text` per file inside the shared `files` map: peers editing
    // different files never contend on the same CRDT node.
    const yText = getFileText(doc, fileId);
    const disposables: IDisposable[] = [];

    // ── initial hydration (once per binding) ──────────────────────────────────
    if (yText.length === 0 && model.getValue().length === 0 && initialContent.length > 0) {
      doc.transact(() => yText.insert(0, initialContent), MONACO_ORIGIN);
    }
    if (model.getValue() !== yText.toString()) {
      isApplyingRemoteRef.current = true;
      try {
        editor.executeEdits(REMOTE_ORIGIN, [
          {
            range: model.getFullModelRange(),
            text: yText.toString(),
            forceMoveMarkers: true,
          },
        ]);
      } finally {
        isApplyingRemoteRef.current = false;
      }
    }

    // ── Monaco → Yjs ──────────────────────────────────────────────────────────
    disposables.push(
      editor.onDidChangeModelContent((event) => {
        if (isApplyingRemoteRef.current) return;

        doc.transact(() => {
          // Changes are applied back-to-front so earlier offsets stay valid.
          const ordered = [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
          for (const change of ordered) {
            if (change.rangeLength > 0) {
              yText.delete(change.rangeOffset, change.rangeLength);
            }
            if (change.text.length > 0) {
              yText.insert(change.rangeOffset, change.text);
            }
          }
        }, MONACO_ORIGIN);

        localChangeRef.current?.(model.getValue());
      }),
    );

    // ── Yjs → Monaco ──────────────────────────────────────────────────────────
    const handleYTextChange = (event: Y.YTextEvent): void => {
      if (event.transaction.origin === MONACO_ORIGIN) return;

      isApplyingRemoteRef.current = true;
      try {
        const edits: MonacoEditorNamespace.IIdentifiedSingleEditOperation[] = [];
        let index = 0;

        for (const delta of event.delta) {
          if (delta.retain !== undefined) {
            index += delta.retain;
          } else if (delta.delete !== undefined) {
            const start = model.getPositionAt(index);
            const end = model.getPositionAt(index + delta.delete);
            edits.push({
              range: {
                startLineNumber: start.lineNumber,
                startColumn: start.column,
                endLineNumber: end.lineNumber,
                endColumn: end.column,
              },
              text: '',
              forceMoveMarkers: true,
            });
            index += delta.delete;
          } else if (typeof delta.insert === 'string') {
            const position = model.getPositionAt(index);
            edits.push({
              range: {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              },
              text: delta.insert,
              forceMoveMarkers: true,
            });
            index += delta.insert.length;
          }
        }

        if (edits.length > 0) editor.executeEdits(REMOTE_ORIGIN, edits);
      } finally {
        isApplyingRemoteRef.current = false;
      }
    };

    yText.observe(handleYTextChange);
    disposables.push({ dispose: () => yText.unobserve(handleYTextChange) });

    // ── remote cursors and selections ─────────────────────────────────────────
    const applyRemoteDecorations = (): void => {
      const states = provider.awareness.getStates();
      const decorations: MonacoEditorNamespace.IModelDeltaDecoration[] = [];
      const now = Date.now();

      states.forEach((rawState, clientId) => {
        if (clientId === doc.clientID) return;

        const peer = parsePeerState(rawState);
        if (!peer || peer.activeFileId !== fileId) return;

        const peerClass = getPeerColorClass(peer.color);

        if (peer.selection) {
          decorations.push({
            range: {
              startLineNumber: Math.min(peer.selection.startLineNumber, model.getLineCount()),
              startColumn: peer.selection.startColumn,
              endLineNumber: Math.min(peer.selection.endLineNumber, model.getLineCount()),
              endColumn: peer.selection.endColumn,
            },
            options: {
              inlineClassName: `yRemoteSelection ${peerClass}`,
              hoverMessage: { value: `**${peer.name}** is editing here` },
              stickiness: 1,
            },
          });
        }

        if (peer.cursor) {
          const line = Math.min(Math.max(peer.cursor.line, 1), model.getLineCount());
          const column = peer.cursor.column;
          // The label fades after a few seconds of inactivity.
          const labelVisible = now - peer.lastActive < CURSOR_LABEL_TTL_MS;

          decorations.push({
            range: {
              startLineNumber: line,
              startColumn: column,
              endLineNumber: line,
              endColumn: Math.min(column + 1, model.getLineMaxColumn(line)),
            },
            options: {
              className: `yRemoteCursor ${peerClass}`,
              beforeContentClassName: `yRemoteCursor ${peerClass}${labelVisible ? ' yRemoteCursor-active' : ''}`,
              hoverMessage: { value: `**${peer.name}**` },
              stickiness: 1,
            },
          });
        }
      });

      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
    };

    const handleAwarenessChange = (): void => applyRemoteDecorations();

    provider.awareness.on('change', handleAwarenessChange);
    applyRemoteDecorations();

    // ── publish local cursor / selection ──────────────────────────────────────
    let publishFrame: number | null = null;
    let pendingPosition: IPosition | null = null;
    let pendingSelection: ISelection | null = null;

    const flushPresence = (): void => {
      publishFrame = null;
      if (!pendingPosition) return;

      const current = parsePeerState(provider.awareness.getLocalState());
      const payload = current ?? {
        clientId: doc.clientID,
        name: 'Peer',
        color: '#007acc',
        cursor: null,
        selection: null,
        activeFileId: fileId,
        lastActive: Date.now(),
        isHost: false,
      };

      provider.awareness.setLocalStateField('user', {
        ...payload,
        cursor: { line: pendingPosition.lineNumber, column: pendingPosition.column },
        selection: pendingSelection
          ? {
              startLineNumber: pendingSelection.selectionStartLineNumber,
              startColumn: pendingSelection.selectionStartColumn,
              endLineNumber: pendingSelection.positionLineNumber,
              endColumn: pendingSelection.positionColumn,
            }
          : null,
        activeFileId: fileId,
        lastActive: Date.now(),
      });

      pendingPosition = null;
      pendingSelection = null;
    };

    // Cursor updates are coalesced to one awareness message per frame; sending
    // every keystroke would saturate the WebRTC data channel.
    const schedulePresence = (position: IPosition, selection: ISelection): void => {
      pendingPosition = position;
      pendingSelection = selection;
      if (publishFrame === null) publishFrame = requestAnimationFrame(flushPresence);
    };

    disposables.push(
      editor.onDidChangeCursorSelection((event) =>
        schedulePresence(
          {
            lineNumber: event.selection.positionLineNumber,
            column: event.selection.positionColumn,
          },
          event.selection,
        ),
      ),
    );

    disposables.push({
      dispose: () => {
        if (publishFrame !== null) cancelAnimationFrame(publishFrame);
      },
    });

    return () => {
      for (const disposable of disposables) disposable.dispose();
      clearRemoteDecorations();
    };
  }, [clearRemoteDecorations, doc, editor, fileId, initialContent, provider]);
}