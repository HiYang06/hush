import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Mark, MarkInput } from '@shared/types'
import { anchorToRange } from '@renderer/lib/anchors'
import { rangeToMarkdown } from '@renderer/lib/clip'
import { previewMark } from '@renderer/lib/highlights'
import { useAppStore, type MarkCardState } from '@renderer/stores/appStore'

const CARD_WIDTH = 300
const CARD_HEIGHT = 150

// The reply's rendered text, and where the passage is in it; null once the reply is off screen.
function passageOf(passage: Omit<MarkInput, 'comment' | 'categoryId'>): {
  body: Element
  range: Range
} | null {
  const body = document.querySelector(`#message-${CSS.escape(passage.messageId)} .markdown-body`)
  const range =
    body &&
    anchorToRange(body, {
      quote: passage.quote,
      start: passage.startOffset,
      end: passage.endOffset,
      prefix: passage.prefix,
      suffix: passage.suffix
    })
  return body && range ? { body, range } : null
}

// One card for a new mark and for an existing one (product.md §4). Enter saves and Esc discards; clicking
// elsewhere keeps an edit to an existing mark but drops a new one, which only exists once it's saved.
const MarkCardView: React.FC<{ card: MarkCardState; mark: Mark | null }> = ({ card, mark }) => {
  const categories = useAppStore((s) => s.markCategories)
  const createMark = useAppStore((s) => s.createMark)
  const updateMark = useAppStore((s) => s.updateMark)
  const deleteMark = useAppStore((s) => s.deleteMark)
  const clipToNote = useAppStore((s) => s.clipToNote)
  const closeMarkCard = useAppStore((s) => s.closeMarkCard)

  const [categoryId, setCategoryId] = useState<string | null>(
    mark ? mark.categoryId : (categories[0]?.id ?? null)
  )
  const [comment, setComment] = useState(mark?.comment ?? '')
  const [clipped, setClipped] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const patch = { comment: comment.trim() || null, categoryId }
  const changed = mark !== null && (patch.comment !== mark.comment || patch.categoryId !== mark.categoryId)

  const save = (): void => {
    if ('draft' in card) void createMark({ ...card.draft, ...patch })
    else if (changed) void updateMark(card.markId, patch)
    closeMarkCard()
  }

  // Read in the listeners below, which are set up once per card.
  const keepRef = useRef<() => void>(closeMarkCard)
  keepRef.current = changed ? save : closeMarkCard

  useEffect(() => {
    textareaRef.current?.focus()
    const onMouseDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) keepRef.current()
    }
    // The card is placed for where the text was; once the text moves, it goes.
    const onScroll = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) keepRef.current()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', closeMarkCard)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', closeMarkCard)
    }
  }, [closeMarkCard])

  const color = categories.find((c) => c.id === categoryId)?.color ?? 'amber'
  const draft = 'draft' in card ? card.draft : null
  useLayoutEffect(() => {
    const range = draft && passageOf(draft)?.range
    return range ? previewMark(range, color) : undefined
  }, [draft, color])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Esc closes the card only, not the right panel behind it (App.tsx listens on window).
      e.stopPropagation()
      closeMarkCard()
    }
  }

  const clip = (): void => {
    if (!mark) return
    const passage = passageOf(mark)
    if (!passage) return
    if (changed) void updateMark(mark.id, patch)
    const source = { messageId: mark.messageId, start: mark.startOffset, end: mark.endOffset }
    clipToNote(source, rangeToMarkdown(passage.range, passage.body), patch.comment).then(() => {
      setClipped(true)
      setTimeout(closeMarkCard, 600)
    })
  }

  const left = Math.min(Math.max(card.x - CARD_WIDTH / 2, 8), window.innerWidth - CARD_WIDTH - 8)
  const below = card.bottom + 8 + CARD_HEIGHT <= window.innerHeight
  const place = below ? { top: card.bottom + 8 } : { bottom: window.innerHeight - card.top + 8 }

  return (
    <div ref={ref} className="mark-popover" style={{ left, width: CARD_WIDTH, ...place }}>
      <div className="mark-popover-categories">
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`mark-popover-category ${c.color} ${c.id === categoryId ? 'active' : ''}`}
            onClick={() => {
              setCategoryId(c.id)
              textareaRef.current?.focus()
            }}
          >
            {c.name}
          </button>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        className="mark-popover-comment"
        rows={2}
        value={comment}
        placeholder="批注（可以不写），回车保存"
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {mark && (
        <div className="mark-popover-actions">
          <button type="button" className="mark-popover-action" onClick={clip}>
            {clipped ? '已收录' : '收录'}
          </button>
          <button
            type="button"
            className="mark-popover-action danger"
            onClick={() => {
              void deleteMark(mark.id)
              closeMarkCard()
            }}
          >
            删除
          </button>
        </div>
      )}
    </div>
  )
}

export const MarkCard: React.FC = () => {
  const card = useAppStore((s) => s.markCard)
  const mark = useAppStore((s) => {
    const open = s.markCard
    return open && 'markId' in open ? s.marks.find((m) => m.id === open.markId) : null
  })
  if (!card || mark === undefined) return null
  // A fresh card each time, so its fields start from the mark it's for.
  const key = 'markId' in card ? card.markId : `${card.draft.messageId}:${card.draft.startOffset}`
  return <MarkCardView key={key} card={card} mark={mark} />
}
