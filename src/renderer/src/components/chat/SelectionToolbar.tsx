import React, { useEffect, useRef, useState } from 'react'
import type { NoteClipSource } from '@shared/types'
import { expandToFormulas, selectionToAnchor, type Anchor } from '@renderer/lib/anchors'
import { rangeToMarkdown } from '@renderer/lib/clip'
import { useAppStore } from '@renderer/stores/appStore'

type ToolbarState = {
  rect: DOMRect
  copyText: string
  // Set when the selection is inside one reply's text and that reply can carry a thread.
  thread: { messageId: string; anchor: Anchor } | null
  // Set when the selection is inside one finished reply's text, in the main conversation or a thread.
  mark: { messageId: string; anchor: Anchor } | null
  // Set when the selection is inside one finished reply's text in a thread.
  bringBack: { messageId: string; markdown: string } | null
  // Set when the selection is inside one reply's text, in the main conversation or a thread.
  clip: { source: NoteClipSource; markdown: string } | null
}

const TOOLBAR_HEIGHT = 34

function messageOf(node: Node): HTMLElement | null {
  return (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-message-id]') ?? null
}

function bodyOf(node: Node): Element | null {
  return (node instanceof Element ? node : node.parentElement)?.closest('.markdown-body') ?? null
}

// Which buttons a selection gets follows product.md §3.
function readSelection(): ToolbarState | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  let range = selection.getRangeAt(0)
  const startMessage = messageOf(range.startContainer)
  const endMessage = messageOf(range.endContainer)
  if (!startMessage || !endMessage) return null

  if (startMessage !== endMessage) {
    return { rect: range.getBoundingClientRect(), copyText: selection.toString(), thread: null, mark: null, bringBack: null, clip: null }
  }
  if (startMessage.dataset.role !== 'assistant') return null

  const body = bodyOf(range.startContainer)
  if (!body || body !== bodyOf(range.endContainer)) {
    return { rect: range.getBoundingClientRect(), copyText: selection.toString(), thread: null, mark: null, bringBack: null, clip: null }
  }

  const expanded = expandToFormulas(range)
  if (expanded.compareBoundaryPoints(Range.START_TO_START, range) !== 0 ||
      expanded.compareBoundaryPoints(Range.END_TO_END, range) !== 0) {
    selection.removeAllRanges()
    selection.addRange(expanded)
    range = expanded
  }
  const anchor = selectionToAnchor(body, range)
  if (!anchor) return null

  // A reply still being written moves under the anchor; a failed one isn't in a fork's context;
  // and threads are one level deep (D-006).
  const status = startMessage.dataset.status
  const threadable =
    startMessage.dataset.inThread === undefined && (status === 'done' || status === 'stopped')
  const messageId = startMessage.dataset.messageId!
  const markdown = rangeToMarkdown(range, body)
  return {
    rect: range.getBoundingClientRect(),
    copyText: anchor.quote,
    thread: threadable ? { messageId, anchor } : null,
    // Marks aren't drawn on a reply still being written, so one made there wouldn't show.
    mark: status === 'streaming' ? null : { messageId, anchor },
    bringBack:
      startMessage.dataset.inThread !== undefined && status !== 'streaming' ? { messageId, markdown } : null,
    clip: { source: { messageId, start: anchor.start, end: anchor.end }, markdown }
  }
}

export const SelectionToolbar: React.FC = () => {
  const [state, setState] = useState<ToolbarState | null>(null)
  // Which button just did its job; the toolbar says so briefly, then closes.
  const [done, setDone] = useState<'copy' | 'clip' | 'bringBack' | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const startDraftThread = useAppStore((s) => s.startDraftThread)
  const clipToNote = useAppStore((s) => s.clipToNote)
  const marks = useAppStore((s) => s.marks)
  const openMarkCard = useAppStore((s) => s.openMarkCard)
  const bringBack = useAppStore((s) => s.bringBack)

  useEffect(() => {
    const onMouseUp = (e: MouseEvent): void => {
      if (ref.current?.contains(e.target as Node)) return
      // After the click has had its effect on the selection (a plain click collapses it).
      setTimeout(() => {
        setDone(null)
        setState(readSelection())
      }, 0)
    }
    const onSelectionChange = (): void => {
      if (window.getSelection()?.isCollapsed) setState(null)
    }
    // The toolbar is placed for where the text was; once the text moves, it's simply dismissed.
    const dismiss = (): void => setState(null)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [])

  if (!state) return null

  const { rect } = state
  const above = rect.top - TOOLBAR_HEIGHT - 8
  const top = above >= 8 ? above : rect.bottom + 8
  const left = Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80)

  const close = (): void => {
    window.getSelection()?.removeAllRanges()
    setState(null)
  }

  // Marks never overlap, so a selection touching one edits it instead (product.md §3): the first one it touches.
  const touched = state.mark
    ? marks
        .filter(
          (m) =>
            m.messageId === state.mark!.messageId &&
            m.startOffset < state.mark!.anchor.end &&
            m.endOffset > state.mark!.anchor.start
        )
        .sort((a, b) => a.startOffset - b.startOffset)[0]
    : undefined

  return (
    <div
      ref={ref}
      className="selection-toolbar"
      style={{ top, left }}
      // Keeps the selection alive while a button is pressed.
      onMouseDown={(e) => e.preventDefault()}
    >
      {state.mark && (
        <button
          type="button"
          className="selection-toolbar-btn"
          onClick={() => {
            const { messageId, anchor } = state.mark!
            const place = { x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom }
            close()
            openMarkCard(
              touched
                ? { ...place, markId: touched.id }
                : {
                    ...place,
                    draft: {
                      messageId,
                      quote: anchor.quote,
                      startOffset: anchor.start,
                      endOffset: anchor.end,
                      prefix: anchor.prefix,
                      suffix: anchor.suffix
                    }
                  }
            )
          }}
        >
          {touched ? '编辑 mark' : 'Mark'}
        </button>
      )}
      {state.bringBack && (
        <button
          type="button"
          className="selection-toolbar-btn"
          onClick={() => {
            bringBack(state.bringBack!.messageId, state.bringBack!.markdown)
            setDone('bringBack')
            setTimeout(close, 600)
          }}
        >
          {done === 'bringBack' ? '已带回' : '带回'}
        </button>
      )}
      {state.thread && activeSessionId && (
        <button
          type="button"
          className="selection-toolbar-btn"
          onClick={() => {
            const { messageId, anchor } = state.thread!
            startDraftThread({
              parentSessionId: activeSessionId,
              anchorMessageId: messageId,
              anchorQuote: anchor.quote,
              anchorStart: anchor.start,
              anchorEnd: anchor.end,
              anchorPrefix: anchor.prefix,
              anchorSuffix: anchor.suffix
            })
            close()
          }}
        >
          追问
        </button>
      )}
      {state.clip && (
        <button
          type="button"
          className="selection-toolbar-btn"
          onClick={() => {
            const { source, markdown } = state.clip!
            clipToNote(source, markdown).then(() => {
              setDone('clip')
              setTimeout(close, 600)
            })
          }}
        >
          {done === 'clip' ? '已收录' : '收录到 note'}
        </button>
      )}
      <button
        type="button"
        className="selection-toolbar-btn"
        onClick={() => {
          navigator.clipboard.writeText(state.copyText).then(() => {
            setDone('copy')
            setTimeout(close, 600)
          })
        }}
      >
        {done === 'copy' ? '已复制' : '复制'}
      </button>
    </div>
  )
}
