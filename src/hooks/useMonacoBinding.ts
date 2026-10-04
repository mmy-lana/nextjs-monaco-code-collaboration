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
import {
  colorFromSeed,
  hashString,
  isValidHexColor,
  sanitizePeerColor,
  sanitizePeerName,
} from '@/utils/colorGenerator';
import type { PeerUser } from '@/types/collaboration';

/** Transaction origin for edits authored locally in Monaco. */
export const MONACO_ORIGIN = 'monaco-input';
/** Transaction origin for edits arriving from a peer. */
export const REMOTE_ORIGIN = 'yjs-remote';

/** Peer labels fade out this long after the cursor stops moving. */
export const CURSOR_LABEL_TTL_MS = 3000;

/**
 * Minimum interval between awareness broadcasts.
 *
 * Cursor movements are broadcast far more often than they can be perceived, so
 * 50ms keeps remote carets smooth while capping the WebRTC data channel.
 */
export const PRESENCE_THROTTLE_MS = 50;

/**
 * Debounce before a remote edit is mirrored into the Dexie snapshot store.
 *
 * Remote edits arrive one CRDT transaction per keystroke. Writing each one
 * would put an IndexedDB transaction in the path of another user's typing; this
 * window collapses a burst into a single write while staying far inside the
 * interval at which a reader could observe a stale snapshot.
 */
export const REMOTE_PERSIST_DEBOUNCE_MS = 400;

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
  /*
   * Second line of defence behind `parsePeerState`: this value is written into
   * a global stylesheet, so it is validated here as well rather than trusted
   * because it "already came through the parser".
   */
  const safeColor = isValidHexColor(color) ? color : colorFromSeed(color);
  const key = safeColor.toLowerCase();
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
    style.appendChild(document.createTextNode(`.${className}{--peer-color:${safeColor};}\n`));
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
  /**
   * Fired when text changed in the CRDT but not in this editor — a peer edit, a
   * snapshot import, or the document being restored from `y-indexeddb`.
   *
   * The file id is passed explicitly rather than left implicit in host state:
   * the call is debounced, so by the time it runs the user may have switched
   * tabs, and an implicitly-current file id would write one file's body over
   * another.
   */
  onRemoteChange?: (fileId: string, value: string) => void;
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
  if (typeof payload.name !== 'string') return null;

  const clientId = typeof payload.clientId === 'number' ? payload.clientId : 0;
  const name = sanitizePeerName(payload.name);
  if (name.length === 0) return null;

  /*
   * The colour is sanitised rather than rejected: a peer with a bogus colour
   * still belongs in the roster, it just gets a deterministic safe one instead
   * of the ability to write into this document's stylesheet.
   */
  const color = sanitizePeerColor(payload.color, `peer-${clientId}-${name}`);

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
    clientId,
    name,
    color,
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
  onRemoteChange,
}: UseMonacoBindingOptions): void {
  const decorationsRef = useRef<string[]>([]);
  const isApplyingRemoteRef = useRef(false);
  const localChangeRef = useRef(onLocalChange);
  localChangeRef.current = onLocalChange;
  const remoteChangeRef = useRef(onRemoteChange);
  remoteChangeRef.current = onRemoteChange;

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

    /*
     * Mirror for text that changed in the CRDT but not in this editor.
     *
     * `handleYTextChange` runs with `isApplyingRemoteRef` set, so the model
     * listener below deliberately skips these edits — which is what stops the
     * edit loop, and also meant the Dexie snapshot was only ever written when the
     * *local* user typed. A peer's keystrokes reached the CRDT and
     * `y-indexeddb` but not Dexie, so a reload hydrated a stale snapshot. This
     * path closes that gap: identical suppression, opposite destination.
     *
     * `lastMirrored` starts at the current text so the binding's own
     * reconciliation (which uses MONACO_ORIGIN and therefore never reaches the
     * remote handler) cannot trigger a redundant write.
     */
    let mirroredText = yText.toString();
    let pendingMirror: { fileId: string; value: string } | null = null;
    let mirrorTimer: ReturnType<typeof setTimeout> | null = null;

    const flushMirror = (): void => {
      if (mirrorTimer !== null) {
        clearTimeout(mirrorTimer);
        mirrorTimer = null;
      }
      if (!pendingMirror) return;

      const { fileId: pendingFileId, value } = pendingMirror;
      pendingMirror = null;
      remoteChangeRef.current?.(pendingFileId, value);
    };

    const scheduleMirror = (): void => {
      const next = yText.toString();
      if (next === mirroredText) return;

      mirroredText = next;
      pendingMirror = { fileId, value: next };
      if (mirrorTimer !== null) clearTimeout(mirrorTimer);
      mirrorTimer = setTimeout(flushMirror, REMOTE_PERSIST_DEBOUNCE_MS);
    };

    /*
     * Reconcile the model and the CRDT exactly once per binding.
     *
     * Three cases, in priority order:
     *  1. CRDT empty, model has text  -> adopt the model into the CRDT. Wiping
     *     the model here would destroy the file whenever the room is joined
     *     before the persisted body reaches the editor.
     *  2. CRDT empty, model empty, seed text available -> seed from it.
     *  3. Both populated but different -> the CRDT is the shared source of
     *     truth, so replay it into the model.
     */
    const modelText = model.getValue();

    if (yText.length === 0 && modelText.length > 0) {
      doc.transact(() => yText.insert(0, modelText), MONACO_ORIGIN);
    } else if (yText.length === 0 && initialContent.length > 0) {
      doc.transact(() => yText.insert(0, initialContent), MONACO_ORIGIN);
    } else if (modelText !== yText.toString()) {
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

      // The model now mirrors the CRDT; the snapshot store has to follow it.
      scheduleMirror();
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
              hoverMessage: { value: `**${sanitizePeerName(peer.name)}** is editing here` },
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
              hoverMessage: { value: `**${sanitizePeerName(peer.name)}**` },
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
    /*
     * Presence is throttled on two axes: one message per animation frame, and
     * at most one message per PRESENCE_THROTTLE_MS. A 120–144 Hz display fires
     * cursor events faster than any human can perceive, and an unthrottled
     * stream saturates the WebRTC data channel and starves actual document
     * updates on slower links.
     */
    let publishFrame: number | null = null;
    let publishTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPublishedAt = 0;
    let pendingPosition: IPosition | null = null;
    let pendingSelection: ISelection | null = null;

    const flushPresence = (): void => {
      publishFrame = null;
      publishTimer = null;
      if (!pendingPosition) return;

      const position = pendingPosition;
      const selection = pendingSelection;
      lastPublishedAt = Date.now();
      pendingPosition = null;
      pendingSelection = null;

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
        cursor: { line: position.lineNumber, column: position.column },
        selection: selection
          ? {
              startLineNumber: selection.selectionStartLineNumber,
              startColumn: selection.selectionStartColumn,
              endLineNumber: selection.positionLineNumber,
              endColumn: selection.positionColumn,
            }
          : null,
        activeFileId: fileId,
        lastActive: Date.now(),
      });
    };

    const schedulePresence = (position: IPosition, selection: ISelection): void => {
      pendingPosition = position;
      pendingSelection = selection;

      const elapsed = Date.now() - lastPublishedAt;
      if (elapsed >= PRESENCE_THROTTLE_MS) {
        if (publishFrame !== null) cancelAnimationFrame(publishFrame);
        publishFrame = requestAnimationFrame(flushPresence);
        return;
      }

      // Inside the throttle window: keep the newest position and let the timer
      // release it, so the final caret position is never dropped.
      if (publishTimer === null) {
        publishTimer = setTimeout(() => {
          publishTimer = null;
          publishFrame = requestAnimationFrame(flushPresence);
        }, PRESENCE_THROTTLE_MS - elapsed);
      }
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
        if (publishTimer !== null) clearTimeout(publishTimer);
      },
    });

    return () => {
      /*
       * Flushed rather than cancelled: switching away from a file whose text
       * just changed remotely must still persist that text, or the next visit
       * hydrates the snapshot from before the peer edit. The id travels with the
       * payload, so this cannot land on the file the user switched to.
       */
      flushMirror();
      for (const disposable of disposables) disposable.dispose();
      clearRemoteDecorations();
    };
  }, [clearRemoteDecorations, doc, editor, fileId, initialContent, provider]);
}