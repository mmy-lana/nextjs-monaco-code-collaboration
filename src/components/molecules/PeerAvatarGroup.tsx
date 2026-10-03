'use client';

import { memo, useMemo } from 'react';
import { Tooltip } from '@/components/primitives/Tooltip';
import { generateInitials, getContrastColor, hexToRgba } from '@/utils/colorGenerator';
import type { PeerUser } from '@/types/collaboration';

export interface PeerAvatarGroupProps {
  /** Remote peers only; the local user is rendered separately by the shell. */
  peers: readonly PeerUser[];
  /** Awaiting-awareness peers (connected but not yet identified). */
  pendingCount?: number;
  /** Avatars shown before the "+N" overflow chip. */
  max?: number;
  onSelectPeer?: (peer: PeerUser) => void;
}

/** Peers idle longer than this are rendered faded. */
const IDLE_THRESHOLD_MS = 60_000;

function PeerAvatarGroupComponent({
  peers,
  pendingCount = 0,
  max = 5,
  onSelectPeer,
}: PeerAvatarGroupProps) {
  const now = Date.now();

  const { visible, overflow } = useMemo(() => {
    const sorted = [...peers].sort((a, b) => b.lastActive - a.lastActive);
    return { visible: sorted.slice(0, max), overflow: Math.max(0, sorted.length - max) };
  }, [max, peers]);

  if (peers.length === 0 && pendingCount === 0) {
    return (
      <p className="text-[11px] text-vscode-description-fg" data-testid="peer-avatar-empty">
        No peers connected yet
      </p>
    );
  }

  return (
    <ul className="flex flex-wrap items-center gap-1.5" data-testid="peer-avatar-group">
      {visible.map((peer) => {
        const idle = now - peer.lastActive > IDLE_THRESHOLD_MS;
        const label = peer.isHost ? `${peer.name} (host)` : peer.name;

        return (
          <li key={peer.clientId}>
            <Tooltip content={`${label} · cursor ${peer.cursor?.line ?? 0}:${peer.cursor?.column ?? 0}`}>
              <button
                type="button"
                data-testid={`peer-avatar-${peer.clientId}`}
                aria-label={`Peer ${label}`}
                onClick={() => onSelectPeer?.(peer)}
                className="flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-semibold transition-transform hover:scale-105"
                style={{
                  backgroundColor: hexToRgba(peer.color, 0.25),
                  borderColor: peer.color,
                  color: getContrastColor(peer.color),
                  opacity: idle ? 0.55 : 1,
                }}
              >
                {generateInitials(peer.name)}
              </button>
            </Tooltip>
          </li>
        );
      })}

      {pendingCount > 0 ? (
        <li
          aria-label={`${pendingCount} peer(s) connecting`}
          data-testid="peer-avatar-pending"
          className="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-vscode-description-fg text-[10px] text-vscode-description-fg"
        >
          …
        </li>
      ) : null}

      {overflow > 0 ? (
        <li
          data-testid="peer-avatar-overflow"
          className="flex h-7 min-w-7 items-center justify-center rounded-full bg-vscode-badge-bg px-1.5 text-[10px] text-vscode-fg"
        >
          +{overflow}
        </li>
      ) : null}
    </ul>
  );
}

export const PeerAvatarGroup = memo(PeerAvatarGroupComponent);
PeerAvatarGroup.displayName = 'PeerAvatarGroup';