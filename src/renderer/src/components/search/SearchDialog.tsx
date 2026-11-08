import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchResults } from '@shared/types'
import { termMatches } from '@shared/search'
import { flushNoteSave } from '@renderer/lib/noteSave'
import { useAppStore, type SearchHit } from '@renderer/stores/appStore'

const DEBOUNCE_MS = 150

type Row = { key: string; hit: SearchHit; text: string; sub: string }
type Group = { label: string; rows: Row[] }

function dateLabel(ms: number): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return `${sameYear ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`
}

function groupsOf(results: SearchResults): Group[] {
  const groups: Group[] = [
    {
      label: '会话',
      rows: results.sessions.map((s) => ({
        key: `s:${s.id}`,
        hit: { kind: 'session', id: s.id },
        text: s.title,
        sub: dateLabel(s.updatedAt)
      }))
    },
    {
      label: '消息',
      rows: results.messages.map((m) => ({
        key: `m:${m.id}`,
        hit: { kind: 'message', id: m.id },
        text: m.snippet,
        sub: `${m.sessionTitle} · ${dateLabel(m.createdAt)}`
      }))
    },
    {
      label: 'Note',
      rows: results.notes.map((n) => ({
        key: `n:${n.target.scope}:${n.target.scopeId}`,
        hit: { kind: 'note', target: n.target },
        text: n.snippet,
        sub:
          n.target.scope === 'global'
            ? '全局 Note'
            : `${n.target.scope === 'project' ? 'Project' : '会话'}「${n.ownerName ?? ''}」的 note`
      }))
    }
  ]
  return groups.filter((g) => g.rows.length > 0)
}

const Highlighted: React.FC<{ text: string; terms: string[] }> = ({ text, terms }) => {
  const parts: React.ReactNode[] = []
  let at = 0
  for (const m of termMatches(text, terms)) {
    parts.push(text.slice(at, m.from), <strong key={m.from}>{text.slice(m.from, m.to)}</strong>)
    at = m.to
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}

export const SearchDialog: React.FC = () => {
  const setSearchOpen = useAppStore((s) => s.setSearchOpen)
  const openSearchHit = useAppStore((s) => s.openSearchHit)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [active, setActive] = useState(0)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])

  // The database lags the note editor by up to 0.5s (lib/noteSave.ts), so pending edits go first.
  useEffect(() => {
    if (!query.trim()) {
      setResults(null)
      return
    }
    let stale = false
    const timer = setTimeout(async () => {
      await flushNoteSave()
      const found = await window.api.invoke('search:query', query)
      if (stale) return
      setResults(found)
      setActive(0)
    }, DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query])

  const groups = useMemo(() => (results ? groupsOf(results) : []), [results])
  const rows = groups.flatMap((g) => g.rows)

  // Braces matter: scrollIntoView returns a Promise in this Chromium, and an effect may only return a cleanup.
  useEffect(() => {
    rowRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (row: Row): void => openSearchHit(row.hit, results?.terms ?? [])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing || rows.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(rows[Math.min(active, rows.length - 1)])
    }
  }

  let index = 0
  return (
    <div className="search-backdrop" onMouseDown={() => setSearchOpen(false)}>
      <div className="search-dialog" role="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="search-input"
          autoFocus
          placeholder="搜索会话、消息和 note"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {query.trim() && results && (
          <div className="search-results" role="listbox">
            {groups.length === 0 ? (
              <div className="search-empty">没有找到</div>
            ) : (
              groups.map((group) => (
                <div key={group.label}>
                  <div className="search-group-label">{group.label}</div>
                  {group.rows.map((row) => {
                    const i = index++
                    return (
                      <button
                        key={row.key}
                        ref={(el) => {
                          rowRefs.current[i] = el
                        }}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        className={`search-row ${i === active ? 'active' : ''}`}
                        onMouseMove={() => setActive(i)}
                        onClick={() => pick(row)}
                      >
                        <span className="search-row-text">
                          <Highlighted text={row.text} terms={results.terms} />
                        </span>
                        <span className="search-row-sub">{row.sub}</span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
