'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { twMerge } from 'tailwind-merge';

export type DropdownMenuAlign = 'start' | 'center' | 'end';

export interface DropdownMenuItem {
  id: string;
  label: string;
  /** Keyboard hint rendered right-aligned, e.g. `⌘K`. */
  shortcut?: string;
  icon?: ReactNode;
  /** Renders a separator above the item. */
  separatorBefore?: boolean;
  disabled?: boolean;
  /** Renders the item in the destructive colour. */
  tone?: 'default' | 'danger';
  onSelect: () => void | Promise<void>;
}

export interface DropdownMenuProps {
  /** Trigger content. A full-width button is rendered around it. */
  trigger: ReactNode;
  items: DropdownMenuItem[];
  /** Accessible name for the trigger, required when the trigger is an icon. */
  triggerLabel: string;
  align?: DropdownMenuAlign;
  /** Minimum menu width in pixels. */
  menuWidth?: number;
  disabled?: boolean;
  testId?: string;
}

/**
 * Click-driven context menu.
 *
 * Deliberately not hover-driven: on touch devices there is no hover state, so
 * every action must be reachable through an explicit tap. The menu is portalled
 * to `document.body` so it is never clipped by scrolling panes, and it is
 * repositioned on scroll/resize while open.
 */
export function DropdownMenu({
  trigger,
  items,
  triggerLabel,
  align = 'start',
  menuWidth = 180,
  disabled = false,
  testId,
}: DropdownMenuProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const enabledItems = items.filter((item) => !item.disabled);

  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      setActiveIndex(-1);
      setPosition(null);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [],
  );

  const reposition = useCallback(() => {
    const triggerElement = triggerRef.current;
    if (!triggerElement) return;
    const rect = triggerElement.getBoundingClientRect();
    const width = menuRef.current?.offsetWidth ?? menuWidth;

    let left = rect.left;
    if (align === 'end') left = rect.right - width;
    if (align === 'center') left = rect.left + rect.width / 2 - width / 2;

    // Keep the menu inside the viewport on narrow (mobile) screens.
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));

    const spaceBelow = window.innerHeight - rect.bottom;
    const estimatedHeight = Math.min(enabledItems.length * 30 + 16, 320);
    const openUpwards = spaceBelow < estimatedHeight && rect.top > spaceBelow;
    const top = openUpwards ? Math.max(8, rect.top - estimatedHeight) : rect.bottom;

    setPosition({ top, left });
  }, [align, menuWidth, enabledItems.length]);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || triggerRef.current?.contains(target))) {
        return;
      }
      close(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };

    const handleViewportChange = () => reposition();

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open, close, reposition]);

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (enabledItems.length === 0) return;
      setActiveIndex((current) => {
        const next = current + direction;
        if (next < 0) return enabledItems.length - 1;
        if (next >= enabledItems.length) return 0;
        return next;
      });
    },
    [enabledItems.length],
  );

  const handleMenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveActive(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveActive(-1);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        if (activeIndex < 0) return;
        event.preventDefault();
        const item = enabledItems[activeIndex];
        if (item) void Promise.resolve(item.onSelect()).then(() => close());
      }
    },
    [activeIndex, close, enabledItems, moveActive],
  );

  const handleTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
        setActiveIndex(0);
      }
    },
    [],
  );

  const renderMenu = () => {
    if (!open || position === null) return null;

    const content = (
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-label={triggerLabel}
        tabIndex={-1}
        data-testid={testId ? `${testId}-menu` : undefined}
        onKeyDown={handleMenuKeyDown}
        style={{ top: position.top, left: position.left, minWidth: menuWidth }}
        className="fixed z-[60] overflow-hidden rounded-sm border border-vscode-border bg-vscode-menu-bg py-1 shadow-lg shadow-black/40 focus:outline-none"
      >
        {items.length === 0 ? (
          <p className="px-3 py-2 text-xs text-vscode-description-fg">No actions available</p>
        ) : (
          items.map((item, index) => {
            const enabledIndex = enabledItems.findIndex((candidate) => candidate.id === item.id);
            return (
              <div key={item.id}>
                {item.separatorBefore ? <div className="my-1 h-px bg-vscode-border" role="separator" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  data-testid={testId ? `${testId}-item-${item.id}` : undefined}
                  onClick={() => {
                    if (item.disabled) return;
                    void Promise.resolve(item.onSelect()).then(() => close());
                  }}
                  onMouseEnter={() => setActiveIndex(enabledIndex)}
                  className={twMerge(
                    'flex w-full items-center gap-2 px-3 py-1 text-left text-xs',
                    item.disabled
                      ? 'cursor-not-allowed text-vscode-description-fg opacity-60'
                      : 'cursor-pointer text-vscode-fg hover:bg-vscode-list-hover hover:text-vscode-active-fg',
                    enabledIndex === activeIndex && !item.disabled && 'bg-vscode-list-hover text-vscode-active-fg',
                    item.tone === 'danger' && !item.disabled && 'text-vscode-error-fg',
                  )}
                >
                  {item.icon ? (
                    <span aria-hidden="true" className="flex w-4 shrink-0 justify-center">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.shortcut ? (
                    <span className="shrink-0 text-[10px] text-vscode-description-fg">{item.shortcut}</span>
                  ) : null}
                </button>
              </div>
            );
          })
        )}
      </div>
    );

    return createPortal(content, document.body);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        title={triggerLabel}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
        className="inline-flex select-none items-center"
      >
        {trigger}
      </button>
      {renderMenu()}
    </>
  );
}