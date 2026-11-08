import React, { useEffect, useState } from 'react'
import { fileKind, fileUrl, formatSize } from '@shared/files'
import { noteClips } from '@shared/noteClips'
import type { Attachment, Mark, MarkCategory, Message, NoteClipSource, ThreadSession } from '@shared/types'
import { MarkdownContent } from '@renderer/components/chat/MarkdownContent'
import { WebActivity } from '@renderer/components/chat/WebActivity'
import { anchorToRange } from '@renderer/lib/anchors'
import { ERROR_LEADS } from '@renderer/lib/errors'
import { flashPassages } from '@renderer/lib/highlights'
import type { MarkCardState } from '@renderer/stores/appStore'
import { post } from './bridge'

// What Swift hands over for one session (HushCore Library.conversationJSON).
type Conversation = {
  anchorQuote: string | null
  messages: Message[]
  marks: Mark[]
  threads: ThreadSession[]
  categories: MarkCategory[]
  files: ReaderFile[]
  // The note this session's clips are in, for their underlines; null when it was never written.
  note: string | null
}

type ReaderFile = { id: string; name: string; mime: string; size: number; isScanned: number | null }

declare global {
  interface Window {
    hush: {
      show(json: string): void
      revealMark(id: string): void
      revealMessage(id: string): void
      showNote(markdown: string): void
      revealClip(messageId: string, start: number, end: number): void
      revealSection(title: string): void
    }
  }
}

const selectThread = (id: string): void => post({ type: 'thread', id })
const selectMark = (card: MarkCardState): void => {
  if ('markId' in card) post({ type: 'mark', id: card.markId })
}
const jumpToMessage = (id: string): void => post({ type: 'message', id })
const selectClip = (clip: NoteClipSource): void =>
  post({ type: 'clip', id: clip.messageId, start: clip.start, end: clip.end })
const NO_CLIPS: NoteClipSource[] = []

type Reveal =
  | { kind: 'mark' | 'message'; id: string }
  | { kind: 'clip'; messageId: string; start: number; end: number }
  | { kind: 'section'; title: string }

function flashBlock(el: Element): void {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const range = document.createRange()
  range.selectNodeContents(el)
  flashPassages([range], 2000)
}

// Waits out what the desktop's flashMessagePassages does: a message scrolled to from afar is still at
// content-visibility's placeholder height for a few frames.
async function settled(id: string): Promise<HTMLElement | null> {
  let height = -1
  for (let frame = 0; frame < 60; frame++) {
    const el = document.getElementById(`message-${id}`)
    const now = el?.getBoundingClientRect().height ?? -1
    if (el && now === height) return el
    height = now
    await new Promise(requestAnimationFrame)
  }
  return null
}

// One page shows either a conversation or a note, whichever Swift hands it.
export const Reader: React.FC = () => {
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [flashed, setFlashed] = useState<string | null>(null)

  useEffect(() => {
    window.hush = {
      show: (json) => setConversation(JSON.parse(json) as Conversation),
      revealMark: (id) => setReveal({ kind: 'mark', id }),
      revealMessage: (id) => setReveal({ kind: 'message', id }),
      showNote: setNote,
      revealClip: (messageId, start, end) => setReveal({ kind: 'clip', messageId, start, end }),
      revealSection: (title) => setReveal({ kind: 'section', title })
    }
    post({ type: 'ready' })
  }, [])

  // A clip in the note: the run of quoted lines its source link closes (NoteEditor.tsx revealNoteClip).
  useEffect(() => {
    if (!reveal || note === null || (reveal.kind !== 'clip' && reveal.kind !== 'section')) return
    setReveal(null)
    requestAnimationFrame(() => {
      if (reveal.kind === 'clip') {
        const link = document.querySelector(
          `a[href="hush://message/${CSS.escape(reveal.messageId)}#${reveal.start}-${reveal.end}"]`
        )
        if (link) flashBlock(link.closest('blockquote') ?? link)
        return
      }
      const heading = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].find(
        (h) => h.textContent?.trim() === reveal.title
      )
      heading?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [reveal, note])

  // After the commit, so the messages (and the marks' ranges) are in the page.
  useEffect(() => {
    if (!reveal || !conversation || (reveal.kind !== 'mark' && reveal.kind !== 'message')) return
    setReveal(null)
    const mark = reveal.kind === 'mark' ? conversation.marks.find((m) => m.id === reveal.id) : undefined
    void settled(mark?.messageId ?? reveal.id).then((el) => {
      if (!el) return
      if (!mark) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        setFlashed(reveal.id)
        setTimeout(() => setFlashed((f) => (f === reveal.id ? null : f)), 2000)
        return
      }
      // Same placement as the desktop's jumpToMark: the passage comes to the middle and flashes.
      const body = el.querySelector('.markdown-body')
      const range = body
        ? anchorToRange(body, {
            quote: mark.quote,
            start: mark.startOffset,
            end: mark.endOffset,
            prefix: mark.prefix,
            suffix: mark.suffix
          })
        : null
      ;(range?.startContainer.parentElement ?? el).scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (range) flashPassages([range], 2000)
    })
  }, [reveal, conversation])

  const clips = React.useMemo(() => noteClips(conversation?.note ?? ''), [conversation?.note])

  if (note !== null) {
    return (
      <div className="reader chat-column-inner">
        {note.trim() ? (
          <MarkdownContent content={note} onJumpToMessage={jumpToMessage} />
        ) : (
          <div className="reader-empty">这个 note 还是空的</div>
        )}
      </div>
    )
  }
  if (!conversation) return null
  const { messages, marks, threads, categories, anchorQuote, files } = conversation

  return (
    <div className="reader chat-column-inner">
      {anchorQuote !== null && <div className="thread-anchor-quote">「{anchorQuote}」</div>}
      {messages.length === 0 && <div className="reader-empty">这个会话还没有消息</div>}
      {messages.map((message) => (
        <ReaderMessage
          key={message.id}
          message={message}
          flashed={flashed === message.id}
          marks={marks.filter((m) => m.messageId === message.id)}
          threads={threads.filter((t) => t.anchorMessageId === message.id)}
          categories={categories}
          threadIds={threads.map((t) => t.id)}
          files={files}
          clips={clips.some((c) => c.messageId === message.id) ? clips.filter((c) => c.messageId === message.id) : NO_CLIPS}
        />
      ))}
    </div>
  )
}

// MessageItem.tsx's layout and class names, without what needs the desktop's store or changes anything.
const ReaderMessage = React.memo<{
  message: Message
  flashed: boolean
  marks: Mark[]
  threads: ThreadSession[]
  categories: MarkCategory[]
  threadIds: string[]
  files: ReaderFile[]
  clips: NoteClipSource[]
}>(({ message, flashed, marks, threads, categories, threadIds, files, clips }) => {
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const className = `message-item ${message.role === 'user' ? 'user-message-wrapper' : 'assistant-message-wrapper'} ${
    flashed ? 'flash-highlight' : ''
  }`

  if (message.role === 'user') {
    const cards = message.attachments.filter(
      (a): a is Exclude<Attachment, { type: 'file' }> => a.type !== 'file'
    )
    const attached = message.attachments.flatMap((a) => (a.type === 'file' ? files.filter((f) => f.id === a.fileId) : []))
    return (
      <div id={`message-${message.id}`} data-message-id={message.id} data-role="user" className={className}>
        {attached.length > 0 && (
          <div className="message-files">
            {attached.map((file) => (
              <FileCard key={file.id} file={file} />
            ))}
          </div>
        )}
        {cards.length > 0 && (
          <div className="message-attachments-list">
            {cards.map((card, i) => (
              <AttachmentCard key={i} attachment={card} threadIds={threadIds} />
            ))}
          </div>
        )}
        {message.content && (
          <div className="user-question-block">
            <MarkdownContent content={message.content} onJumpToMessage={jumpToMessage} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div id={`message-${message.id}`} data-message-id={message.id} data-role="assistant" className={className}>
      {(message.thinking || message.web) && (
        <div className="generation-status-block">
          {message.web && <WebActivity web={message.web} busy={false} />}
          {message.thinking && (
            <div>
              <button type="button" className="thinking-done-toggle" onClick={() => setThinkingExpanded((v) => !v)}>
                <span>思考了 {Math.max(1, Math.round((message.thinkingMs ?? 1000) / 1000))} 秒</span>
                <span className={`thinking-done-chevron ${thinkingExpanded ? 'expanded' : ''}`}>›</span>
              </button>
              {thinkingExpanded && <div className="thinking-expanded-content">{message.thinking.trim()}</div>}
            </div>
          )}
        </div>
      )}

      {message.content && (
        <MarkdownContent
          content={message.content}
          messageId={message.id}
          sources={message.web?.sources}
          marks={marks}
          categories={categories}
          threads={threads}
          clips={clips}
          onSelectThread={selectThread}
          onSelectClip={selectClip}
          onSelectMark={selectMark}
          onJumpToMessage={jumpToMessage}
        />
      )}

      {message.status === 'error' && (
        <div className="reply-error">
          <div className="reply-error-lead">
            <span>{ERROR_LEADS[message.errorKind ?? 'other']}</span>
          </div>
          {message.error && <div className="reply-error-detail">{message.error}</div>}
        </div>
      )}
      {message.status === 'stopped' && <div className="reply-stopped">已停止</div>}
      {/* A reply still being written on another device; the next sync brings the rest. */}
      {message.status === 'streaming' && <div className="reply-stopped">还在生成…</div>}
    </div>
  )
})

const AttachmentCard: React.FC<{ attachment: Exclude<Attachment, { type: 'file' }>; threadIds: string[] }> = ({
  attachment,
  threadIds
}) => {
  const [expanded, setExpanded] = useState(false)

  if (attachment.type === 'thread_result') {
    const gone = !threadIds.includes(attachment.threadId)
    return (
      <div
        className={`attachment-card ${gone ? 'source-gone' : ''}`}
        onClick={() => !gone && selectThread(attachment.threadId)}
      >
        <div className="attachment-card-header">
          <span className="attachment-card-title">
            来自追问：「{attachment.quote}」
            {gone && <span className="attachment-card-note">追问已删除</span>}
          </span>
          <button
            type="button"
            className="message-action-btn"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
          >
            {expanded ? '收起' : '展开预览'}
          </button>
        </div>
        {expanded && <div className="attachment-card-preview">{attachment.text}</div>}
      </div>
    )
  }

  if (attachment.type === 'mark_quiz') {
    return (
      <div className="attachment-card" onClick={() => post({ type: 'session', id: attachment.sessionId })}>
        <div className="attachment-card-header">
          <span className="attachment-card-title">考考我：{attachment.label}</span>
          <span>{attachment.marks.length} 条疑问</span>
        </div>
      </div>
    )
  }

  if (attachment.type === 'session_ref') {
    return (
      <div className="attachment-card" onClick={() => post({ type: 'session', id: attachment.sessionId })}>
        <div className="attachment-card-header">
          <span className="attachment-card-title">会话引用：{attachment.label}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="attachment-card" onClick={() => post({ type: 'note', id: attachment.noteId, section: attachment.sectionTitle })}>
      <div className="attachment-card-header">
        <span className="attachment-card-title">笔记引用：{attachment.label}</span>
      </div>
    </div>
  )
}

const KIND_LABEL = { pdf: 'PDF', docx: 'Word', pptx: 'PPT', text: '文本' } as const

// FileCard.tsx's look; a tap opens it full screen in Swift. hush-file:// downloads it the first time.
const FileCard: React.FC<{ file: ReaderFile }> = ({ file }) => {
  const [missing, setMissing] = useState(false)
  const open = (): void => post({ type: 'file', id: file.id })
  const kind = fileKind(file.mime)

  if (kind === 'image') {
    return (
      <div className="file-thumb" onClick={open}>
        {missing ? (
          <span className="file-thumb-missing">未下载</span>
        ) : (
          <img src={fileUrl(file.id)} alt={file.name} loading="lazy" onError={() => setMissing(true)} />
        )}
      </div>
    )
  }
  return (
    <div className="file-card" onClick={open}>
      <span className="file-card-kind">{file.isScanned ? 'PDF · 扫描件' : KIND_LABEL[kind]}</span>
      <span className="file-card-body">
        <span className="file-card-name">{file.name}</span>
        <span className="file-card-meta">{formatSize(file.size)}</span>
      </span>
    </div>
  )
}
