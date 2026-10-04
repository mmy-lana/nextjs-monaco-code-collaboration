'use client';

import type { ReactNode } from 'react';
import { ActivityBar } from '@/components/layout/ActivityBar';
import { PrimarySidebar } from '@/components/layout/PrimarySidebar';
import { EditorArea, PanelSplitter, SidebarSplitter } from '@/components/layout/EditorArea';
import { BottomPanel } from '@/components/layout/BottomPanel';
import { StatusBar } from '@/components/layout/StatusBar';
import { MobileKeyboardBar, type KeyboardBarCommand } from '@/components/layout/MobileKeyboardBar';
import type { ActivityBarTab, BottomPanelTab, DiagnosticItem, EditorTab } from '@/types/editor';
import type { ConnectionState, LanLogEntry, LanMeshStats, TransportMode } from '@/types/collaboration';

export interface VSCodeShellProps {
  activityTab: ActivityBarTab;
  onActivityTabChange: (tab: ActivityBarTab) => void;

  sidebarOpen: boolean;
  onSidebarToggle: () => void;
  sidebarContent: ReactNode;
  sidebarWidth: number;
  onSidebarResize: (width: number) => void;

  tabs: readonly EditorTab[];
  activeFileId: string | null;
  activePath: string;
  siblings: readonly string[];
  onSelectTab: (fileId: string) => void;
  onCloseTab: (fileId: string) => void;
  onReorderTabs?: (fromIndex: number, toIndex: number) => void;
  onNavigatePath: (path: string) => void;
  editor: ReactNode;

  panelOpen: boolean;
  panelTab: BottomPanelTab;
  panelHeight: number;
  onPanelTabChange: (tab: BottomPanelTab) => void;
  onPanelToggle: () => void;
  onPanelClose: () => void;
  onPanelResize: (height: number) => void;
  output: readonly string[];
  diagnostics: readonly DiagnosticItem[];
  lanLogs: readonly LanLogEntry[];
  lanStats: LanMeshStats | null;
  onClearLanLogs: () => void;
  onExportLanLogs: () => void;
  onOpenDiagnostic: (diagnostic: DiagnosticItem) => void;

  connectionState: ConnectionState;
  transportMode: TransportMode;
  peerCount: number;
  language: string | null;
  cursor: { line: number; column: number; selectionLength: number } | null;
  workspaceName: string;
  roomId: string;
  problemsCount: number;

  isMobile: boolean;
  isTablet: boolean;
  /** Visual viewport height, used for the panel splitter's maximum. */
  viewportHeight: number;
  keyboardBarVisible: boolean;
  onKeyboardInsert: (text: string) => void;
  onKeyboardCommand: (command: KeyboardBarCommand) => void;
  keyboardBarDisabled?: boolean;
}

/**
 * The VS Code layout coordinator.
 *
 * Everything is a CSS grid/flex composition of five regions — activity bar,
 * sidebar, editor, bottom panel and status bar — so the same markup serves the
 * desktop three-pane layout and the mobile drawer + bottom-navigation variant.
 * The shell owns geometry only; all data flows in as props.
 */
export function VSCodeShell(props: VSCodeShellProps) {
  const {
    activityTab,
    onActivityTabChange,
    sidebarOpen,
    onSidebarToggle,
    sidebarContent,
    sidebarWidth,
    onSidebarResize,
    tabs,
    activeFileId,
    activePath,
    siblings,
    onSelectTab,
    onCloseTab,
    onReorderTabs,
    onNavigatePath,
    editor,
    panelOpen,
    panelTab,
    panelHeight,
    onPanelTabChange,
    onPanelToggle,
    onPanelClose,
    onPanelResize,
    output,
    diagnostics,
    lanLogs,
    lanStats,
    onClearLanLogs,
    onExportLanLogs,
    onOpenDiagnostic,
    connectionState,
    transportMode,
    peerCount,
    language,
    cursor,
    workspaceName,
    roomId,
    problemsCount,
    isMobile,
    isTablet,
    viewportHeight,
    keyboardBarVisible,
    onKeyboardInsert,
    onKeyboardCommand,
    keyboardBarDisabled = false,
  } = props;

  // Tablet keeps the sidebar docked but collapses it by default; mobile always
  // renders it as an overlay drawer.
  const showDockedSidebar = !isMobile && sidebarOpen;
  const showDrawer = isMobile && sidebarOpen;

  return (
    <div
      data-testid="vscode-shell"
      data-breakpoint={isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop'}
      className="relative flex min-h-0 w-full flex-col overflow-hidden"
      style={{ height: 'calc(var(--vh, 1vh) * 100)' }}
    >
      <div className="flex min-h-0 flex-1">
        {!isMobile ? <ActivityBar activeTab={activityTab} onSelect={onActivityTabChange} isMobile={false} peerCount={peerCount} /> : null}

        {showDockedSidebar ? (
          <>
            <PrimarySidebar
              activeTab={activityTab}
              isMobile={false}
              onCollapse={onSidebarToggle}
            >
              {sidebarContent}
            </PrimarySidebar>
            <SidebarSplitter size={sidebarWidth} onResize={onSidebarResize} />
          </>
        ) : null}

        <EditorArea
          tabs={tabs}
          activeFileId={activeFileId}
          activePath={activePath}
          siblings={siblings}
          sidebarVisible={sidebarOpen}
          isMobile={isMobile}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onReorderTabs={onReorderTabs}
          onToggleSidebar={onSidebarToggle}
          onNavigatePath={onNavigatePath}
        >
          {editor}
        </EditorArea>
      </div>

      {panelOpen && !isMobile ? (
        <PanelSplitter
          size={panelHeight}
          maxSize={Math.max(200, Math.round(viewportHeight * 0.7))}
          onResize={onPanelResize}
        />
      ) : null}

      <BottomPanel
        open={panelOpen}
        activeTab={panelTab}
        onActiveTabChange={onPanelTabChange}
        onToggle={onPanelToggle}
        onClose={onPanelClose}
        height={panelHeight}
        output={output}
        diagnostics={diagnostics}
        lanLogs={lanLogs}
        lanStats={lanStats}
        onClearLanLogs={onClearLanLogs}
        onExportLanLogs={onExportLanLogs}
        isMobile={isMobile}
        onOpenDiagnostic={onOpenDiagnostic}
      />

      <StatusBar
        isMobile={isMobile}
        connectionState={connectionState}
        transportMode={transportMode}
        peerCount={peerCount}
        language={language}
        cursor={cursor}
        workspaceName={workspaceName}
        roomId={roomId}
        problemsCount={problemsCount}
        onTogglePanel={onPanelToggle}
        onOpenCollaboration={() => onActivityTabChange('collaboration')}
      />

      <MobileKeyboardBar
        visible={keyboardBarVisible}
        onInsert={onKeyboardInsert}
        onCommand={onKeyboardCommand}
        disabled={keyboardBarDisabled}
      />

      {/*
       * Mobile chrome collision.

       * The accessory bar and the bottom navigation both occupy the space the
       * software keyboard has just freed up. On a 360–430px screen rendering
       * both squeezes the editor below a usable height and buries the code
       * behind chrome, so while the keyboard is open the navigation yields and
       * the tray that the thumb is actually typing into keeps its space.
       */}
      {isMobile && !keyboardBarVisible ? (
        <ActivityBar
          activeTab={activityTab}
          onSelect={onActivityTabChange}
          isMobile
          peerCount={peerCount}
        />
      ) : null}

      {showDrawer ? (
        <PrimarySidebar activeTab={activityTab} isMobile onCollapse={onSidebarToggle}>
          {sidebarContent}
        </PrimarySidebar>
      ) : null}
    </div>
  );
}