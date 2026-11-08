import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { Attachment, MainSession, Note } from '@shared/types'
import { noteSections, type NoteSection } from '@shared/noteSections'
import { flushNoteSave, sameTarget } from '@renderer/lib/noteSave'
import { sessionNoteTarget, useAppStore } from '@renderer/stores/appStore'

export type NoteRef = Extract<Attachment, { type: 'note_ref' }>

// The textarea keeps focus while the picker is open, so it hands its keys over; true means "handled".
export type NoteRefPickerHandle = { onKey: (e: React.KeyboardEvent) => boolean }

interface NoteRefPickerProps {
  query: string
  onPick: (ref: NoteRef) => void
  onPickSession: (session: MainSession) => void
  onClose: () => void
}

type Entry = { note: Note; name: string; sections: NoteSection[] }
type Row = { entry: Entry; section: NoteSection | null } | { session: MainSession }

const SCOPE_HINT = { global: '全局', project: 'Project', session: '会话' } as const

export const NoteRefPicker = React.forwardRef<NoteRefPickerHandle, NoteRefPickerProps>(
  ({ query, onPick, onPickSession, onClose }, ref) => {
    const [notes, setNotes] = useState<Note[] | null>(null)
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [active, setActive] = useState(0)
    const rowRefs = useRef<(HTMLButtonElement | null)[]>([])

    const projects = useAppStore((s) => s.projects)
    const sessions = useAppStore((s) => s.sessions)
    const activeSessionId = useAppStore((s) => s.activeSessionId)

    // Unsaved typing in the note panel would otherwise be missing from the list.
    useEffect(() => {
      flushNoteSave()
        .then(() => window.api.invoke('notes:list'))
        .then(setNotes)
    }, [])

    // product.md §7: the current conversation's note first, then the global one, then the rest.
    const entries = useMemo((): Entry[] => {
      const own = sessionNoteTarget(sessions, activeSessionId)
      const rank = (n: Note): number => (sameTarget(n, own) ? 0 : n.scope === 'global' ? 1 : 2)
      const nameOf = (n: Note): string =>
        n.scope === 'global'
          ? '全局 Note'
          : n.scope === 'project'
            ? (projects.find((p) => p.id === n.scopeId)?.name ?? '')
            : (sessions.find((s) => s.id === n.scopeId)?.title ?? '')
      return (notes ?? [])
        .filter((n) => n.content.trim())
        .sort((a, b) => rank(a) - rank(b))
        .map((note) => ({ note, name: nameOf(note), sections: noteSections(note.content) }))
    }, [notes, projects, sessions, activeSessionId])

    // Other conversations follow the notes, latest first; the current one can't quote itself.
    const others = useMemo(
      () =>
        sessions
          .filter((s): s is MainSession => s.kind === 'main' && s.id !== activeSessionId)
          .sort((a, b) => b.updatedAt - a.updatedAt),
      [sessions, activeSessionId]
    )

    // A query keeps notes whose name matches or that have matching sections, and shows those sections.
    const rows = useMemo((): Row[] => {
      const q = query.trim().toLowerCase()
      const sessionRows = others.filter((s) => s.title.toLowerCase().includes(q)).map((session) => ({ session }))
      const noteRows = entries.flatMap((entry): Row[] => {
        const open = expanded.has(entry.note.id)
        if (!q) return [{ entry, section: null }, ...(open ? entry.sections.map((section) => ({ entry, section })) : [])]
        const hits = entry.sections.filter((s) => s.title.toLowerCase().includes(q))
        if (!entry.name.toLowerCase().includes(q) && hits.length === 0) return []
        const shown = open ? entry.sections : hits
        return [{ entry, section: null }, ...shown.map((section) => ({ entry, section }))]
      })
      return [...noteRows, ...sessionRows]
    }, [entries, others, expanded, query])

    useEffect(() => {
      setActive(0)
    }, [query])
    // Braces matter: scrollIntoView returns a Promise in this Chromium, and an effect may only return a cleanup.
    useEffect(() => {
      rowRefs.current[active]?.scrollIntoView({ block: 'nearest' })
    }, [active])

    const pick = (row: Row): void => {
      if ('session' in row) return onPickSession(row.session)
      const { entry, section } = row
      const label = section ? `《${entry.name}》/ ${section.title}` : `《${entry.name}》`
      onPick({
        type: 'note_ref',
        noteId: entry.note.id,
        sectionTitle: section?.title ?? null,
        label,
        text: section ? section.body : entry.note.content.trim()
      })
    }

    const setOpen = (noteId: string, open: boolean): void =>
      setExpanded((prev) => {
        const next = new Set(prev)
        if (open) next.add(noteId)
        else next.delete(noteId)
        return next
      })

    useImperativeHandle(ref, () => ({
      onKey: (e) => {
        if (e.key === 'Escape') {
          onClose()
          return true
        }
        if (rows.length === 0) return false
        const row = rows[Math.min(active, rows.length - 1)]
        switch (e.key) {
          case 'ArrowDown':
            setActive((i) => Math.min(i + 1, rows.length - 1))
            return true
          case 'ArrowUp':
            setActive((i) => Math.max(i - 1, 0))
            return true
          case 'Enter':
          case 'Tab':
            pick(row)
            return true
          case 'ArrowRight':
            if ('session' in row || row.section || row.entry.sections.length === 0) return false
            setOpen(row.entry.note.id, true)
            return true
          case 'ArrowLeft':
            if ('session' in row || !expanded.has(row.entry.note.id)) return false
            setOpen(row.entry.note.id, false)
            setActive(rows.findIndex((r) => 'entry' in r && r.entry === row.entry && !r.section))
            return true
        }
        return false
      }
    }))

    if (notes === null) return null
    // A typed "@" that matches nothing (an email address, say) shouldn't hold a menu open.
    if (rows.length === 0 && query.trim()) return null

    return (
      <div className="chat-meta-popover note-ref-picker" role="listbox" onMouseDown={(e) => e.preventDefault()}>
        {rows.length === 0 ? (
          <div className="note-ref-picker-empty">还没有写过 note，也没有别的会话</div>
        ) : (
          rows.map((row, i) => {
            const setRef = (el: HTMLButtonElement | null): void => {
              rowRefs.current[i] = el
            }
            if ('session' in row) {
              return (
                <React.Fragment key={row.session.id}>
                  {(i === 0 || !('session' in rows[i - 1])) && <div className="note-ref-picker-group">会话</div>}
                  <button
                    ref={setRef}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className={`chat-meta-popover-item note-ref-row ${i === active ? 'active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(row)}
                  >
                    <span className="popover-item-title">{row.session.title}</span>
                  </button>
                </React.Fragment>
              )
            }
            const { entry, section } = row
            const open = expanded.has(entry.note.id)
            return (
              <button
                key={`${entry.note.id}:${section?.line ?? 'all'}`}
                ref={setRef}
                type="button"
                role="option"
                aria-selected={i === active}
                className={`chat-meta-popover-item note-ref-row ${i === active ? 'active' : ''}`}
                style={section ? { paddingLeft: `${10 + section.level * 12}px` } : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(row)}
              >
                <span className="popover-item-title">{section ? section.title : entry.name}</span>
                {!section && <span className="popover-item-desc">{SCOPE_HINT[entry.note.scope]}</span>}
                {!section && entry.sections.length > 0 && (
                  <span
                    className="note-ref-expand"
                    title={open ? '收起各节' : '展开各节'}
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpen(entry.note.id, !open)
                    }}
                  >
                    {open ? '▾' : '▸'}
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>
    )
  }
)
