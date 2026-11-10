import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '@shared/types'
import { aimScroll } from '../../lib/aimScroll'

const ROW = 8
const MIN_ROW = 2
const RAIL_PADDING = 24
const MIN_TICK = 4
const MAX_TICK = 18
// Linear, not sqrt: real answers mostly run 1–4k characters, and sqrt squeezed them all near the cap.
const FULL_LENGTH_CHARS = 8000
const MAGNIFY_RADIUS = 40
const MAGNIFY_EXTRA = 14

type Round = { questionId: string; question: string; answer: string; length: number }

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim()

// The card only has room for a glimpse, so markdown markers are dropped rather than rendered. Some models
// leave a <thinking> block in the content, which isn't part of the answer.
const plainStart = (markdown: string): string =>
  flatten(
    markdown
      .slice(0, 400)
      .replace(/<thinking>(?:[\s\S]*?<\/thinking>|[\s\S]*$)|<[^>]+>/g, ' ')
      .replace(/[#>*_`~|]+|-{3,}|^\s*[-+]\s|\[\^?\d+\]/gm, ' ')
  )

export function createRoundSummaries(): (messages: Message[]) => Round[] {
  const cache = new WeakMap<Message, { replies: Message[]; round: Round }>()
  return (messages) => {
    const rounds: Round[] = []
    for (let i = 0; i < messages.length;) {
      const question = messages[i++]
      if (question.role !== 'user') continue
      const replies: Message[] = []
      while (i < messages.length && messages[i].role !== 'user') replies.push(messages[i++])
      const previous = cache.get(question)
      if (previous && previous.replies.length === replies.length &&
        replies.every((reply, index) => reply === previous.replies[index])) {
        rounds.push(previous.round)
        continue
      }
      const chars = replies.reduce((sum, reply) => sum + reply.content.length, question.content.length)
      const round = {
        questionId: question.id,
        question: previous?.round.question ?? (flatten(question.content) || '（附件）'),
        answer: replies.length ? plainStart(replies[replies.length - 1].content) : '',
        length: MIN_TICK + Math.min(1, chars / FULL_LENGTH_CHARS) * (MAX_TICK - MIN_TICK)
      }
      cache.set(question, { replies, round })
      rounds.push(round)
    }
    return rounds
  }
}

function questionEl(id: string): HTMLElement | null {
  return document.getElementById(`message-${id}`)
}

export const RoundRail: React.FC<{
  messages: Message[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
  topGap: number
}> = ({ messages, scrollerRef, topGap }) => {
  const railRef = useRef<HTMLDivElement | null>(null)
  const stopAimingRef = useRef<() => void>(() => {})
  const [railHeight, setRailHeight] = useState(0)
  const [current, setCurrent] = useState(-1)
  const [pointerY, setPointerY] = useState<number | null>(null)

  const [roundsOf] = useState(createRoundSummaries)
  const rounds = useMemo(() => roundsOf(messages), [messages, roundsOf])
  const questionIds = JSON.stringify(rounds.map((round) => round.questionId))
  const row = Math.max(MIN_ROW, Math.min(ROW, (railHeight - RAIL_PADDING * 2) / Math.max(1, rounds.length)))

  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const observer = new ResizeObserver(() => setRailHeight(rail.clientHeight))
    observer.observe(rail)
    return () => observer.disconnect()
  }, [rounds.length > 1])

  useEffect(() => {
    const scroller = scrollerRef.current
    const ids: string[] = JSON.parse(questionIds)
    if (!scroller || ids.length < 2) return
    let raf = 0
    const update = (): void => {
      raf = 0
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
      if (atBottom) return setCurrent(ids.length - 1)
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3
      let index = 0
      for (let i = 0; i < ids.length; i++) {
        const el = questionEl(ids[i])
        if (el && el.getBoundingClientRect().top <= line) index = i
        else if (el) break
      }
      setCurrent(index)
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller)
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild)
    update()
    scroller.addEventListener('scroll', schedule, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', schedule)
      cancelAnimationFrame(raf)
    }
  }, [questionIds, scrollerRef])

  useEffect(() => () => stopAimingRef.current(), [])

  const jumpTo = (questionId: string): void => {
    const scroller = scrollerRef.current
    const target = questionEl(questionId)
    if (!scroller || !target) return
    stopAimingRef.current()
    stopAimingRef.current = aimScroll(scroller, target,
      () => target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topGap,
      { ease: 0.2 })
  }

  if (rounds.length < 2) return null

  const columnHeight = row * rounds.length
  const indexAt = (y: number): number => Math.min(rounds.length - 1, Math.max(0, Math.floor(y / row)))
  const nearest = pointerY === null ? -1 : indexAt(pointerY)
  const tickHeight = Math.min(2, row / 2)

  return (
    <div ref={railRef} className="round-rail">
      <div
        className="round-rail-column"
        style={{ height: columnHeight }}
        aria-label="轮次定位"
        onPointerMove={(e) => setPointerY(e.clientY - e.currentTarget.getBoundingClientRect().top)}
        onPointerLeave={() => setPointerY(null)}
        onClick={(e) =>
          jumpTo(rounds[indexAt(e.clientY - e.currentTarget.getBoundingClientRect().top)].questionId)
        }
      >
        {rounds.map((round, i) => {
          const distance = pointerY === null ? Infinity : Math.abs(pointerY - (i + 0.5) * row)
          const t = Math.max(0, 1 - distance / MAGNIFY_RADIUS)
          const ease = (1 - Math.cos(Math.PI * t)) / 2
          const base = i === current ? 1 : 0.35
          return (
            <div key={round.questionId} className="round-rail-row" style={{ height: row }}>
              <div
                className="round-rail-tick"
                style={{
                  width: round.length,
                  height: tickHeight,
                  transform: `scaleX(${(round.length + ease * MAGNIFY_EXTRA) / round.length})`,
                  opacity: base + (1 - base) * ease
                }}
              />
            </div>
          )
        })}
      </div>
      {nearest >= 0 && (
        <div
          className="round-rail-preview"
          style={{ top: `calc(50% - ${columnHeight / 2}px + ${(nearest + 0.5) * row}px)` }}
        >
          <div className="round-rail-question">{rounds[nearest].question}</div>
          {rounds[nearest].answer && (
            <div className="round-rail-answer">{rounds[nearest].answer}</div>
          )}
        </div>
      )}
    </div>
  )
}
