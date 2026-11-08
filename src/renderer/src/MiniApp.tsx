import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { streamingReplyIn, useAppStore } from '@renderer/stores/appStore'
import { MessageItem } from '@renderer/components/chat/MessageItem'
import { ChatInputBox } from '@renderer/components/chat/ChatInputBox'
import { shouldStartFresh } from '@renderer/lib/mini'

// Space left above a newly sent question once it's scrolled to the top, as in the main window.
const QUESTION_TOP_GAP = 14

const focusInput = (): void => {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.mini-input textarea')?.focus())
}

// Only asking and reading: no marks, threads or notes here (D-079).
export const MiniApp: React.FC = () => {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const session = useAppStore((s) => s.sessions.find((x) => x.id === s.activeSessionId && x.kind === 'main'))
  const messages = useAppStore((s) => s.messages)
  const files = useAppStore((s) => s.files)
  const lastScrolledUserMessageId = useAppStore((s) => s.lastScrolledUserMessageId)
  const providersLoaded = useAppStore((s) => s.providersLoaded)
  const hasModel = useAppStore((s) => s.models.some((m) => m.enabled))
  const startNewSession = useAppStore((s) => s.startNewSession)

  // Until the first show; the page then caps itself so it can measure its own height.
  const [maxHeight, setMaxHeight] = useState(560)
  const hiddenAt = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const headerRef = useRef<HTMLElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLDivElement | null>(null)
  const lastReplyRef = useRef<HTMLDivElement | null>(null)

  const sessionMessages = useMemo(
    () =>
      activeSessionId
        ? messages.filter((m) => m.sessionId === activeSessionId).sort((a, b) => a.seq - b.seq)
        : [],
    [activeSessionId, messages]
  )

  useEffect(() => {
    const offShown = window.api.on('mini:shown', ({ maxHeight }) => {
      setMaxHeight(maxHeight)
      // Models and search keys may have changed in the main window's settings since it was last shown.
      void useAppStore.getState().reloadProviders()
      void useAppStore.getState().reloadSearchServices()
      const { messages, activeSessionId } = useAppStore.getState()
      const streaming = Boolean(streamingReplyIn(messages, activeSessionId))
      if (shouldStartFresh(hiddenAt.current, Date.now(), streaming)) useAppStore.getState().startNewSession()
      hiddenAt.current = null
      focusInput()
    })
    const offHidden = window.api.on('mini:hidden', () => {
      hiddenAt.current = Date.now()
    })
    return () => {
      offShown()
      offHidden()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        void window.api.invoke('mini:hide')
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        startNewSession()
        focusInput()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [startNewSession])

  // The page's height is its content's, up to maxHeight; the window follows it.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(() => {
      void window.api.invoke('mini:resize', Math.ceil(root.getBoundingClientRect().height))
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // From the second question on, the window is at its full height and the new question is scrolled to the
  // top, with room below it for the reply (product.md: 滚动). The first question already is at the top.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const reply = lastReplyRef.current
    const question = lastScrolledUserMessageId && document.getElementById(`message-${lastScrolledUserMessageId}`)
    if (!scroller || !reply || !question || sessionMessages.length <= 2) return
    const style = getComputedStyle(scroller)
    const chrome =
      (headerRef.current?.offsetHeight ?? 0) +
      (inputRef.current?.offsetHeight ?? 0) +
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom)
    const above = reply.getBoundingClientRect().top - question.getBoundingClientRect().top
    reply.style.minHeight = `${Math.max(0, maxHeight - chrome - QUESTION_TOP_GAP - above)}px`
    const raf = requestAnimationFrame(() => {
      scroller.scrollTop += question.getBoundingClientRect().top - scroller.getBoundingClientRect().top - QUESTION_TOP_GAP
    })
    return () => {
      cancelAnimationFrame(raf)
      reply.style.minHeight = ''
    }
    // Only when a question is sent, not on every streamed delta.
  }, [lastScrolledUserMessageId])

  return (
    <div ref={rootRef} className="mini-app" style={{ maxHeight }}>
      <header ref={headerRef} className="mini-header drag-region">
        <div className="mini-title">{session?.title ?? '小窗提问'}</div>
        {session && (
          <button
            type="button"
            className="mini-open-main no-drag"
            onClick={() => void window.api.invoke('mini:openInMain', session.id)}
          >
            在主窗口打开
          </button>
        )}
      </header>

      {sessionMessages.length > 0 && (
        <div ref={scrollerRef} className="mini-scroll">
          {sessionMessages.map((msg, idx) => (
            <div key={msg.id} ref={idx === sessionMessages.length - 1 && msg.role === 'assistant' ? lastReplyRef : undefined}>
              <MessageItem message={msg} isLastRound={idx >= sessionMessages.length - 2} files={files} />
            </div>
          ))}
        </div>
      )}

      <div ref={inputRef} className="mini-input">
        {hasModel ? (
          <ChatInputBox refs={false} canOpenSettings={false} placeholder="问点什么，Enter 发送，Esc 收起" />
        ) : (
          providersLoaded && <p className="mini-empty">还没有可用的模型，先在 Hush 的设置里添加。</p>
        )}
      </div>
    </div>
  )
}
