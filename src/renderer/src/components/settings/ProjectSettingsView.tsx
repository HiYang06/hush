import React, { useState } from 'react'
import type { Project } from '@shared/types'
import { ChevronRightIcon } from '@renderer/components/common/Icons'
import { useAppStore } from '@renderer/stores/appStore'
import { Group } from './SettingsView'

// Takes over the whole window like the provider settings: one project's name and prompt at a time.
export const ProjectSettingsView: React.FC = () => {
  const projects = useAppStore((s) => s.projects)
  const sessions = useAppStore((s) => s.sessions)
  const projectSettingsId = useAppStore((s) => s.projectSettingsId)
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)
  const closeProjectSettings = useAppStore((s) => s.closeProjectSettings)

  const current = projects.find((p) => p.id === projectSettingsId)
  const sessionCount = (projectId: string): number =>
    sessions.filter((s) => s.kind === 'main' && s.projectId === projectId).length

  return (
    <>
      <aside className="left-sidebar">
        <div className="sidebar-traffic-spacer drag-region" />
        <div className="sidebar-top-actions no-drag">
          <button type="button" className="sidebar-action-btn" onClick={closeProjectSettings}>
            <span className="sidebar-action-left">
              <span className="sidebar-action-icon settings-back-icon">
                <ChevronRightIcon size={13} />
              </span>
              <span>返回对话</span>
            </span>
            <span className="sidebar-shortcut">Esc</span>
          </button>
        </div>

        <div className="sidebar-scroll no-drag">
          <div className="sidebar-group-label">Project</div>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`session-item-btn settings-nav-item ${p.id === projectSettingsId ? 'active' : ''}`}
              onClick={() => openProjectSettings(p.id)}
            >
              <span className="settings-nav-name">{p.name}</span>
              <span className="settings-nav-meta">{sessionCount(p.id)} 个会话</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="center-column">
        <div className="settings-drag drag-region" />
        <div className="settings-scroll">
          <div className="settings-page">
            {current && <ProjectDetail key={current.id} project={current} sessionCount={sessionCount(current.id)} />}
          </div>
        </div>
      </main>
    </>
  )
}

const ProjectDetail: React.FC<{ project: Project; sessionCount: number }> = ({ project, sessionCount }) => {
  const updateProject = useAppStore((s) => s.updateProject)
  const deleteProject = useAppStore((s) => s.deleteProject)
  const [name, setName] = useState(project.name)
  const [prompt, setPrompt] = useState(project.systemPrompt ?? '')

  return (
    <>
      <header className="settings-header">
        <div className="settings-header-text">
          <input
            className="settings-title settings-title-input"
            value={name}
            aria-label="project 名字"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (name.trim() && name.trim() !== project.name) updateProject(project.id, { name: name.trim() })
              else setName(project.name)
            }}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.currentTarget.blur()}
          />
          <p className="settings-subtitle">{sessionCount} 个会话</p>
        </div>
      </header>

      <Group title="提示词">
        <textarea
          className="project-prompt-input"
          value={prompt}
          placeholder="留空时使用全局提示词"
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => {
            if (prompt.trim() !== (project.systemPrompt ?? '')) updateProject(project.id, { systemPrompt: prompt })
          }}
        />
      </Group>
      <p className="settings-muted project-prompt-hint">
        填了就完全代替全局提示词，不会和它拼在一起。
      </p>

      <div className="settings-danger">
        <button
          type="button"
          className="settings-delete"
          onClick={() => {
            if (window.confirm(`删除「${project.name}」？将删除 ${sessionCount} 个会话和这个 project 的 note。`)) {
              deleteProject(project.id)
            }
          }}
        >
          删除这个 project
        </button>
      </div>
    </>
  )
}
