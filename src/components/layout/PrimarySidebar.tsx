'use client';

import { memo } from 'react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ActivityBarTab } from '@/types/editor';

export interface PrimarySidebarProps {
  activeTab: ActivityBarTab;
  isMobile: boolean;
  /** Sidebar content for the selected activity. */
  children: ReactNode;
  /** Desktop: collapse the panel. Mobile: dismiss the drawer. */
  onCollapse: () => void;
  /** Heading rendered above the content. */
  title?: string;
}

/**
 * Collapsible left panel (desktop) or slide-over drawer (mobile).
 *
 * Below the 768px breakpoint the panel overlays the editor instead of pushing
 * it, so the code stays readable on a phone; the backdrop dismisses it, matching
 * every other modal surface in the app.
 */
function PrimarySidebarComponent({
  activeTab,
  isMobile,
  children,
  onCollapse,
  title,
}: PrimarySidebarProps) {
  const heading =
    title ??
    (activeTab === 'explorer'
      ? 'Explorer'
      : activeTab === 'search'
        ? 'Search'
        : activeTab === 'collaboration'
          ? 'Collaboration'
          : 'Settings');

  if (isMobile) {
    return (
      <>
        <div
          className="drawer-overlay"
          data-testid="sidebar-backdrop"
          onClick={onCollapse}
          aria-hidden="true"
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label={`${heading} drawer`}
          data-testid="primary-sidebar"
          data-layout="drawer"
          style={{ width: 'min(320px, 85vw)' }}
          className="drawer-enter drawer-open absolute inset-y-0 left-0 z-50 flex flex-col border-r border-vscode-border bg-vscode-sidebar-bg"
        >
          <header className="flex shrink-0 items-center justify-between border-b border-vscode-border px-3 py-2">
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-vscode-description-fg">
              {heading}
            </h2>
            <button
              type="button"
              aria-label="Close sidebar"
              data-testid="sidebar-close"
              onClick={onCollapse}
              className="flex h-9 w-9 items-center justify-center rounded-sm text-vscode-description-fg hover:bg-vscode-button-hover hover:text-vscode-active-fg"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </aside>
      </>
    );
  }

  return (
    <aside
      aria-label={heading}
      data-testid="primary-sidebar"
      data-layout="panel"
      style={{ width: 'var(--sidebar-width)' }}
      className="flex shrink-0 flex-col border-r border-vscode-border bg-vscode-sidebar-bg"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-vscode-border px-3 py-1.5">
        <h2 className="truncate text-[11px] font-medium uppercase tracking-wide text-vscode-description-fg">
          {heading}
        </h2>
        <button
          type="button"
          aria-label="Collapse sidebar"
          data-testid="sidebar-collapse"
          onClick={onCollapse}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-vscode-description-fg hover:bg-vscode-button-hover hover:text-vscode-active-fg"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </aside>
  );
}

export const PrimarySidebar = memo(PrimarySidebarComponent);
PrimarySidebar.displayName = 'PrimarySidebar';