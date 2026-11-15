import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isFull, NOTHING_REASONS, shouldAutoCompact } from '@shared/compact'
import { useDismiss } from '@renderer/components/common/useDismiss'
import type { ContextUsage } from '@shared/types'
import { formatTokens } from '@renderer/lib/tokens'
import { useAppStore } from '@renderer/stores/appStore'

const RING_RADIUS = 6.5
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

// The ring by the send button and its card: how full the context is, and 压缩 (D-087).
export const ContextMeter: React.FC<{ sessionId: string; modelId: string }> = ({ sessionId, modelId }) => {
  const state = useAppStore((s) => s.compactStates[sessionId])
  // A fork thread starts from its main session's summary, so that one compacting moves the thread's usage too.
  const { compactedAt, parentCompactedAt } = useAppStore(
    useShallow((s) => {
      const session = s.sessions.find((x) => x.id === sessionId)
      const parent = session?.parentSessionId ? s.sessions.find((x) => x.id === session.parentSessionId) : undefined
      return {
        compactedAt: session?.compactedAt ?? null,
        parentCompactedAt: parent?.compactedAt ?? null
      }
    })
  )
  // Changes whenever a reply in this conversation starts or ends, which is when the usage moves.
  const replies = useAppStore((s) =>
    s.messages.filter((m) => m.sessionId === sessionId).map((m) => `${m.id}:${m.status}`).join()
  )
  const cardRequested = useAppStore((s) => s.contextCardFor === sessionId)
  const openContextCard = useAppStore((s) => s.openContextCard)
  const compactSession = useAppStore((s) => s.compactSession)
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const [open, setOpen] = useState(false)
  const [showSummary, setShowSummary] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const running = state?.status === 'running'

  useEffect(() => {
    let current = true
    void window.api.invoke('compact:usage', sessionId, modelId).then((u) => current && setUsage(u))
    return () => {
      current = false
    }
  }, [sessionId, modelId, replies, compactedAt, parentCompactedAt, running])

  useEffect(() => {
    if (!cardRequested) return
    setOpen(true)
    openContextCard(null)
  }, [cardRequested, openContextCard])

  const close = useCallback(() => setOpen(false), [])
  useDismiss(rootRef, open, close)

  if (!usage) return null
  const share = usage.window === null ? 0 : Math.min(usage.tokens / usage.window, 1)
  const full = isFull(usage)
  const littleToFree = full && !shouldAutoCompact(usage)
  const nothing = usage.nothingReason !== null

  return (
    <div className="context-meter" ref={rootRef}>
      <button
        type="button"
        className={`context-meter-btn ${full ? 'full' : ''} ${running ? 'running' : ''} ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="上下文"
        aria-expanded={open}
        title={usage.window === null ? '上下文' : `上下文用了 ${Math.round(share * 100)}%`}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle className="context-ring-track" cx="8" cy="8" r={RING_RADIUS} />
          <circle
            className="context-ring-fill"
            cx="8"
            cy="8"
            r={RING_RADIUS}
            strokeDasharray={running ? `${RING_LENGTH * 0.25} ${RING_LENGTH}` : `${RING_LENGTH * share} ${RING_LENGTH}`}
          />
        </svg>
      </button>

      {open && (
        <div className="chat-meta-popover context-card">
          <div className="context-card-usage">
            <span>上下文</span>
            <span className="num">
              约 {usage.tokens.toLocaleString()}
              {usage.window !== null && ` / ${formatTokens(usage.window)}（${Math.round(share * 100)}%）`}
            </span>
          </div>
          {usage.window === null ? (
            <p className="context-card-note">这个模型没填上下文窗口，不会自动压缩。</p>
          ) : (
            <div className={`context-card-bar ${full ? 'full' : ''}`}>
              <div style={{ width: `${share * 100}%` }} />
            </div>
          )}
          {usage.summary !== null && (
            <p className="context-card-note">
              已压缩：模型看到的是前面对话的摘要，和之后的原文。
              <button type="button" className="settings-link" onClick={() => setShowSummary((v) => !v)}>
                {showSummary ? '收起摘要' : '查看摘要'}
              </button>
            </p>
          )}
          {showSummary && usage.summary !== null && <div className="context-card-summary">{usage.summary}</div>}
          {littleToFree && !nothing && <p className="context-card-note">主要是附件占的，压缩省不了多少。</p>}
          {usage.nothingReason && <p className="context-card-note">{NOTHING_REASONS[usage.nothingReason]}</p>}
          {state?.status === 'error' && <p className="context-card-note error">压缩失败：{state.error}</p>}
          <div className="context-card-actions">
            {running && <span className="context-card-note">正在压缩，可以继续聊</span>}
            <button type="button" className="message-action-btn" disabled={running || nothing} onClick={() => void compactSession(sessionId)}>
              {state?.status === 'error' ? '重试' : '压缩'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Below the last compacted reply: from here up, the model only has the summary. Opens the session's context card.
export const CompactDivider: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const openContextCard = useAppStore((s) => s.openContextCard)
  return (
    <button type="button" className="compact-divider" onClick={() => openContextCard(sessionId)} title="查看上下文">
      <span>已压缩</span>
    </button>
  )
}
