import React, { useEffect, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { unifiedMergeView } from '@codemirror/merge'
import { lostClipLinks } from '@shared/noteClips'
import type { NoteTarget, StreamEvent } from '@shared/types'
import { flushNoteSave } from '@renderer/lib/noteSave'
import { useAppStore } from '@renderer/stores/appStore'
import { noteLook, revealNoteText, syncNoteContent } from './NoteEditor'

export type OrganizeMode = { mode: 'session'; sessionId: string } | { mode: 'rewrite' }

type Phase = 'waiting' | 'streaming' | 'done' | 'error'

// The comparison in the app's colors, light and dark alike. The library's colors are tuned for light
// only, and its selectors are more specific than a theme's, hence the !important.
const compareLook = [
  EditorState.phrases.of({ '$ unchanged lines': '$ 行没有改动' }),
  EditorView.theme({
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
    '.cm-changedLine, .cm-inlineChangedLine, .cm-deletedChunk': { backgroundColor: 'transparent !important' },
    '.cm-insertedLine, .cm-changedText': { background: 'var(--diff-inserted-bg) !important' },
    '.cm-deletedChunk': { paddingLeft: '0' },
    '.cm-deletedChunk .cm-deletedText, .cm-deletedChunk del': {
      background: 'var(--diff-deleted-bg) !important',
      textDecoration: 'line-through',
      textDecorationColor: 'var(--text-muted)'
    },
    '.cm-changeGutter': { width: '2px', paddingLeft: '0', marginRight: '8px' },
    '.cm-changedLineGutter': { background: 'var(--diff-inserted-bg) !important' },
    '.cm-deletedLineGutter': { background: 'var(--diff-deleted-bg) !important' },
    '.cm-collapsedLines': {
      background: 'none !important',
      color: 'var(--text-muted) !important',
      fontSize: '12px',
      padding: '4px 0',
      '&:before, &:after': { content: '"⋯"' }
    }
  })
]

interface OrganizeViewProps {
  target: NoteTarget
  organize: OrganizeMode
  onClose: () => void
}

// Takes the note page's place while the model organizes (product.md §6): a draft to edit and append,
// or the rewritten note compared with the current one. Leaving the page stops the model.
export const OrganizeView: React.FC<OrganizeViewProps> = ({ target, organize, onClose }) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const editable = useRef(new Compartment())
  const compare = useRef(new Compartment())
  const jobRef = useRef<string | null>(null)
  const [phase, setPhase] = useState<Phase>('waiting')
  const [error, setError] = useState<string | null>(null)
  const [base, setBase] = useState<string | null>(null)
  const [lost, setLost] = useState(0)
  const [unchanged, setUnchanged] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const selectedModelId = useAppStore((s) => s.selectedModelId)
  const thinkingLevel = useAppStore((s) => s.thinkingLevel)
  const rewrite = organize.mode === 'rewrite'

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          noteLook,
          editable.current.of(EditorView.editable.of(false)),
          compare.current.of([])
        ]
      })
    })
    viewRef.current = view
    return () => view.destroy()
  }, [])

  useEffect(() => {
    const view = viewRef.current!
    let jobId: string | null = null
    let started = ''
    // Events can arrive before `organize:start` answers with the job's id.
    const early: { jobId: string; event: StreamEvent }[] = []

    const apply = (event: StreamEvent): void => {
      switch (event.type) {
        case 'thinking':
          break
        case 'text':
          setPhase('streaming')
          view.dispatch({ changes: { from: view.state.doc.length, insert: event.delta } })
          break
        case 'done':
          finish()
          break
        case 'error':
          setError(event.message)
          setPhase('error')
          jobRef.current = null
          break
      }
    }

    // A draft becomes editable; a rewrite is shown against the note it was made from.
    const finish = (): void => {
      jobRef.current = null
      setPhase('done')
      if (rewrite) {
        const after = view.state.doc.toString()
        setLost(lostClipLinks(started, after))
        setUnchanged(after.trim() === started.trim())
        view.dispatch({
          effects: compare.current.reconfigure([
            unifiedMergeView({ original: started, mergeControls: false, collapseUnchanged: { margin: 2, minSize: 6 } }),
            compareLook
          ])
        })
      } else {
        view.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(true)) })
        view.focus()
      }
    }

    const off = window.api.on('organize:event', (payload) => {
      if (jobId === null) early.push(payload)
      else if (payload.jobId === jobId) apply(payload.event)
    })

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '' },
      effects: [
        editable.current.reconfigure(EditorView.editable.of(false)),
        compare.current.reconfigure([])
      ]
    })
    setPhase('waiting')
    setError(null)
    setUnchanged(false)
    let cancelled = false
    // The model must see what was just typed into the note.
    flushNoteSave()
      .then(() =>
        window.api.invoke(
          'organize:start',
          organize.mode === 'session'
            ? { mode: 'session', sessionId: organize.sessionId, target, modelId: selectedModelId, thinking: thinkingLevel }
            : { mode: 'rewrite', target, modelId: selectedModelId, thinking: thinkingLevel }
        )
      )
      .then((result) => {
        if (cancelled) {
          void window.api.invoke('organize:stop', result.jobId)
          return
        }
        jobId = result.jobId
        jobRef.current = jobId
        started = result.base
        setBase(result.base)
        for (const e of early.splice(0)) if (e.jobId === jobId) apply(e.event)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message)
        setPhase('error')
      })

    return () => {
      cancelled = true
      off()
      if (jobRef.current) void window.api.invoke('organize:stop', jobRef.current)
      jobRef.current = null
    }
    // A retry starts over with whatever model is picked by then.
  }, [attempt])

  const stop = (): void => {
    if (!jobRef.current) return
    void window.api.invoke('organize:stop', jobRef.current)
    jobRef.current = null
    const view = viewRef.current!
    // Half a rewrite would replace the whole note with half of it; half a draft is still worth keeping.
    if (rewrite || view.state.doc.length === 0) {
      onClose()
      return
    }
    setPhase('done')
    view.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(true)) })
  }

  const confirm = async (): Promise<void> => {
    const text = viewRef.current!.state.doc.toString()
    if (!text.trim()) {
      onClose()
      return
    }
    await flushNoteSave()
    if (rewrite) {
      try {
        syncNoteContent(target, await window.api.invoke('notes:aiRewrite', target, base ?? '', text))
      } catch {
        setError('整理期间 note 被改过了，请重新整理一次。')
        setPhase('error')
        return
      }
    } else {
      syncNoteContent(target, await window.api.invoke('notes:aiAppend', target, text))
      revealNoteText(target, text.trim())
    }
    onClose()
  }

  const title = rewrite ? '重新整理全文' : '整理本会话'
  const status =
    phase === 'waiting'
      ? '等待回复…'
      : phase === 'streaming'
        ? '生成中…'
        : phase === 'error'
          ? '出错'
          : rewrite
            ? '修改对比'
            : '草稿'

  return (
    <div className="note-tab-container">
      <div className="note-toolbar">
        <button type="button" className="note-small-btn" onClick={onClose}>
          ← 返回 note
        </button>
        <span className="note-scope-label">
          {title} · {status}
        </span>
      </div>

      {phase === 'done' && unchanged && <div className="organize-notice">整理结果和现在的 note 一样，不需要替换。</div>}
      {phase === 'done' && rewrite && lost > 0 && (
        <div className="organize-notice">有 {lost} 段收录的来源链接丢了，替换后回答里对应的下划线会消失。</div>
      )}
      {phase === 'error' && (
        <div className="organize-notice error">
          <span>{error}</span>
          <button type="button" className="settings-link" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </button>
        </div>
      )}

      <div className="note-editor-scroll">
        <div ref={hostRef} className="note-editor-host" />
      </div>

      <div className="organize-footer">
        {phase === 'waiting' || phase === 'streaming' ? (
          <button type="button" className="settings-btn" onClick={stop}>
            停止
          </button>
        ) : (
          <>
            <button type="button" className="settings-link organize-discard" onClick={onClose}>
              放弃
            </button>
            <button
              type="button"
              className="settings-btn primary"
              disabled={phase !== 'done' || unchanged}
              onClick={() => void confirm()}
            >
              {rewrite ? '替换' : '追加到 note'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
