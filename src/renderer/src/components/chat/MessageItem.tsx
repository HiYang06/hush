import React, { useEffect, useRef, useState } from 'react'
import type {
  Attachment,
  FileRecord,
  Mark,
  MarkCategory,
  Message,
  NoteClipSource,
  ThreadSession
} from '@shared/types'
import { ERROR_LEADS, errorText } from '@renderer/lib/errors'
import { estimateTokens } from '@renderer/lib/tokens'
import { streamingReplyIn, useAppStore, type MarkCardState } from '@renderer/stores/appStore'
import { FileCard } from './FileCard'
import { MarkdownContent } from './MarkdownContent'
import { WebActivity } from './WebActivity'

interface MessageItemProps {
  message: Message
  isLastRound: boolean
  isHighlighted?: boolean
  inThread?: boolean
  marks?: Mark[]
  categories?: MarkCategory[]
  threads?: ThreadSession[]
  clips?: NoteClipSource[]
  files?: FileRecord[]
  onSelectThread?: (threadId: string) => void
  onSelectMark?: (card: MarkCardState) => void
  onSelectClip?: (clip: NoteClipSource) => void
  onOpenNote?: () => void
  onJumpToMessage?: (messageId: string) => void
  // A thread's reply, brought back whole to the main conversation.
  onBringBack?: (message: Message) => void
}

const AttachmentCardItem: React.FC<{
  attachment: Exclude<Attachment, { type: 'file' }>
  onSelectThread?: (threadId: string) => void
  onOpenNote?: () => void
}> = ({ attachment, onSelectThread, onOpenNote }) => {
  const [expanded, setExpanded] = useState(false)
  // What was brought back is a snapshot and stays; only the way back to the thread goes with it.
  const threadGone = useAppStore(
    (s) => attachment.type === 'thread_result' && !s.sessions.some((t) => t.id === attachment.threadId)
  )
  const referencedSession = useAppStore((s) =>
    attachment.type === 'session_ref' || attachment.type === 'mark_quiz'
      ? s.sessions.find((t) => t.id === attachment.sessionId)
      : undefined
  )
  const selectSession = useAppStore((s) => s.selectSession)

  if (attachment.type === 'thread_result') {
    return (
      <div
        className={`attachment-card ${threadGone ? 'source-gone' : ''}`}
        onClick={() => !threadGone && onSelectThread?.(attachment.threadId)}
      >
        <div className="attachment-card-header">
          <span className="attachment-card-title">
            来自追问：「{attachment.quote}」
            {threadGone && <span className="attachment-card-note">追问已删除</span>}
          </span>
          <button
            type="button"
            className="message-action-btn"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((prev) => !prev)
            }}
          >
            {expanded ? '收起' : '展开预览'}
          </button>
        </div>
        {expanded && (
          <div className="attachment-card-preview">{attachment.text}</div>
        )}
      </div>
    )
  }

  if (attachment.type === 'mark_quiz') {
    return (
      <div
        className={`attachment-card ${referencedSession ? '' : 'source-gone'}`}
        onClick={() => referencedSession && selectSession(referencedSession.id)}
      >
        <div className="attachment-card-header">
          <span className="attachment-card-title">
            考考我：{attachment.label}
            {!referencedSession && <span className="attachment-card-note">会话已删除</span>}
          </span>
          <span>{attachment.marks.length} 条疑问</span>
        </div>
      </div>
    )
  }

  if (attachment.type === 'session_ref') {
    return (
      <div
        className={`attachment-card ${referencedSession ? '' : 'source-gone'}`}
        onClick={() => referencedSession && selectSession(referencedSession.id)}
      >
        <div className="attachment-card-header">
          <span className="attachment-card-title">
            会话引用：{attachment.label}
            {!referencedSession && <span className="attachment-card-note">会话已删除</span>}
          </span>
          <span>约 {estimateTokens(attachment.text)} tokens</span>
        </div>
      </div>
    )
  }

  return (
    <div className="attachment-card" onClick={() => onOpenNote?.()}>
      <div className="attachment-card-header">
        <span className="attachment-card-title">
          笔记引用：{attachment.label}
        </span>
        <span>约 {estimateTokens(attachment.text)} tokens</span>
      </div>
    </div>
  )
}

// The provider's own words go below, as they are: they say what exactly went wrong (product.md §2).
const ReplyError: React.FC<{ message: Message; onRetry: () => void }> = ({ message, onRetry }) => {
  const openSettings = useAppStore((s) => s.openSettings)
  return (
    <div className="reply-error">
      <div className="reply-error-lead">
        <span>{ERROR_LEADS[message.errorKind ?? 'other']}</span>
        {message.errorKind === 'auth' && (
          <button type="button" className="message-action-btn" onClick={openSettings}>
            去设置
          </button>
        )}
        <button type="button" className="message-action-btn" onClick={onRetry}>
          重试
        </button>
      </div>
      {message.error && <div className="reply-error-detail">{message.error}</div>}
    </div>
  )
}

// The last question, edited in place; Enter sends, Shift+Enter breaks the line, Esc gives up.
const QuestionEditor: React.FC<{ initial: string; onCancel: () => void; onSubmit: (text: string) => void }> = ({
  initial,
  onCancel,
  onSubmit
}) => {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  useEffect(() => {
    const el = ref.current
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const submit = (): void => {
    if (text.trim()) onSubmit(text.trim())
  }

  return (
    <div className="question-editor">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter while an input method is picking characters confirms them, not the edit.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="question-editor-actions">
        <button type="button" className="message-action-btn" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="message-action-btn" disabled={!text.trim()} onClick={submit}>
          发送
        </button>
      </div>
    </div>
  )
}

// thinkingMs only moves when a thinking delta arrives; a model can pause for seconds, so while
// thinking is live, keep counting from the last value once a second.
function useLiveThinkingMs(thinkingMs: number | null, live: boolean): number {
  const [now, setNow] = useState(Date.now)
  const base = useRef({ ms: thinkingMs ?? 0, at: Date.now() })
  if (base.current.ms !== (thinkingMs ?? 0)) base.current = { ms: thinkingMs ?? 0, at: Date.now() }

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  return live ? base.current.ms + Math.max(0, now - base.current.at) : (thinkingMs ?? 1000)
}

const MessageItemView: React.FC<MessageItemProps> = ({
  message,
  isLastRound,
  isHighlighted = false,
  inThread = false,
  marks = [],
  categories = [],
  threads = [],
  clips,
  files = [],
  onSelectThread,
  onSelectMark,
  onSelectClip,
  onOpenNote,
  onJumpToMessage,
  onBringBack
}) => {
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [broughtBack, setBroughtBack] = useState(false)
  const [editing, setEditing] = useState(false)
  const liveThinkingRef = useRef<HTMLDivElement | null>(null)
  const webBusy = useAppStore((s) => message.status === 'streaming' && Boolean(s.webBusy[message.id]))
  const regenerate = useAppStore((s) => s.regenerateReply)
  // Fails before anything changes, e.g. when an earlier attachment can't be downloaded to this device.
  const regenerateReply = (replyId: string, text: string | null = null): Promise<boolean> =>
    regenerate(replyId, text).catch((err) => {
      window.alert(errorText(err))
      return false
    })
  // A question can't be edited while its reply is still coming in.
  const roundBusy = useAppStore(
    (s) => message.role === 'user' && isLastRound && Boolean(streamingReplyIn(s.messages, message.sessionId))
  )

  const isWaiting =
    message.status === 'streaming' && !message.thinking && !message.content && !message.web
  const isThinkingLive =
    message.status === 'streaming' &&
    Boolean(message.thinking) &&
    !message.content
  const hasFinishedThinking =
    Boolean(message.thinking) && !isThinkingLive

  useEffect(() => {
    if (isThinkingLive && liveThinkingRef.current) {
      liveThinkingRef.current.scrollTop = liveThinkingRef.current.scrollHeight
    }
  }, [isThinkingLive, message.thinking])

  const liveThinkingMs = useLiveThinkingMs(message.thinkingMs, isThinkingLive)
  const thinkingSeconds = Math.max(1, Math.round(liveThinkingMs / 1000))

  const handleCopy = (): void => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const submitEdit = async (text: string): Promise<void> => {
    const reply = useAppStore
      .getState()
      .messages.find((m) => m.sessionId === message.sessionId && m.seq === message.seq + 1)
    if (!reply) return
    if (text === message.content) {
      setEditing(false)
      return
    }
    if (await regenerateReply(reply.id, text)) setEditing(false)
  }

  if (message.role === 'user') {
    // A file whose record hasn't loaded yet just appears a moment later.
    const attachedFiles = message.attachments.flatMap((a) =>
      a.type === 'file' ? files.filter((f) => f.id === a.fileId) : []
    )
    const otherAttachments = message.attachments.filter(
      (a): a is Exclude<Attachment, { type: 'file' }> => a.type !== 'file'
    )
    return (
      <div
        id={`message-${message.id}`}
        data-message-id={message.id}
        data-role="user"
        className={`message-item user-message-wrapper ${
          isHighlighted ? 'flash-highlight' : ''
        }`}
      >
        {attachedFiles.length > 0 && (
          <div className="message-files">
            {attachedFiles.map((file) => (
              <FileCard key={file.id} file={file} />
            ))}
          </div>
        )}

        {otherAttachments.length > 0 && (
          <div className="message-attachments-list">
            {otherAttachments.map((att, idx) => (
              <AttachmentCardItem
                key={idx}
                attachment={att}
                onSelectThread={onSelectThread}
                onOpenNote={onOpenNote}
              />
            ))}
          </div>
        )}

        {editing ? (
          <QuestionEditor
            initial={message.content}
            onCancel={() => setEditing(false)}
            onSubmit={(text) => void submitEdit(text)}
          />
        ) : (
          // Cards can be sent with nothing typed; an empty block would still draw the quote bar.
          message.content && (
            <div className="user-question-block">
              <MarkdownContent
                content={message.content}
                onJumpToMessage={onJumpToMessage}
              />
            </div>
          )
        )}

        {!editing && (
          <div className="message-hover-bar">
            <div className="message-hover-buttons">
              <button
                type="button"
                className="message-action-btn"
                onClick={handleCopy}
              >
                {copied ? '已复制' : '复制'}
              </button>
              {isLastRound && !roundBusy && (
                <button type="button" className="message-action-btn" onClick={() => setEditing(true)}>
                  编辑
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      id={`message-${message.id}`}
      data-message-id={message.id}
      data-role="assistant"
      data-status={message.status}
      data-in-thread={inThread || undefined}
      className={`message-item assistant-message-wrapper ${
        isHighlighted ? 'flash-highlight' : ''
      }`}
    >
      {(isWaiting || isThinkingLive || hasFinishedThinking || message.web) && (
        <div className="generation-status-block">
          {isWaiting && <div className="status-waiting-text">等待回复…</div>}

          {message.web && <WebActivity web={message.web} busy={webBusy} />}

          {isThinkingLive && (
            <div>
              <div className="status-thinking-live-header">
                <span>思考中 · {thinkingSeconds}s</span>
              </div>
              <div className="thinking-live-box">
                {/* Padding lives on the outer box, so scrolling to the bottom shows exactly the last 3 lines. */}
                <div ref={liveThinkingRef} className="thinking-live-text">
                  {/* Blank lines would waste the 3 lines of the preview. */}
                  {message.thinking?.replace(/\n\s*\n/g, '\n').trim()}
                </div>
              </div>
            </div>
          )}

          {hasFinishedThinking && (
            <div>
              <button
                type="button"
                className="thinking-done-toggle"
                onClick={() => setThinkingExpanded((prev) => !prev)}
              >
                <span>思考了 {thinkingSeconds} 秒</span>
                <span
                  className={`thinking-done-chevron ${
                    thinkingExpanded ? 'expanded' : ''
                  }`}
                >
                  ›
                </span>
              </button>
              {thinkingExpanded && (
                <div className="thinking-expanded-content">
                  {message.thinking?.trim()}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {message.content && (
        <MarkdownContent
          content={message.content}
          messageId={message.id}
          sources={message.web?.sources}
          streaming={message.status === 'streaming'}
          marks={marks}
          categories={categories}
          threads={threads}
          clips={clips}
          onSelectThread={onSelectThread}
          onSelectMark={onSelectMark}
          onSelectClip={onSelectClip}
          onJumpToMessage={onJumpToMessage}
        />
      )}

      {message.status === 'error' && (
        <ReplyError message={message} onRetry={() => void regenerateReply(message.id)} />
      )}

      {message.status === 'stopped' && <div className="reply-stopped">已停止</div>}

      {message.status !== 'streaming' && (
        <div className="message-hover-bar">
          <div className="message-hover-buttons">
            <button
              type="button"
              className="message-action-btn"
              onClick={handleCopy}
            >
              {copied ? '已复制' : '复制'}
            </button>
            {inThread && (
              <button
                type="button"
                className="message-action-btn"
                onClick={() => {
                  onBringBack?.(message)
                  setBroughtBack(true)
                  setTimeout(() => setBroughtBack(false), 1500)
                }}
              >
                {broughtBack ? '已带回' : '带回'}
              </button>
            )}
            {!inThread && isLastRound && message.status !== 'error' && (
              <button
                type="button"
                className="message-action-btn"
                onClick={() => void regenerateReply(message.id)}
              >
                重新生成
              </button>
            )}
          </div>

          {message.inputTokens !== null && message.outputTokens !== null && (
            <div className="message-token-usage">
              输入 {message.inputTokens.toLocaleString('en-US')} · 输出 {message.outputTokens.toLocaleString('en-US')} tokens
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const MessageItem = React.memo(MessageItemView)
