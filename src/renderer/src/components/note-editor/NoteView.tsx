import React, { useEffect, useMemo, useState } from 'react'
import type { NoteTarget } from '@shared/types'
import { noteSections } from '@shared/noteSections'
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu'
import { sameTarget } from '@renderer/lib/noteSave'
import { sessionNoteTarget, useAppStore } from '@renderer/stores/appStore'
import {
  ChevronRightIcon,
  ExpandPanelIcon,
  HistoryClockIcon,
  SparkleOrganizeIcon
} from '@renderer/components/common/Icons'
import { NoteEditor, scrollNoteToLine, type NoteSelection } from './NoteEditor'
import { NoteHistory } from './NoteHistory'
import { OrganizeView, type OrganizeMode } from './OrganizeView'

type TargetRow = { section: string } | { label: string; target: NoteTarget }

// Where line `line` starts in the text; past the last line, the end of the text.
function lineStart(text: string, line: number): number {
  const lines = text.split('\n')
  if (line >= lines.length) return text.length
  return lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0)
}

export const NoteView: React.FC = () => {
  const [tocOpen, setTocOpen] = useState(true)
  const [content, setContent] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  // History belongs to one note; switching notes leaves it.
  const [historyFor, setHistoryFor] = useState<NoteTarget | null>(null)
  const [organizing, setOrganizing] = useState<{ target: NoteTarget; organize: OrganizeMode } | null>(null)

  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const projects = useAppStore((s) => s.projects)
  const activeNoteTarget = useAppStore((s) => s.activeNoteTarget)
  const noteExpandedToCenter = useAppStore((s) => s.noteExpandedToCenter)

  const toggleNoteExpandedToCenter = useAppStore(
    (s) => s.toggleNoteExpandedToCenter
  )
  const jumpToMessage = useAppStore((s) => s.jumpToMessage)
  const selectSession = useAppStore((s) => s.selectSession)
  const transferNoteText = useAppStore((s) => s.transferNoteText)

  const resolvedTarget = useMemo(
    (): NoteTarget => activeNoteTarget ?? sessionNoteTarget(sessions, activeSessionId),
    [activeNoteTarget, activeSessionId, sessions]
  )

  const scopeLabel = useMemo(() => {
    if (resolvedTarget.scope === 'global') {
      return '全局 Note'
    }
    if (resolvedTarget.scope === 'project') {
      const proj = projects.find((p) => p.id === resolvedTarget.scopeId)
      return `Project Note · ${proj?.name ?? ''}`
    }
    const sess = sessions.find((s) => s.id === resolvedTarget.scopeId)
    return `会话 Note · ${sess?.title ?? ''}`
  }, [projects, resolvedTarget, sessions])

  const sections = useMemo(() => noteSections(content), [content])

  // "整理本会话" belongs to the note the current session writes to, not to any note opened beside it.
  const organizableSessionId =
    activeSessionId && sameTarget(resolvedTarget, sessionNoteTarget(sessions, activeSessionId)) ? activeSessionId : null

  useEffect(() => {
    setHistoryFor(null)
    setOrganizing(null)
  }, [resolvedTarget.scope, resolvedTarget.scopeId])

  // Every other note a passage can go to: the global one, each project's, each standalone session's.
  const transferTargets = useMemo((): TargetRow[] => {
    const group = (title: string, items: { target: NoteTarget; label: string }[]): TargetRow[] => {
      const others = items.filter((i) => !sameTarget(i.target, resolvedTarget))
      return others.length > 0 ? [{ section: title }, ...others] : []
    }
    return [
      ...group('全局', [{ target: { scope: 'global', scopeId: 'global' }, label: '全局 Note' }]),
      ...group('Project', projects.map((p) => ({ target: { scope: 'project', scopeId: p.id }, label: p.name }))),
      ...group(
        '会话',
        sessions
          .filter((s) => s.kind === 'main' && s.projectId === null)
          .map((s) => ({ target: { scope: 'session', scopeId: s.id }, label: s.title }))
      )
    ]
  }, [projects, sessions, resolvedTarget])

  // Two steps, since the app's menu has no submenus: move or copy, then where to.
  const openTransferMenu = (x: number, y: number, range: NoteSelection): void => {
    const chooseTarget = (mode: 'move' | 'copy'): void =>
      setMenu({
        x,
        y,
        items: transferTargets.map((row) =>
          'section' in row
            ? row
            : {
                label: row.label,
                onSelect: () => transferNoteText({ source: resolvedTarget, ...range, target: row.target, mode })
              }
        )
      })
    setMenu({
      x,
      y,
      items: [
        { label: '移动到…', onSelect: () => chooseTarget('move') },
        { label: '复制到…', onSelect: () => chooseTarget('copy') }
      ]
    })
  }

  if (organizing && sameTarget(organizing.target, resolvedTarget)) {
    return (
      <OrganizeView target={resolvedTarget} organize={organizing.organize} onClose={() => setOrganizing(null)} />
    )
  }

  if (historyFor && sameTarget(historyFor, resolvedTarget)) {
    return <NoteHistory target={resolvedTarget} onClose={() => setHistoryFor(null)} />
  }

  return (
    <div className="note-tab-container">
      <div className="note-toolbar">
        <span className="note-scope-label" title={scopeLabel}>
          {scopeLabel}
        </span>

        <div className="note-toolbar-actions">
          <button
            type="button"
            className="note-small-btn"
            title="历史版本"
            onClick={() => setHistoryFor(resolvedTarget)}
          >
            <HistoryClockIcon size={12.5} />
            <span>历史版本</span>
          </button>
          <button
            type="button"
            className="note-small-btn"
            onClick={toggleNoteExpandedToCenter}
            title={noteExpandedToCenter ? '收回到右栏' : '放大到整个中栏'}
          >
            <ExpandPanelIcon size={12.5} expanded={noteExpandedToCenter} />
            <span>{noteExpandedToCenter ? '收回右栏' : '展开到中栏'}</span>
          </button>
        </div>
      </div>

      <div className="note-toc-section">
        <button
          type="button"
          className="note-toc-toggle"
          onClick={() => setTocOpen((prev) => !prev)}
        >
          <span>目录 ({sections.length})</span>
          <ChevronRightIcon size={11} expanded={tocOpen} />
        </button>

        {tocOpen && sections.length > 0 && (
          <div className="note-toc-list">
            {sections.map((h, i) => (
              <div
                key={i}
                className="note-toc-item"
                style={{ paddingLeft: `${(h.level - 1) * 12 + 6}px` }}
                onClick={() => scrollNoteToLine(h.line)}
              >
                <span>{h.title}</span>
                <button
                  type="button"
                  className="note-toc-more"
                  title="移动到… / 复制到…"
                  onClick={(e) => {
                    e.stopPropagation()
                    const from = lineStart(content, h.line)
                    const to = lineStart(content, h.endLine)
                    openTransferMenu(e.clientX, e.clientY, { from, to, text: content.slice(from, to) })
                  }}
                >
                  ⋯
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="note-ai-bar">
        {organizableSessionId && (
          <button
            type="button"
            className="note-small-btn"
            onClick={() =>
              setOrganizing({ target: resolvedTarget, organize: { mode: 'session', sessionId: organizableSessionId } })
            }
          >
            <SparkleOrganizeIcon size={12.5} />
            <span>整理本会话</span>
          </button>
        )}
        <button
          type="button"
          className="note-small-btn"
          disabled={!content.trim()}
          onClick={() => setOrganizing({ target: resolvedTarget, organize: { mode: 'rewrite' } })}
        >
          <SparkleOrganizeIcon size={12.5} />
          <span>重新整理全文</span>
        </button>
      </div>

      <div className="note-editor-scroll">
        <div
          style={
            noteExpandedToCenter
              ? { maxWidth: 'var(--body-max-width)', margin: '0 auto' }
              : undefined
          }
        >
          <NoteEditor
            target={resolvedTarget}
            onChange={setContent}
            onJumpToMessage={jumpToMessage}
            onOpenSession={(id) => sessions.some((s) => s.id === id && s.kind === 'main') && selectSession(id)}
            onSelectionMenu={openTransferMenu}
          />
        </div>
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
