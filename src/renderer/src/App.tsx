import React, { useEffect } from 'react'
import { useAppStore } from '@renderer/stores/appStore'
import { LeftSidebar } from '@renderer/components/sidebar/LeftSidebar'
import { CenterColumn } from '@renderer/components/chat/CenterColumn'
import { RightPanel } from '@renderer/components/panel/RightPanel'
import { SelectionToolbar } from '@renderer/components/chat/SelectionToolbar'
import { MarkCard } from '@renderer/components/chat/MarkCard'
import { WindowControls } from '@renderer/components/common/WindowControls'
import { isWindows } from '@renderer/lib/platform'

const SettingsView = React.lazy(() => import('@renderer/components/settings/SettingsView').then((m) => ({ default: m.SettingsView })))
const ProjectSettingsView = React.lazy(() => import('@renderer/components/settings/ProjectSettingsView').then((m) => ({ default: m.ProjectSettingsView })))
const Onboarding = React.lazy(() => import('@renderer/components/onboarding/Onboarding').then((m) => ({ default: m.Onboarding })))
const SearchDialog = React.lazy(() => import('@renderer/components/search/SearchDialog').then((m) => ({ default: m.SearchDialog })))

export const App: React.FC = () => {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const rightPanelWidth = useAppStore((s) => s.rightPanelWidth)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const noteExpandedToCenter = useAppStore((s) => s.noteExpandedToCenter)
  const onboardingOpen = useAppStore((s) => s.onboardingOpen)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const projectSettingsOpen = useAppStore((s) => s.projectSettingsId !== null)
  const closeProjectSettings = useAppStore((s) => s.closeProjectSettings)

  const toggleLeftSidebar = useAppStore((s) => s.toggleLeftSidebar)
  const setLeftSidebarAutoCollapse = useAppStore(
    (s) => s.setLeftSidebarAutoCollapse
  )
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel)
  const closeRightPanel = useAppStore((s) => s.closeRightPanel)
  const startNewSession = useAppStore((s) => s.startNewSession)
  const searchOpen = useAppStore((s) => s.searchOpen)
  const setSearchOpen = useAppStore((s) => s.setSearchOpen)
  const increaseFontSize = useAppStore((s) => s.increaseFontSize)
  const decreaseFontSize = useAppStore((s) => s.decreaseFontSize)
  const resetFontSize = useAppStore((s) => s.resetFontSize)

  // Auto-collapse left sidebar when window gets narrow
  useEffect(() => {
    const evaluateWidth = (): void => {
      const neededWidth = rightPanelOpen ? 240 + 480 + rightPanelWidth : 900
      const shouldCollapse = window.innerWidth < neededWidth
      setLeftSidebarAutoCollapse(shouldCollapse)
    }

    evaluateWidth()
    window.addEventListener('resize', evaluateWidth)
    return () => window.removeEventListener('resize', evaluateWidth)
  }, [rightPanelOpen, rightPanelWidth, setLeftSidebarAutoCollapse])

  // Keyboard shortcuts: ⌘\, ⌘J, ⌘N, ⌘K, Esc
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const isMod = e.metaKey || e.ctrlKey
      const conversationVisible = !settingsOpen && !projectSettingsOpen && !onboardingOpen

      // Settings fields save on blur, and these keys unmount the page without one.
      if ((settingsOpen || projectSettingsOpen) && (e.key === 'Escape' || (isMod && e.key.toLowerCase() === 'n'))) {
        ;(document.activeElement as HTMLElement | null)?.blur()
      }

      if (conversationVisible && isMod && e.key === '\\') {
        e.preventDefault()
        toggleLeftSidebar()
        return
      }

      if (conversationVisible && isMod && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        toggleRightPanel()
        return
      }

      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(!searchOpen)
        return
      }

      if (e.key === 'Escape' && searchOpen) {
        e.preventDefault()
        setSearchOpen(false)
        return
      }

      if (isMod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        increaseFontSize()
        return
      }

      if (isMod && (e.key === '-' || e.key === '_')) {
        e.preventDefault()
        decreaseFontSize()
        return
      }

      if (isMod && e.key === '0') {
        e.preventDefault()
        resetFontSize()
        return
      }

      if (isMod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        startNewSession()
        return
      }

      if (e.key === 'Escape' && settingsOpen) {
        e.preventDefault()
        closeSettings()
        return
      }

      if (e.key === 'Escape' && projectSettingsOpen) {
        e.preventDefault()
        closeProjectSettings()
        return
      }

      if (conversationVisible && e.key === 'Escape' && rightPanelOpen) {
        e.preventDefault()
        closeRightPanel()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    increaseFontSize,
    decreaseFontSize,
    resetFontSize,
    closeRightPanel,
    closeSettings,
    closeProjectSettings,
    projectSettingsOpen,
    onboardingOpen,
    rightPanelOpen,
    searchOpen,
    setSearchOpen,
    settingsOpen,
    startNewSession,
    toggleLeftSidebar,
    toggleRightPanel
  ])

  return (
    <div className="app-shell">
      <React.Suspense fallback={<div style={{ flex: 1, background: 'var(--bg-paper-base)' }} />}>
        {onboardingOpen ? (
          <Onboarding />
        ) : settingsOpen ? (
          <SettingsView />
        ) : projectSettingsOpen ? (
          <ProjectSettingsView />
        ) : (
          <>
            <LeftSidebar />
            <CenterColumn />
            <RightPanel />
            {!noteExpandedToCenter && <SelectionToolbar />}
            {!noteExpandedToCenter && <MarkCard />}
          </>
        )}
        {searchOpen && <React.Suspense fallback={null}><SearchDialog /></React.Suspense>}
      </React.Suspense>
      {isWindows && <WindowControls />}
    </div>
  )
}
