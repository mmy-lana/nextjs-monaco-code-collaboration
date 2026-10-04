'use client';

import { memo } from 'react';
import {
  Files,
  Search,
  Settings,
  Users,
} from 'lucide-react';
import { Tooltip } from '@/components/primitives/Tooltip';
import type { ActivityBarTab } from '@/types/editor';

export interface ActivityBarProps {
  activeTab: ActivityBarTab;
  onSelect: (tab: ActivityBarTab) => void;
  /** Renders as the bottom navigation bar below the mobile breakpoint. */
  isMobile: boolean;
  /** Peer count badge on the collaboration icon. */
  peerCount: number;
  /** Uppercase glyph used for each entry (mirrors the VS Code icon set). */
  labels?: Partial<Record<ActivityBarTab, string>>;
}

const ENTRIES: { id: ActivityBarTab; label: string; glyph: string; Icon: typeof Files }[] = [
  { id: 'explorer', label: 'Explorer', glyph: 'EX', Icon: Files },
  { id: 'search', label: 'Search', glyph: 'SR', Icon: Search },
  { id: 'collaboration', label: 'Collaboration', glyph: 'CO', Icon: Users },
  { id: 'settings', label: 'Settings', glyph: 'ST', Icon: Settings },
];

function ActivityBarComponent({
  activeTab,
  onSelect,
  isMobile,
  peerCount,
  labels,
}: ActivityBarProps) {
  return (
    <nav
      aria-label="Primary"
      data-testid="activity-bar"
      data-layout={isMobile ? 'bottom' : 'left'}
      className={
        isMobile
          ? 'activity-bar-mobile flex w-full shrink-0 items-stretch justify-around border-t border-vscode-border bg-vscode-activitybar-bg'
          : 'flex w-[var(--activitybar-width)] shrink-0 flex-col items-center gap-1 bg-vscode-activitybar-bg py-2'
      }
    >
      {ENTRIES.map(({ id, label, glyph, Icon }) => {
        const isActive = activeTab === id;

        return (
          <Tooltip
            key={id}
            content={`${labels?.[id] ?? label}${id === 'collaboration' && peerCount > 0 ? ` (${peerCount} peer${peerCount === 1 ? '' : 's'})` : ''}`}
            placement={isMobile ? 'top' : 'right'}
            disabled={isMobile}
          >
            <button
              type="button"
              data-testid={`activity-bar-${id}`}
              aria-label={label}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(id)}
              className={`relative flex items-center justify-center transition-colors ${
                isMobile ? 'h-14 min-w-16 flex-1 flex-col gap-0.5' : 'h-12 w-12'
              } ${
                isActive
                  ? 'text-white'
                  : 'text-[#c5c5c5] hover:bg-vscode-button-hover hover:text-white'
              }`}
            >
              {!isMobile && isActive ? (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 bg-white"
                />
              ) : null}
              {isMobile && isActive ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-4 top-0 h-0.5 bg-vscode-accent"
                />
              ) : null}

              <Icon size={isMobile ? 18 : 20} aria-hidden="true" />
              <span className="text-[9px] font-medium leading-none tracking-wide">
                {glyph}
              </span>

              {id === 'collaboration' && peerCount > 0 ? (
                <span
                  data-testid="activity-bar-peer-badge"
                  className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-vscode-accent px-1 text-[9px] font-semibold text-white"
                >
                  {peerCount}
                </span>
              ) : null}
            </button>
          </Tooltip>
        );
      })}
    </nav>
  );
}

export const ActivityBar = memo(ActivityBarComponent);
ActivityBar.displayName = 'ActivityBar';