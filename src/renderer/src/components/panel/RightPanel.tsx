import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Mark, Message, NoteClipSource, ThreadContextMode, ThreadSession } from '@shared/types'
import { ContextMenu } from '@renderer/components/common/ContextMenu'
import { useAppStore, type RightPanelTab } from '@renderer/stores/appStore'
import { modKey, rightPanelMinWidth } from '@renderer/lib/platform'
import {
  BookmarkIcon,
  CollapsePanelIcon,
  NotePageIcon,
  PaperclipIcon,
  ThreadBranchIcon
} from '@renderer/components/common/Icons'
import { MessageItem } from '@renderer/components/chat/MessageItem'
import { ChatInputBox } from '@renderer/components/chat/ChatInputBox'
import { NoteView } from '@renderer/components/note-editor/NoteView'
import { FileTab } from './FilePreview'

const NO_MARKS: Mark[] = []
const NO_CLIPS: NoteClipSource[] = []
// The seeded 疑问 category; matched by id so renaming it keeps the button.
const QUESTION_CATEGORY_ID = 'cat-question'

const ThreadModeSwitch: React.FC<{
  mode: ThreadContextMode
  onChange?: (mode: ThreadContextMode) => void
}> = ({ mode, onChange }) => (
  <div className="thread-mode-row">
    <span>{onChange ? '发出第一条消息后固定' : mode === 'fork' ? '带着主对话的上下文' : '只带这段原文'}</span>
    <div className="thread-mode-segmented">
      {(['fork', 'new'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className={`thread-mode-option ${mode === m ? 'active' : ''}`}
          disabled={!onChange}
          title={m === 'fork' ? '带上主对话到这条回答为止的全部内容' : '只带选中的这段原文'}
          onClick={() => onChange?.(m)}
        >
          {m === 'fork' ? 'Fork' : 'New'}
        </button>
      ))}
    </div>
  </div>
)

const ThreadTab: React.FC = () => {
  const [menu, setMenu] = useState<{ x: number; y: number; thread: ThreadSession } | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const draftThread = useAppStore((s) => s.draftThread)
  const sessions = useAppStore((s) => s.sessions)
  const messages = useAppStore((s) => s.messages)
  const marks = useAppStore((s) => s.marks)
  const noteClips = useAppStore((s) => s.noteClips)
  const markCategories = useAppStore((s) => s.markCategories)
  const files = useAppStore((s) => s.files)
  const openNoteClip = useAppStore((s) => s.openNoteClip)
  const selectThread = useAppStore((s) => s.selectThread)
  const setDraftThreadMode = useAppStore((s) => s.setDraftThreadMode)
  const deleteThread = useAppStore((s) => s.deleteThread)
  const openMarkCard = useAppStore((s) => s.openMarkCard)
  const bringBack = useAppStore((s) => s.bringBack)
  const bringBackWhole = useCallback((m: Message) => bringBack(m.id, m.content), [bringBack])

  // In the order their passages appear in the conversation, like the Mark page.
  const sessionThreads = useMemo(() => {
    const seqOf = new Map(messages.map((m) => [m.id, m.seq]))
    return sessions
      .filter((s): s is ThreadSession => s.kind === 'thread' && s.parentSessionId === activeSessionId)
      .sort(
        (a, b) =>
          (seqOf.get(a.anchorMessageId) ?? 0) - (seqOf.get(b.anchorMessageId) ?? 0) ||
          a.anchorStart - b.anchorStart
      )
  }, [activeSessionId, sessions, messages])

  const currentThread = sessionThreads.find((t) => t.id === activeThreadId) ?? null
  const draft = !currentThread && draftThread?.parentSessionId === activeSessionId ? draftThread : null

  const threadMessages = useMemo(
    () =>
      currentThread
        ? messages.filter((m) => m.sessionId === currentThread.id).sort((a, b) => a.seq - b.seq)
        : [],
    [currentThread, messages]
  )

  const marksByMessage = useMemo(() => {
    const map = new Map<string, Mark[]>()
    for (const mark of marks) map.set(mark.messageId, [...(map.get(mark.messageId) ?? []), mark])
    return map
  }, [marks])

  // A thread's clips go to its main session's note, the one the store follows.
  const clipsByMessage = useMemo(() => {
    const map = new Map<string, NoteClipSource[]>()
    for (const clip of noteClips?.clips ?? NO_CLIPS) map.set(clip.messageId, [...(map.get(clip.messageId) ?? []), clip])
    return map
  }, [noteClips])

  // A newly sent question scrolls to the top of the thread, like in the main conversation (D-011).
  const lastUserId = [...threadMessages].reverse().find((m) => m.role === 'user')?.id
  const seen = useRef<{ threadId: string | null; userId: string | undefined }>({
    threadId: null,
    userId: undefined
  })
  useEffect(() => {
    const opened = seen.current.threadId !== (currentThread?.id ?? null)
    const sent = !opened && lastUserId !== seen.current.userId
    seen.current = { threadId: currentThread?.id ?? null, userId: lastUserId }
    if (!sent || !lastUserId || !scrollRef.current) return
    const el = document.getElementById(`message-${lastUserId}`)
    if (el) scrollRef.current.scrollTop = el.offsetTop - scrollRef.current.offsetTop - 12
  }, [currentThread?.id, lastUserId])

  if (currentThread || draft) {
    return (
      <div className="thread-tab-container">
        <div className="thread-sub-bar">
          <button type="button" className="thread-list-switch-btn" onClick={() => selectThread(null)}>
            ‹ 全部追问 ({sessionThreads.length})
          </button>
        </div>

        <div className="thread-anchor-banner">
          <div className="thread-anchor-quote">「{currentThread?.anchorQuote ?? draft?.anchorQuote}」</div>
          {currentThread ? (
            <ThreadModeSwitch mode={currentThread.contextMode} />
          ) : (
            draft && <ThreadModeSwitch mode={draft.contextMode} onChange={setDraftThreadMode} />
          )}
        </div>

        <div ref={scrollRef} className="thread-messages-scroll">
          {threadMessages.map((msg, idx) => (
            <div key={msg.id} className="thread-message-item">
              <MessageItem
                message={msg}
                isLastRound={idx >= threadMessages.length - 2}
                inThread
                marks={marksByMessage.get(msg.id) ?? NO_MARKS}
                categories={markCategories}
                clips={clipsByMessage.get(msg.id) ?? NO_CLIPS}
                files={files}
                onSelectMark={openMarkCard}
                onBringBack={bringBackWhole}
                onSelectClip={openNoteClip}
              />
            </div>
          ))}
        </div>

        <div className="thread-input-wrap">
          <ChatInputBox
            // A fresh box per thread, so a half-typed question stays with the thread it was meant for.
            key={currentThread?.id ?? 'draft'}
            compact
            target="thread"
            placeholder={currentThread ? '继续追问…' : '关于这段，想问什么？'}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="thread-tab-container">
      <div className="thread-list-view">
        <div className="thread-list-label">本会话的追问 ({sessionThreads.length})</div>
        {sessionThreads.length === 0 && (
          <div className="thread-list-empty">在回答里选中一段文字，点「追问」，就能针对它单独讨论。</div>
        )}
        {sessionThreads.map((t) => (
          <button
            key={t.id}
            type="button"
            className="thread-list-card"
            onClick={() => selectThread(t.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, thread: t })
            }}
          >
            <div className="thread-list-card-top">
              <span>{t.contextMode === 'fork' ? 'Fork' : 'New'}</span>
              <span>{messages.filter((m) => m.sessionId === t.id).length} 条消息</span>
            </div>
            <div className="thread-list-quote">「{t.anchorQuote}」</div>
          </button>
        ))}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              label: '删除',
              danger: true,
              onSelect: () => {
                if (window.confirm('删除这次追问？追问里的消息和 mark 会一起删除。')) {
                  deleteThread(menu.thread.id)
                }
              }
            }
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

export const RightPanel: React.FC = () => {
  const [dragging, setDragging] = useState(false)

  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const noteExpandedToCenter = useAppStore((s) => s.noteExpandedToCenter)
  const rightPanelTab = useAppStore((s) => s.rightPanelTab)
  const rightPanelWidth = useAppStore((s) => s.rightPanelWidth)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const messages = useAppStore((s) => s.messages)
  const marks = useAppStore((s) => s.marks)
  const markCategories = useAppStore((s) => s.markCategories)
  const selectedMarkCategoryId = useAppStore((s) => s.selectedMarkCategoryId)
  const leftSidebarOpen = useAppStore((s) => s.leftSidebarOpen)

  const openRightPanelTab = useAppStore((s) => s.openRightPanelTab)
  const closeRightPanel = useAppStore((s) => s.closeRightPanel)
  const setRightPanelWidth = useAppStore((s) => s.setRightPanelWidth)
  const setSelectedMarkCategory = useAppStore((s) => s.setSelectedMarkCategory)
  const jumpToMark = useAppStore((s) => s.jumpToMark)
  const startMarkQuiz = useAppStore((s) => s.startMarkQuiz)

  useEffect(() => {
    if (!dragging) return

    const onMouseMove = (e: MouseEvent): void => {
      const sidebarW = leftSidebarOpen ? 240 : 0
      const maxAllowed = Math.max(rightPanelMinWidth + 20, window.innerWidth - sidebarW - 480)
      const desired = window.innerWidth - e.clientX
      const clamped = Math.min(Math.max(rightPanelMinWidth, desired), maxAllowed)
      setRightPanelWidth(clamped)
    }

    const onMouseUp = (): void => {
      setDragging(false)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [dragging, leftSidebarOpen, setRightPanelWidth])

  // Order marks by position in the conversation (main message seq -> thread vs main -> offset)
  const orderedSessionMarks = useMemo(() => {
    const sessionMarks = marks.filter((m) => m.sessionId === activeSessionId)

    const getSortTuple = (markId: string): [number, number, number, number] => {
      const mark = sessionMarks.find((m) => m.id === markId)
      if (!mark) return [9999, 0, 0, 0]
      const msg = messages.find((m) => m.id === mark.messageId)
      if (!msg) return [9999, 0, 0, mark.startOffset]
      const sess = sessions.find((s) => s.id === msg.sessionId)
      if (!sess || sess.kind === 'main') {
        return [msg.seq, 0, 0, mark.startOffset]
      }
      const anchorMsg = messages.find((m) => m.id === sess.anchorMessageId)
      const anchorSeq = anchorMsg?.seq ?? 9999
      return [anchorSeq, 1, msg.seq, mark.startOffset]
    }

    return [...sessionMarks].sort((a, b) => {
      const ta = getSortTuple(a.id)
      const tb = getSortTuple(b.id)
      for (let i = 0; i < 4; i++) {
        if (ta[i] !== tb[i]) return ta[i] - tb[i]
      }
      return 0
    })
  }, [activeSessionId, marks, messages, sessions])

  const filteredMarks = useMemo(() => {
    if (!selectedMarkCategoryId) return orderedSessionMarks
    return orderedSessionMarks.filter(
      (m) => m.categoryId === selectedMarkCategoryId
    )
  }, [orderedSessionMarks, selectedMarkCategoryId])

  if (!rightPanelOpen) return null

  const tabs: { key: RightPanelTab; label: string; icon: React.ReactNode }[] = [
    { key: 'thread', label: '追问', icon: <ThreadBranchIcon size={13} /> },
    { key: 'mark', label: 'Mark', icon: <BookmarkIcon size={13} /> },
    { key: 'note', label: 'Note', icon: <NotePageIcon size={13} /> },
    { key: 'file', label: '附件', icon: <PaperclipIcon size={13} /> }
  ]

  return (
    <aside className="right-panel" style={{ width: `${rightPanelWidth}px` }}>
      <div
        className={`right-panel-resizer ${dragging ? 'dragging' : ''}`}
        onMouseDown={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
      />

      <div className="right-panel-header drag-region">
        <div className="right-panel-tabs no-drag">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`right-tab-btn ${
                rightPanelTab === t.key ? 'active' : ''
              }`}
              onClick={() => openRightPanelTab(t.key)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="right-panel-close-btn no-drag"
          onClick={closeRightPanel}
          aria-label="收起右栏"
          title={`收起右栏 (Esc / ${modKey}J)`}
        >
          <CollapsePanelIcon size={14} />
        </button>
      </div>

      <div className="right-panel-body no-drag">
        {rightPanelTab === 'thread' && <ThreadTab />}

        {rightPanelTab === 'mark' && (
          <div className="mark-tab-container">
            <div className="mark-filter-bar">
              <button
                type="button"
                className={`mark-filter-chip ${
                  selectedMarkCategoryId === null ? 'active' : ''
                }`}
                onClick={() => setSelectedMarkCategory(null)}
              >
                全部 ({orderedSessionMarks.length})
              </button>
              {markCategories.map((cat) => {
                const count = orderedSessionMarks.filter(
                  (m) => m.categoryId === cat.id
                ).length
                return (
                  <button
                    key={cat.id}
                    type="button"
                    className={`mark-filter-chip ${
                      selectedMarkCategoryId === cat.id ? 'active' : ''
                    }`}
                    onClick={() => setSelectedMarkCategory(cat.id)}
                  >
                    {cat.name} ({count})
                  </button>
                )
              })}
            </div>

            {selectedMarkCategoryId === QUESTION_CATEGORY_ID && filteredMarks.length > 0 && (
              <button type="button" className="mark-quiz-btn" onClick={() => startMarkQuiz(filteredMarks)}>
                拿这些疑问考考我 ›
              </button>
            )}

            <div className="mark-list">
              {filteredMarks.map((mark) => {
                const cat = markCategories.find((c) => c.id === mark.categoryId)
                const msg = messages.find((m) => m.id === mark.messageId)
                const sess = sessions.find((s) => s.id === msg?.sessionId)
                const isFromThread = sess?.kind === 'thread'

                return (
                  <button
                    key={mark.id}
                    type="button"
                    className="mark-card"
                    onClick={() => jumpToMark(mark)}
                  >
                    <div className="mark-card-header">
                      <div className="mark-badges">
                        {cat && (
                          <span className={`mark-category-badge ${cat.color}`}>
                            {cat.name}
                          </span>
                        )}
                        {isFromThread && (
                          <span className="mark-thread-tag">追问</span>
                        )}
                      </div>
                    </div>

                    <div className="mark-quote-text">{mark.quote}</div>

                    {mark.comment && (
                      <div className="mark-comment-text">{mark.comment}</div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* One editor per note at a time: when the note fills the center column, it isn't shown here too. */}
        {rightPanelTab === 'note' &&
          (noteExpandedToCenter ? <div className="note-empty-hint">Note 已放大到中栏</div> : <NoteView />)}

        {rightPanelTab === 'file' && <FileTab />}
      </div>
    </aside>
  )
}
