import React, { useState } from 'react'
import type { MainSession, Project } from '@shared/types'
import { sessionLink } from '@shared/sessionLinks'
import { syncNeedsLook, useAppStore } from '@renderer/stores/appStore'
import { flushNoteSave } from '@renderer/lib/noteSave'
import { modKey } from '@renderer/lib/platform'
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu'
import { UpdateButton } from './UpdateButton'
import {
  FolderIcon,
  NotePageIcon,
  PlusIcon,
  SearchIcon,
  SettingsSlidersIcon
} from '@renderer/components/common/Icons'

interface TimeGroup {
  label: '今天' | '昨天' | '7 天内' | '更早'
  sessions: MainSession[]
}

function groupStandaloneSessionsByTime(sessions: MainSession[]): TimeGroup[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 24 * 3600 * 1000
  const startOfSevenDays = startOfToday - 7 * 24 * 3600 * 1000

  const today: MainSession[] = []
  const yesterday: MainSession[] = []
  const withinWeek: MainSession[] = []
  const earlier: MainSession[] = []

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  for (const s of sorted) {
    if (s.updatedAt >= startOfToday) {
      today.push(s)
    } else if (s.updatedAt >= startOfYesterday) {
      yesterday.push(s)
    } else if (s.updatedAt >= startOfSevenDays) {
      withinWeek.push(s)
    } else {
      earlier.push(s)
    }
  }

  const groups: TimeGroup[] = [
    { label: '今天', sessions: today },
    { label: '昨天', sessions: yesterday },
    { label: '7 天内', sessions: withinWeek },
    { label: '更早', sessions: earlier }
  ]

  return groups.filter((g) => g.sessions.length > 0)
}

const SESSION_DRAG_TYPE = 'application/x-hush-session'

type Menu = { x: number; y: number; items: MenuItem[] }

// Enter or leaving the field saves; Esc or an empty name cancels.
const NameInput: React.FC<{
  initial: string
  placeholder?: string
  className: string
  onDone: (name: string | null) => void
}> = ({ initial, placeholder, className, onDone }) => {
  const [value, setValue] = useState(initial)
  const finish = (save: boolean): void => {
    const name = value.trim()
    onDone(save && name && name !== initial ? name : null)
  }
  return (
    <input
      className={`sidebar-name-input ${className}`}
      value={value}
      placeholder={placeholder}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') {
          // Esc here only cancels the edit.
          e.stopPropagation()
          finish(false)
        }
      }}
    />
  )
}

const SessionItem: React.FC<{
  session: MainSession
  projects: Project[]
  active: boolean
  onMenu: (menu: Menu) => void
}> = ({ session, projects, active, onMenu }) => {
  const [renaming, setRenaming] = useState(false)
  const selectSession = useAppStore((s) => s.selectSession)
  const renameSession = useAppStore((s) => s.renameSession)
  const moveSession = useAppStore((s) => s.moveSession)
  const deleteSession = useAppStore((s) => s.deleteSession)

  if (renaming) {
    return (
      <NameInput
        initial={session.title}
        className="session-name-input"
        onDone={(title) => {
          setRenaming(false)
          if (title) renameSession(session.id, title)
        }}
      />
    )
  }

  const openMenu = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    const usage = await window.api.invoke('sessions:usage', session.id)
    const moveTargets: MenuItem[] = projects.map((p) => ({
      label: p.name,
      checked: p.id === session.projectId,
      onSelect: () => p.id !== session.projectId && moveSession(session.id, p.id)
    }))
    if (session.projectId) moveTargets.push({ label: '移出 project', onSelect: () => moveSession(session.id, null) })
    onMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: '重命名', onSelect: () => setRenaming(true) },
        { label: '复制链接', onSelect: () => void navigator.clipboard.writeText(sessionLink(session.id, session.title)) },
        ...(moveTargets.length > 0 ? [{ section: '移动到' }, ...moveTargets] : []),
        { section: '' },
        {
          label: '删除',
          danger: true,
          // A standalone session's note with something in it gets its own line in the prompt (product.md §1).
          onSelect: async () => {
            await flushNoteSave()
            const note = session.projectId
              ? ''
              : await window.api.invoke('notes:get', { scope: 'session', scopeId: session.id })
            const warning = note.trim() ? '\n\n这个会话的 note 里有内容，也会一起删除。' : ''
            if (window.confirm(`删除「${session.title}」？它的消息、mark、追问和 note 会一起删除。${warning}`)) {
              deleteSession(session.id)
            }
          }
        },
        ...(usage.input + usage.output > 0
          ? [
              { section: '' },
              {
                section: `输入 ${usage.input.toLocaleString('en-US')} · 输出 ${usage.output.toLocaleString('en-US')} tokens`
              }
            ]
          : [])
      ]
    })
  }

  return (
    <button
      type="button"
      className={`session-item-btn ${active ? 'active' : ''}`}
      onClick={() => selectSession(session.id)}
      onContextMenu={(e) => void openMenu(e)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      title={session.title}
    >
      {session.title}
    </button>
  )
}

export const LeftSidebar: React.FC = () => {
  const projects = useAppStore((s) => s.projects)
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const expandedProjectIds = useAppStore((s) => s.expandedProjectIds)
  const leftSidebarOpen = useAppStore((s) => s.leftSidebarOpen)
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const rightPanelTab = useAppStore((s) => s.rightPanelTab)
  const activeNoteTarget = useAppStore((s) => s.activeNoteTarget)

  const newSessionProjectId = useAppStore((s) => s.newSessionProjectId)
  const projectSettingsId = useAppStore((s) => s.projectSettingsId)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const startNewSession = useAppStore((s) => s.startNewSession)
  const toggleProjectExpanded = useAppStore((s) => s.toggleProjectExpanded)
  const openProjectNote = useAppStore((s) => s.openProjectNote)
  const openGlobalNote = useAppStore((s) => s.openGlobalNote)
  const openSettings = useAppStore((s) => s.openSettings)
  const needsLook = useAppStore((s) => syncNeedsLook(s.syncStatus))
  const setSearchOpen = useAppStore((s) => s.setSearchOpen)
  const createProject = useAppStore((s) => s.createProject)
  const deleteProject = useAppStore((s) => s.deleteProject)
  const moveSession = useAppStore((s) => s.moveSession)
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)

  const mainSessions = React.useMemo(
    () => sessions.filter((s): s is MainSession => s.kind === 'main'),
    [sessions]
  )

  const standaloneGroups = React.useMemo(() => {
    const standalone = mainSessions.filter((s) => s.projectId === null)
    return groupStandaloneSessionsByTime(standalone)
  }, [mainSessions])

  const sortedProjects = React.useMemo(
    () => [...projects].sort((a, b) => a.sortOrder - b.sortOrder),
    [projects]
  )

  const isGlobalNoteActive =
    rightPanelOpen &&
    rightPanelTab === 'note' &&
    activeNoteTarget?.scope === 'global'

  return (
    <aside className={`left-sidebar ${leftSidebarOpen ? '' : 'collapsed'}`}>
      <div className="sidebar-traffic-spacer drag-region" />

      <div className="sidebar-top-actions no-drag">
        <button type="button" className="sidebar-action-btn" title={`搜索 (${modKey}K)`} onClick={() => setSearchOpen(true)}>
          <span className="sidebar-action-left">
            <span className="sidebar-action-icon">
              <SearchIcon size={14} />
            </span>
            <span>搜索</span>
          </span>
          <span className="sidebar-shortcut">{modKey}K</span>
        </button>

        <button
          type="button"
          className="sidebar-action-btn"
          onClick={() => startNewSession()}
          title={`新对话 (${modKey}N)`}
        >
          <span className="sidebar-action-left">
            <span className="sidebar-action-icon">
              <PlusIcon size={14} />
            </span>
            <span>新对话</span>
          </span>
        </button>
      </div>

      <div className="sidebar-scroll no-drag">
        <div className="sidebar-section">
          <div className="sidebar-group-label sidebar-group-label-with-action">
            <span>Project</span>
            <button
              type="button"
              className="sidebar-label-action"
              title="新建 project"
              aria-label="新建 project"
              onClick={() => setCreatingProject(true)}
            >
              <PlusIcon size={11} />
            </button>
          </div>

          {sortedProjects.map((project) => {
            const isExpanded = Boolean(expandedProjectIds[project.id])
            const isProjectNoteActive =
              rightPanelOpen &&
              rightPanelTab === 'note' &&
              activeNoteTarget?.scope === 'project' &&
              activeNoteTarget?.scopeId === project.id
            const projectSessions = mainSessions
              .filter((s) => s.projectId === project.id)
              .sort((a, b) => b.updatedAt - a.updatedAt)
            const isCurrent =
              projectSettingsId === project.id ||
              (activeSessionId === null && newSessionProjectId === project.id)

            return (
              <div key={project.id} className="project-group">
                <div
                  className={`project-header-row ${dropTargetId === project.id ? 'drop-target' : ''} ${
                    isCurrent ? 'current' : ''
                  }`}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { label: 'project 设置', onSelect: () => openProjectSettings(project.id) },
                        { section: '' },
                        {
                          label: '删除',
                          danger: true,
                          onSelect: () => {
                            const n = projectSessions.length
                            if (window.confirm(`删除「${project.name}」？将删除 ${n} 个会话和这个 project 的 note。`)) {
                              deleteProject(project.id)
                            }
                          }
                        }
                      ]
                    })
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    setDropTargetId(project.id)
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTargetId(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDropTargetId(null)
                    const id = e.dataTransfer.getData(SESSION_DRAG_TYPE)
                    const dragged = mainSessions.find((s) => s.id === id)
                    if (dragged && dragged.projectId !== project.id) moveSession(id, project.id)
                  }}
                >
                  <button
                    type="button"
                    className="project-toggle-btn"
                    onClick={() => toggleProjectExpanded(project.id)}
                  >
                    <span className="sidebar-action-icon">
                      <FolderIcon size={15} open={isExpanded} />
                    </span>
                    <span className="project-name-text">{project.name}</span>
                  </button>
                  <button
                    type="button"
                    className="project-note-icon-btn"
                    title={`在《${project.name}》里开新对话`}
                    aria-label={`在《${project.name}》里开新对话`}
                    onClick={(e) => {
                      e.stopPropagation()
                      startNewSession(project.id)
                    }}
                  >
                    <PlusIcon size={12} />
                  </button>
                  <button
                    type="button"
                    className={`project-note-icon-btn ${isProjectNoteActive ? 'active' : ''}`}
                    title={`打开《${project.name}》的 Note`}
                    aria-label={`打开《${project.name}》的 Note`}
                    onClick={(e) => {
                      e.stopPropagation()
                      openProjectNote(project.id)
                    }}
                  >
                    <NotePageIcon size={13.5} />
                  </button>
                </div>

                {isExpanded && projectSessions.length > 0 && (
                  <div className="project-sessions-list">
                    {projectSessions.map((sess) => (
                      <SessionItem
                        key={sess.id}
                        session={sess}
                        projects={sortedProjects}
                        active={activeSessionId === sess.id}
                        onMenu={setMenu}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {creatingProject && (
            <NameInput
              initial=""
              placeholder="project 名字"
              className="project-name-input"
              onDone={(name) => {
                setCreatingProject(false)
                if (name) createProject(name)
              }}
            />
          )}
        </div>

        {standaloneGroups.map((group) => (
          <div key={group.label} className="sidebar-section">
            <div className="sidebar-group-label">{group.label}</div>
            {group.sessions.map((sess) => (
              <SessionItem
                key={sess.id}
                session={sess}
                projects={sortedProjects}
                active={activeSessionId === sess.id}
                onMenu={setMenu}
              />
            ))}
          </div>
        ))}
      </div>

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}

      <div className="sidebar-footer no-drag">
        <button
          type="button"
          className={`sidebar-footer-note-btn ${isGlobalNoteActive ? 'active' : ''}`}
          onClick={openGlobalNote}
        >
          <NotePageIcon size={14} />
          <span>全局 Note</span>
        </button>

        <div className="sidebar-footer-actions">
          <UpdateButton />
          <button
          type="button"
          className="sidebar-settings-btn"
          onClick={openSettings}
          title={needsLook ? '设置 · 同步有提示' : '设置'}
          aria-label={needsLook ? '设置，同步有提示' : '设置'}
        >
          <SettingsSlidersIcon size={15} />
          {needsLook && <span className="sidebar-settings-dot" />}
          </button>
        </div>
      </div>
    </aside>
  )
}
