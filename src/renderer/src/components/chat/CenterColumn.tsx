import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Mark, NoteClipSource, ThreadSession } from '@shared/types'
import { streamingReplyIn, useAppStore } from '@renderer/stores/appStore'
import { BookmarkIcon, NotePageIcon } from '@renderer/components/common/Icons'
import { MessageItem } from './MessageItem'
import { ChatInputBox } from './ChatInputBox'
import { RoundRail } from './RoundRail'
import { aimScroll } from '../../lib/aimScroll'
const NoteView = React.lazy(() => import('@renderer/components/note-editor/NoteView').then((m) => ({ default: m.NoteView })))

const NO_MARKS: Mark[] = []
const NO_THREADS: ThreadSession[] = []
const NO_CLIPS: NoteClipSource[] = []
// Space left above a newly sent question once it's scrolled to the top.
const QUESTION_TOP_GAP = 18

function groupByMessage<T>(items: T[], messageIdOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const id = messageIdOf(item)
    map.set(id, [...(map.get(id) ?? []), item])
  }
  return map
}

const CenterHeader: React.FC<{ title: string; actions: boolean }> = ({ title, actions }) => {
  const leftSidebarOpen = useAppStore((s) => s.leftSidebarOpen)
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const rightPanelTab = useAppStore((s) => s.rightPanelTab)
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel)
  const noteExpandedToCenter = useAppStore((s) => s.noteExpandedToCenter)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const markCount = useAppStore(
    (s) => s.marks.filter((m) => m.sessionId === activeSessionId).length
  )
  const openSessionNote = useAppStore((s) => s.openSessionNote)

  const isMarkActive = rightPanelOpen && rightPanelTab === 'mark'
  const isNoteActive = noteExpandedToCenter || (rightPanelOpen && rightPanelTab === 'note')

  return (
    <header
      className={`center-header drag-region ${leftSidebarOpen ? '' : 'sidebar-hidden'} ${rightPanelOpen ? '' : 'rightmost'}`}
    >
      <div className="center-header-title" title={title}>
        {title}
      </div>
      {actions && (
        <div className="center-header-actions no-drag">
          <div className="header-action-plaque">
            <button
              type="button"
              className={`header-plaque-btn ${isMarkActive ? 'active' : ''}`}
              onClick={() => toggleRightPanel('mark')}
              title="查看本会话的 Mark"
            >
              <BookmarkIcon size={13} />
              <span>Mark</span>
              {markCount > 0 && (
                <span className="header-pill-count">{markCount}</span>
              )}
            </button>
            <button
              type="button"
              className={`header-plaque-btn has-divider ${isNoteActive ? 'active' : ''}`}
              onClick={openSessionNote}
              title="打开当前会话对应的 Note"
            >
              <NotePageIcon size={13} />
              <span>Note</span>
            </button>
          </div>
        </div>
      )}
    </header>
  )
}

export const CenterColumn: React.FC = () => {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const expanded = useAppStore((s) => s.noteExpandedToCenter)
  const title = useAppStore((s) => s.sessions.find((session) => session.id === s.activeSessionId)?.title ?? '新对话')
  if (expanded) return (
    <main className="center-column">
      <CenterHeader title={title} actions />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <React.Suspense fallback={<div style={{ height: '100%', background: 'var(--bg-paper-base)' }} />}>
          <NoteView />
        </React.Suspense>
      </div>
    </main>
  )
  return <Conversation key={activeSessionId ?? 'new'} />
}

const Conversation: React.FC = () => {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const lastReplyRef = useRef<HTMLDivElement | null>(null)
  const [hasUnseenBelow, setHasUnseenBelow] = useState(false)

  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const messages = useAppStore((s) => s.messages)
  const marks = useAppStore((s) => s.marks)
  const noteClips = useAppStore((s) => s.noteClips)
  const markCategories = useAppStore((s) => s.markCategories)
  const files = useAppStore((s) => s.files)
  const lastScrolledUserMessageId = useAppStore(
    (s) => s.lastScrolledUserMessageId
  )
  const highlightedMessageId = useAppStore((s) => s.highlightedMessageId)
  const newSessionProject = useAppStore((s) => s.projects.find((p) => p.id === s.newSessionProjectId))
  const providersLoaded = useAppStore((s) => s.providersLoaded)
  const hasProvider = useAppStore((s) => s.providers.length > 0)
  const hasModel = useAppStore((s) => s.models.some((m) => m.enabled))
  const openSettings = useAppStore((s) => s.openSettings)

  const openSessionNote = useAppStore((s) => s.openSessionNote)
  const selectThread = useAppStore((s) => s.selectThread)
  const jumpToMessage = useAppStore((s) => s.jumpToMessage)
  const openNoteClip = useAppStore((s) => s.openNoteClip)
  const openMarkCard = useAppStore((s) => s.openMarkCard)

  const currentSession = useMemo(
    () =>
      sessions.find((s) => s.id === activeSessionId && s.kind === 'main') ??
      null,
    [activeSessionId, sessions]
  )

  const sessionMessages = useMemo(() => {
    if (!activeSessionId) return []
    return messages
      .filter((m) => m.sessionId === activeSessionId)
      .sort((a, b) => a.seq - b.seq)
  }, [activeSessionId, messages])

  const sessionMarks = useMemo(
    () => marks.filter((m) => m.sessionId === activeSessionId),
    [activeSessionId, marks]
  )

  const sessionThreads = useMemo(
    () =>
      sessions.filter(
        (s): s is ThreadSession =>
          s.kind === 'thread' && s.parentSessionId === activeSessionId
      ),
    [activeSessionId, sessions]
  )

  // Stable per-message props let React.memo skip finished messages while one is streaming.
  const marksByMessage = useMemo(
    () => groupByMessage(sessionMarks, (m) => m.messageId),
    [sessionMarks]
  )
  const threadsByMessage = useMemo(
    () => groupByMessage(sessionThreads, (t) => t.anchorMessageId),
    [sessionThreads]
  )
  const clipsByMessage = useMemo(
    () => groupByMessage(noteClips?.clips ?? NO_CLIPS, (c) => c.messageId),
    [noteClips]
  )
  const loading = useAppStore((s) => activeSessionId ? s.loadingConversations[activeSessionId] : false)
  const messageJump = useAppStore((s) => s.messageJump)
  const initialized = useRef(false)
  const fittedQuestionId = useRef(activeSessionId ? useAppStore.getState().readingPositions[activeSessionId]?.sentQuestionId ?? null : null)
  if (lastScrolledUserMessageId) fittedQuestionId.current = lastScrolledUserMessageId

  // Store a visible message and its offset, rather than just scrollTop: off-screen placeholders can
  // have different heights when the conversation mounts again.
  const savePosition = (): void => {
    const scroller = scrollContainerRef.current
    if (!scroller || !activeSessionId || !initialized.current) return
    const top = scroller.getBoundingClientRect().top
    const items = Array.from(scroller.querySelectorAll<HTMLElement>('.message-item'))
    const anchor = items.find((item) => item.getBoundingClientRect().bottom > top) ?? items.at(-1)
    if (!anchor) return
    useAppStore.getState().saveReadingPosition(activeSessionId, {
      messageId: anchor.id.slice('message-'.length),
      offset: anchor.getBoundingClientRect().top - top,
      scrollTop: scroller.scrollTop,
      sentQuestionId: fittedQuestionId.current
    })
  }
  const savePositionRef = useRef(savePosition)
  savePositionRef.current = savePosition
  useLayoutEffect(() => () => {
    initialized.current = false
  }, [])

  const fittedId = fittedQuestionId.current
  const lastMessageId = sessionMessages.at(-1)?.id
  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current
    const question = fittedQuestionId.current ? document.getElementById(`message-${fittedQuestionId.current}`) : null
    const reply = lastReplyRef.current
    if (!scroller || !question || !reply) return
    const fit = (): void => {
      const above = reply.getBoundingClientRect().top - question.getBoundingClientRect().top
      const paddingBottom = parseFloat(getComputedStyle(scroller).paddingBottom)
      reply.style.minHeight = `${Math.max(0, scroller.clientHeight - QUESTION_TOP_GAP - paddingBottom - above)}px`
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(scroller)
    observer.observe(question)
    return () => {
      observer.disconnect()
      reply.style.minHeight = ''
    }
  }, [currentSession?.id, fittedId, lastMessageId])

  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current
    if (!scroller || !activeSessionId || loading || sessionMessages.length === 0) return
    const saved = useAppStore.getState().readingPositions[activeSessionId]
    const opening = !initialized.current
    initialized.current = true
    const question = fittedQuestionId.current ? document.getElementById(`message-${fittedQuestionId.current}`) : null

    const sent = lastScrolledUserMessageId && question && saved?.sentQuestionId !== lastScrolledUserMessageId
    const lastQuestion = [...sessionMessages].reverse().find((msg) => msg.role === 'user')
    const restored = opening && saved ? document.getElementById(`message-${saved.messageId}`) : null
    const target = sent ? question : opening ? restored ?? (lastQuestion ? document.getElementById(`message-${lastQuestion.id}`) : null) : null
    const gap = !sent && restored && saved ? saved.offset : QUESTION_TOP_GAP
    if (!messageJump && !highlightedMessageId && target) {
      return aimScroll(scroller, target,
        () => target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - gap,
        { onSettled: () => savePositionRef.current() })
    }
  }, [activeSessionId, loading, lastScrolledUserMessageId, messageJump, highlightedMessageId, sessionMessages.length])

  // Check if streaming content extends below the visible viewport
  const streamingMsg = useMemo(
    () => streamingReplyIn(sessionMessages, activeSessionId) ?? null,
    [sessionMessages, activeSessionId]
  )

  useEffect(() => {
    const container = scrollContainerRef.current
    const endEl = messagesEndRef.current
    if (!container || !endEl || !streamingMsg) return

    const containerRect = container.getBoundingClientRect()
    const endRect = endEl.getBoundingClientRect()

    if (endRect.top > containerRect.bottom + 16) {
      setHasUnseenBelow(true)
    }
  }, [streamingMsg?.content, streamingMsg?.thinking, streamingMsg])

  // Scroll to highlighted message when clicked from Mark or Note
  useEffect(() => {
    if (!highlightedMessageId || loading) return
    const el = document.getElementById(`message-${highlightedMessageId}`)
    const scroller = scrollContainerRef.current
    if (el && scroller) {
      return aimScroll(scroller, el,
        () => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - QUESTION_TOP_GAP,
        { onSettled: () => savePositionRef.current() })
    }
  }, [highlightedMessageId, loading])

  const handleScroll = (): void => {
    savePosition()
    const container = scrollContainerRef.current
    const endEl = messagesEndRef.current
    if (!container || !endEl) return

    const containerRect = container.getBoundingClientRect()
    const endRect = endEl.getBoundingClientRect()

    if (endRect.top <= containerRect.bottom + 24) {
      setHasUnseenBelow(false)
    } else if (streamingMsg) {
      setHasUnseenBelow(true)
    }
  }

  const scrollToNewContent = (): void => {
    const container = scrollContainerRef.current
    const endEl = messagesEndRef.current
    if (!container || !endEl) return
    const containerRect = container.getBoundingClientRect()
    const endRect = endEl.getBoundingClientRect()
    const delta = endRect.top - containerRect.bottom + 48
    container.scrollBy({ top: delta, behavior: 'smooth' })
    setHasUnseenBelow(false)
  }

  // Blank new conversation view: only centered input box
  if (!activeSessionId || !currentSession) {
    return (
      <main className="center-column">
        <CenterHeader title={newSessionProject ? `${newSessionProject.name} · 新对话` : '新对话'} actions={false} />

        <div className="chat-input-centered-empty">
          {hasModel ? (
            <ChatInputBox />
          ) : !providersLoaded ? null : (
            <div className="first-run">
              <p>{hasProvider ? '还没有可用的模型，添加一个就能开始对话。' : '先接上一个模型服务商，就能开始对话。'}</p>
              <button
                type="button"
                className="settings-btn primary"
                onClick={hasProvider ? openSettings : () => useAppStore.getState().setOnboardingOpen(true)}
              >
                {hasProvider ? '添加模型' : '开始设置'}
              </button>
            </div>
          )}
        </div>
      </main>
    )
  }

  return (
    <main className="center-column">
      <CenterHeader title={currentSession.title} actions />

      <div className="chat-scroll-area" style={{ visibility: loading && !initialized.current ? 'hidden' : undefined }}>
        <div
          ref={scrollContainerRef}
          className="chat-scroll-container"
          onScroll={handleScroll}
        >
          <div className="chat-column-inner">
            {sessionMessages.map((msg, idx) => {
              const isLastRound = idx >= sessionMessages.length - 2
              const isLastAssistantAfterSend =
                Boolean(fittedQuestionId.current) &&
                idx === sessionMessages.length - 1 &&
                msg.role === 'assistant'

              return (
                <div key={msg.id} ref={isLastAssistantAfterSend ? lastReplyRef : undefined}>
                  <MessageItem
                    message={msg}
                    isLastRound={isLastRound}
                    isHighlighted={highlightedMessageId === msg.id}
                    marks={marksByMessage.get(msg.id) ?? NO_MARKS}
                    categories={markCategories}
                    threads={threadsByMessage.get(msg.id) ?? NO_THREADS}
                    clips={clipsByMessage.get(msg.id) ?? NO_CLIPS}
                    files={files}
                    onSelectThread={selectThread}
                    onSelectMark={openMarkCard}
                    onSelectClip={openNoteClip}
                    onOpenNote={openSessionNote}
                    onJumpToMessage={jumpToMessage}
                  />
                  {idx === sessionMessages.length - 1 && (
                    <div ref={messagesEndRef} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
        <RoundRail messages={sessionMessages} scrollerRef={scrollContainerRef} topGap={QUESTION_TOP_GAP} />
      </div>

      <div className="chat-input-outer">
        {hasUnseenBelow && (
          <div className="new-content-pill-wrapper">
            <button
              type="button"
              className="new-content-pill"
              onClick={scrollToNewContent}
            >
              ↓ 新内容
            </button>
          </div>
        )}
        <ChatInputBox />
      </div>
    </main>
  )
}
