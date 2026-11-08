import React, { useEffect } from 'react'
import { useAppStore } from '@renderer/stores/appStore'
import { LeftSidebar } from '@renderer/components/sidebar/LeftSidebar'
import { CenterColumn } from '@renderer/components/chat/CenterColumn'
import { RightPanel } from '@renderer/components/panel/RightPanel'
import { SelectionToolbar } from '@renderer/components/chat/SelectionToolbar'
import { MarkCard } from '@renderer/components/chat/MarkCard'
import { SettingsView } from '@renderer/components/settings/SettingsView'
import { ProjectSettingsView } from '@renderer/components/settings/ProjectSettingsView'
import { Onboarding } from '@renderer/components/onboarding/Onboarding'
import { SearchDialog } from '@renderer/components/search/SearchDialog'
import { WindowControls } from '@renderer/components/common/WindowControls'
import { isWindows } from '@renderer/lib/platform'

export const App: React.FC = () => {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const rightPanelWidth = useAppStore((s) => s.rightPanelWidth)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
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

      // Settings fields save on blur, and these keys unmount the page without one.
      if ((settingsOpen || projectSettingsOpen) && (e.key === 'Escape' || (isMod && e.key.toLowerCase() === 'n'))) {
        ;(document.activeElement as HTMLElement | null)?.blur()
      }

      if (isMod && e.key === '\\') {
        e.preventDefault()
        toggleLeftSidebar()
        return
      }

      if (isMod && e.key.toLowerCase() === 'j') {
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

      if (e.key === 'Escape' && rightPanelOpen) {
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
          <SelectionToolbar />
          <MarkCard />
        </>
      )}
      {searchOpen && <SearchDialog />}
      {isWindows && <WindowControls />}
    </div>
  )
}
