import React, { useEffect, useRef, useState } from 'react'
import type { MainSession, ThinkingLevel } from '@shared/types'
import { countImages, MAX_IMAGES_PER_MESSAGE, planFile } from '@shared/files'
import { pastedSessionId } from '@shared/sessionLinks'
import { effectiveThinkingLevel } from '@shared/thinking'
import { PaperclipIcon } from '@renderer/components/common/Icons'
import { errorText } from '@renderer/lib/errors'
import { estimateTokens } from '@renderer/lib/tokens'
import { EMPTY_CHAT_DRAFT, streamingReplyIn, useAppStore, type ChatDraft, type PendingFile, type ChatTarget, type ThreadResult } from '@renderer/stores/appStore'
import { FileCard, PendingFileCard } from './FileCard'
import { NoteRefPicker, type NoteRef, type NoteRefPickerHandle } from './NoteRefPicker'

// The "@" being typed: where it is, and where the caret is after the query typed behind it.
type Mention = { start: number; end: number }

// An "@" (or a full-width one from a Chinese keyboard) before the caret with no space in between.
function mentionAt(text: string, caret: number): Mention | null {
  for (let i = caret - 1; i >= 0; i--) {
    if (text[i] === '@' || text[i] === '＠') return { start: i, end: caret }
    if (/\s/.test(text[i])) return null
  }
  return null
}

const NO_BRING_BACKS: ThreadResult[] = []

interface ChatInputBoxProps {
  placeholder?: string
  compact?: boolean
  target?: ChatTarget
  // false: no `@` picker for notes and sessions, and a pasted session link stays text (the mini window).
  refs?: boolean
  // false where there's no settings page to open (the mini window): the 联网 toggle then shows only once set up.
  canOpenSettings?: boolean
}

const THINKING_OPTIONS: {
  value: ThinkingLevel
  shortLabel: string
  desc: string
}[] = [
  { value: 'off', shortLabel: '关', desc: '直接回答' },
  { value: 'low', shortLabel: '低', desc: '轻量推演' },
  { value: 'medium', shortLabel: '中', desc: '均衡思考' },
  { value: 'high', shortLabel: '高', desc: '深度推演' }
]

const ChevronIcon: React.FC<{ open: boolean }> = ({ open }) => (
  <svg
    className={`meta-chevron-svg ${open ? 'open' : ''}`}
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 4.5L6 7.5L9 4.5" />
  </svg>
)

const ThinkingInkIcon: React.FC<{ level: ThinkingLevel }> = ({ level }) => {
  const coreRadius =
    level === 'off' ? 0 : level === 'low' ? 1.6 : level === 'medium' ? 2.4 : 3.2

  return (
    <svg
      className={`thinking-ink-svg ${level === 'off' ? 'is-off' : 'is-on'}`}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="7"
        cy="7"
        r="5.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray={level === 'off' ? '2 1.8' : undefined}
      />
      {coreRadius > 0 && (
        <circle cx="7" cy="7" r={coreRadius} fill="currentColor" />
      )}
    </svg>
  )
}

// A globe in the same ink as the thinking dial: dashed when off.
const WebInkIcon: React.FC<{ on: boolean }> = ({ on }) => (
  <svg className={`thinking-ink-svg ${on ? 'is-on' : 'is-off'}`} viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="5.2" stroke="currentColor" strokeWidth="1.3" strokeDasharray={on ? undefined : '2 1.8'} />
    {on && (
      <>
        <ellipse cx="7" cy="7" rx="2.2" ry="5.2" stroke="currentColor" strokeWidth="1.1" />
        <path d="M2 7h10" stroke="currentColor" strokeWidth="1.1" />
      </>
    )}
  </svg>
)

export const ChatInputBox: React.FC<ChatInputBoxProps> = (props) => {
  const draftKey = useAppStore((s) => {
    if (props.target !== 'thread') return s.activeSessionId ? `main:${s.activeSessionId}` : `new:${s.newSessionProjectId ?? ''}`
    if (s.activeThreadId) return `thread:${s.activeThreadId}`
    const draft = s.draftThread
    return `thread-draft:${draft ? JSON.stringify([draft.parentSessionId, draft.anchorMessageId, draft.anchorStart, draft.anchorEnd]) : ''}`
  })
  return <ChatInput key={draftKey} {...props} draftKey={draftKey} />
}

const ChatInput: React.FC<ChatInputBoxProps & { draftKey: string }> = ({
  placeholder = '输入问题，Enter 发送，Shift+Enter 换行…',
  compact = false,
  target = 'main',
  refs = true,
  canOpenSettings = true,
  draftKey
}) => {
  const { text, pending, noteRefs, sessionRefs } = useAppStore((s) => s.chatDrafts[draftKey] ?? EMPTY_CHAT_DRAFT)
  const updateDraft = useAppStore((s) => s.updateChatDraft)
  // Async file reads and transcript fetches keep this key even after the input switches conversations.
  const setField = <K extends keyof ChatDraft>(field: K, value: React.SetStateAction<ChatDraft[K]>): void => {
    updateDraft(draftKey, (draft) => ({
      ...draft,
      [field]: typeof value === 'function' ? (value as (prev: ChatDraft[K]) => ChatDraft[K])(draft[field]) : value
    }))
  }
  const setText = (value: React.SetStateAction<string>): void => setField('text', value)
  const setPending = (value: React.SetStateAction<PendingFile[]>): void => setField('pending', value)
  const setNoteRefs = (value: React.SetStateAction<NoteRef[]>): void => setField('noteRefs', value)
  const setSessionRefs = (value: React.SetStateAction<ChatDraft['sessionRefs']>): void => setField('sessionRefs', value)
  const [openMenu, setOpenMenu] = useState<'model' | 'thinking' | 'search' | null>(null)
  const [dragging, setDragging] = useState(false)
  // A pasted link to a deleted session says so here until the text changes.
  const [notice, setNotice] = useState<string | null>(null)
  // Sending waits for attachments synced from another device to download.
  const [sending, setSending] = useState(false)
  const [mention, setMention] = useState<Mention | null>(null)
  const [previewing, setPreviewing] = useState<ThreadResult | null>(null)
  // After Esc, this "@" stays dismissed until it's deleted or another one is typed.
  const dismissedAt = useRef<number | null>(null)
  const pickerRef = useRef<NoteRefPickerHandle | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const plaqueRef = useRef<HTMLDivElement | null>(null)

  const models = useAppStore((s) => s.models)
  const selectedModelId = useAppStore((s) => (target === 'main' ? s.selectedModelId : s.threadModelId))
  const thinkingLevel = useAppStore((s) => s.thinkingLevel)
  // A draft thread has no session yet, so nothing of it can be streaming.
  const sessionId = useAppStore((s) => (target === 'main' ? s.activeSessionId : s.activeThreadId))
  const isStreaming = useAppStore((s) => Boolean(streamingReplyIn(s.messages, sessionId)))
  // Only the main conversation takes them: threads are one level deep.
  const bringBacks = useAppStore((s) =>
    target === 'main' && sessionId ? (s.bringBacks[sessionId] ?? NO_BRING_BACKS) : NO_BRING_BACKS
  )

  const selectModel = useAppStore((s) => s.selectModel)
  const setThinkingLevel = useAppStore((s) => s.setThinkingLevel)
  const webSearch = useAppStore((s) => s.webSearch)
  const setWebSearch = useAppStore((s) => s.setWebSearch)
  const hasSearchService = useAppStore((s) => s.searchServices.some((service) => service.hasApiKey))
  const openSearchSettings = useAppStore((s) => s.openSearchSettings)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const addFilesToStore = useAppStore((s) => s.addFiles)
  const stopStreaming = useAppStore((s) => s.stopStreaming)
  const sessions = useAppStore((s) => s.sessions)
  const markQuiz = useAppStore((s) => (target === 'main' && !s.activeSessionId ? s.markQuiz : null))
  const clearMarkQuiz = useAppStore((s) => s.clearMarkQuiz)
  const removeBringBack = useAppStore((s) => s.removeBringBack)
  const clearBringBacks = useAppStore((s) => s.clearBringBacks)

  const enabledModels = React.useMemo(
    () => models.filter((m) => m.enabled),
    [models]
  )
  const currentModel =
    enabledModels.find((m) => m.id === selectedModelId) ?? enabledModels[0]

  const addFiles = (files: File[]): void => {
    for (const f of files) {
      const key = crypto.randomUUID()
      setPending((prev) => [...prev, { key, name: f.name, file: null, error: null }])
      const update = (patch: Partial<PendingFile>): void =>
        setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)))
      import('@renderer/lib/attachments/prepare').then(({ prepareFile }) => prepareFile(f)).then(
        (file) => {
          addFilesToStore([file])
          update({ file })
        },
        (err) => {
          console.error(err)
          update({ error: err instanceof Error && err.name === 'UnsupportedFileError' ? '不支持这种文件' : '读取失败' })
        }
      )
    }
  }

  const removePending = (key: string): void => setPending((prev) => prev.filter((p) => p.key !== key))

  const readyFiles = pending.flatMap((p) => (p.file ? [p.file] : []))
  const plans = currentModel ? readyFiles.map((f) => planFile(f, currentModel)) : []
  const blocked = plans.find((p) => p.blocked)?.blocked
  const imageCount = countImages(plans)
  const problem = blocked
    ? `${blocked}，请换一个模型或移除这个附件`
    : imageCount > MAX_IMAGES_PER_MESSAGE
      ? `一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片，现在有 ${imageCount} 张`
      : null
  const stillReading = pending.some((p) => !p.file && !p.error)
  const canSend =
    Boolean(text.trim() || readyFiles.length || noteRefs.length || sessionRefs.length || bringBacks.length || markQuiz) &&
    !problem &&
    !stillReading &&
    !sending

  const updateMention = (el: HTMLTextAreaElement): void => {
    const found = refs && el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart) : null
    setMention(found && found.start !== dismissedAt.current ? found : null)
  }

  // The "@query" leaves the text; the note goes on a card. The same note or section isn't added twice.
  const pickNoteRef = (ref: NoteRef): void => {
    if (!mention) return
    const next = text.slice(0, mention.start) + text.slice(mention.end)
    const caret = mention.start
    setText(next)
    setMention(null)
    setNoteRefs((prev) => (prev.some((r) => r.label === ref.label) ? prev : [...prev, ref]))
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(caret, caret))
  }

  // The snapshot is taken now, as with a note (D-046): what the other session says later doesn't change this message.
  const addSessionRef = async (session: MainSession): Promise<void> => {
    if (sessionRefs.some((r) => r.sessionId === session.id)) return
    const transcript = await window.api.invoke('sessions:transcript', session.id)
    const ref: ChatDraft['sessionRefs'][number] = { type: 'session_ref', sessionId: session.id, label: `《${session.title}》`, text: transcript }
    setSessionRefs((prev) => (prev.some((r) => r.sessionId === ref.sessionId) ? prev : [...prev, ref]))
  }

  const pickSessionRef = (session: MainSession): void => {
    if (!mention) return
    const caret = mention.start
    setText(text.slice(0, mention.start) + text.slice(mention.end))
    setMention(null)
    void addSessionRef(session)
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(caret, caret))
  }

  const adjustHeight = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const maxPx = Math.floor(window.innerHeight * 0.4)
    const nextHeight = Math.min(el.scrollHeight, maxPx)
    el.style.height = `${Math.max(compact ? 24 : 26, nextHeight)}px`
  }

  useEffect(() => {
    adjustHeight()
  }, [text, compact])

  useEffect(() => {
    const onResize = (): void => adjustHeight()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The card arrives from the right panel; Enter should send it straight away.
  useEffect(() => {
    if (markQuiz) textareaRef.current?.focus()
  }, [markQuiz])

  useEffect(() => {
    if (!openMenu) return

    const onPointerDown = (e: MouseEvent): void => {
      if (plaqueRef.current && !plaqueRef.current.contains(e.target as Node)) {
        setOpenMenu(null)
      }
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Handled: the mini window, listening on window, stays open.
        e.preventDefault()
        setOpenMenu(null)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openMenu])

  const shownThinkingLevel = currentModel
    ? effectiveThinkingLevel(currentModel, thinkingLevel)
    : thinkingLevel
  const thinkingOptions = currentModel?.thinkingCanDisable
    ? THINKING_OPTIONS
    : THINKING_OPTIONS.filter((o) => o.value !== 'off')
  const currentThinkingOption =
    THINKING_OPTIONS.find((o) => o.value === shownThinkingLevel) ?? THINKING_OPTIONS[0]

  const handleSend = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    try {
      await sendMessage(
        text.trim(),
        [...(markQuiz ? [markQuiz] : []), ...bringBacks, ...noteRefs, ...sessionRefs, ...readyFiles.map((f) => ({ type: 'file' as const, fileId: f.id }))],
        target
      )
    } catch (err) {
      // What was typed stays, to send again once the reason (an attachment not downloaded yet) is gone.
      setNotice(errorText(err))
      return
    } finally {
      setSending(false)
    }
    setText('')
    setNoteRefs([])
    setSessionRefs([])
    setNotice(null)
    if (sessionId && bringBacks.length > 0) clearBringBacks(sessionId)
    setPreviewing(null)
    setMention(null)
    // Files that failed to read are dropped along with the rest.
    setPending([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (mention && pickerRef.current?.onKey(e)) {
      e.preventDefault()
      // Esc closes the picker only, not the right panel behind it (App.tsx listens on window).
      e.stopPropagation()
      if (e.key === 'Escape') {
        dismissedAt.current = mention.start
        setMention(null)
      }
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!isStreaming) {
        handleSend()
      }
    }
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    addFiles([...e.dataTransfer.files])
  }

  const handlePaste = (e: React.ClipboardEvent): void => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault()
      addFiles([...e.clipboardData.files])
      return
    }
    const linked = refs && pastedSessionId(e.clipboardData.getData('text/plain'))
    if (!linked) return
    e.preventDefault()
    const session = sessions.find((s): s is MainSession => s.kind === 'main' && s.id === linked)
    if (session) void addSessionRef(session)
    else setNotice('会话已删除')
  }

  return (
    <div
      className={`chat-input-box ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={handleDrop}
    >
      {mention && (
        <NoteRefPicker
          ref={pickerRef}
          query={text.slice(mention.start + 1, mention.end)}
          onPick={pickNoteRef}
          onPickSession={pickSessionRef}
          onClose={() => setMention(null)}
        />
      )}
      {(pending.length > 0 || noteRefs.length > 0 || sessionRefs.length > 0 || bringBacks.length > 0 || markQuiz) && (
        <div className="chat-input-files">
          {markQuiz && (
            <div className="file-card note-ref-card" title={markQuiz.label}>
              <span className="file-card-kind">疑问</span>
              <span className="file-card-body">
                <span className="file-card-name">{markQuiz.label}</span>
                <span className="file-card-meta">{markQuiz.marks.length} 条疑问</span>
              </span>
              <button type="button" className="file-card-remove" aria-label="移除这些疑问" onClick={clearMarkQuiz}>
                ×
              </button>
            </div>
          )}
          {bringBacks.map((b) => (
            <div
              key={`${b.messageId}:${b.text}`}
              className={`file-card bring-back-card ${previewing === b ? 'previewing' : ''}`}
              title="点一下预览带回的内容"
              onClick={() => setPreviewing((prev) => (prev === b ? null : b))}
            >
              <span className="file-card-kind">追问</span>
              <span className="file-card-body">
                <span className="file-card-name">来自追问：「{b.quote}」</span>
                <span className="file-card-meta">约 {estimateTokens(b.text)} tokens</span>
              </span>
              <button
                type="button"
                className="file-card-remove"
                aria-label="移除这段带回的内容"
                onClick={(e) => {
                  e.stopPropagation()
                  if (previewing === b) setPreviewing(null)
                  removeBringBack(sessionId!, b)
                }}
              >
                ×
              </button>
            </div>
          ))}
          {noteRefs.map((r) => (
            <div key={r.label} className="file-card note-ref-card" title={r.label}>
              <span className="file-card-kind">Note</span>
              <span className="file-card-body">
                <span className="file-card-name">{r.label}</span>
                <span className="file-card-meta">约 {estimateTokens(r.text)} tokens</span>
              </span>
              <button
                type="button"
                className="file-card-remove"
                aria-label={`移除 ${r.label}`}
                onClick={() => setNoteRefs((prev) => prev.filter((x) => x !== r))}
              >
                ×
              </button>
            </div>
          ))}
          {sessionRefs.map((r) => (
            <div key={r.sessionId} className="file-card note-ref-card" title={r.label}>
              <span className="file-card-kind">会话</span>
              <span className="file-card-body">
                <span className="file-card-name">{r.label}</span>
                <span className="file-card-meta">约 {estimateTokens(r.text)} tokens</span>
              </span>
              <button
                type="button"
                className="file-card-remove"
                aria-label={`移除 ${r.label}`}
                onClick={() => setSessionRefs((prev) => prev.filter((x) => x !== r))}
              >
                ×
              </button>
            </div>
          ))}
          {pending.map((p) =>
            p.file ? (
              <FileCard key={p.key} file={p.file} onRemove={() => removePending(p.key)} />
            ) : (
              <PendingFileCard key={p.key} name={p.name} error={p.error} onRemove={() => removePending(p.key)} />
            )
          )}
        </div>
      )}
      {previewing && bringBacks.includes(previewing) && (
        <div className="bring-back-preview">{previewing.text}</div>
      )}
      {(problem ?? notice) && <div className="chat-input-problem">{problem ?? notice}</div>}

      <textarea
        ref={textareaRef}
        className="chat-textarea"
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value)
          setNotice(null)
          if (dismissedAt.current !== null && !/[@＠]/.test(e.target.value[dismissedAt.current] ?? '')) {
            dismissedAt.current = null
          }
          updateMention(e.target)
        }}
        onSelect={(e) => updateMention(e.currentTarget)}
        onBlur={() => setMention(null)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />

      <div className="chat-input-footer">
        <div className="chat-input-meta-left" ref={plaqueRef}>
          <button
            type="button"
            className="chat-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            aria-label="添加附件"
            title="添加附件（也可以拖进来或粘贴）"
          >
            <PaperclipIcon size={15} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <div className="chat-meta-plaque">
            <div className="chat-meta-cell">
              <button
                type="button"
                className={`chat-meta-segment ${openMenu === 'model' ? 'open' : ''}`}
                onClick={() =>
                  setOpenMenu((prev) => (prev === 'model' ? null : 'model'))
                }
                aria-label="选择模型"
                aria-expanded={openMenu === 'model'}
                title={currentModel?.displayName}
              >
                <span className="chat-meta-label">
                  {currentModel?.displayName ?? '选择模型'}
                </span>
                <ChevronIcon open={openMenu === 'model'} />
              </button>

              {openMenu === 'model' && (
                <div className="chat-meta-popover model-popover" role="listbox">
                  {enabledModels.map((m) => {
                    const selected = m.id === currentModel?.id
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`chat-meta-popover-item ${selected ? 'selected' : ''}`}
                        onClick={() => {
                          selectModel(m.id, target)
                          setOpenMenu(null)
                        }}
                      >
                        <span className="popover-ink-dot" aria-hidden="true" />
                        <span className="popover-item-title">{m.displayName}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {currentModel?.supportsThinking && (
              <div className="chat-meta-cell has-divider">
                <button
                  type="button"
                  className={`chat-meta-segment ${openMenu === 'thinking' ? 'open' : ''} ${
                    shownThinkingLevel === 'off' ? 'thinking-off' : ''
                  }`}
                  onClick={() =>
                    setOpenMenu((prev) => (prev === 'thinking' ? null : 'thinking'))
                  }
                  aria-label="思考强度"
                  aria-expanded={openMenu === 'thinking'}
                >
                  <ThinkingInkIcon level={shownThinkingLevel} />
                  <span className="chat-meta-label">
                    思考 · {currentThinkingOption.shortLabel}
                  </span>
                  <ChevronIcon open={openMenu === 'thinking'} />
                </button>

                {openMenu === 'thinking' && (
                  <div className="chat-meta-popover thinking-popover" role="listbox">
                    {thinkingOptions.map((opt) => {
                      const selected = opt.value === shownThinkingLevel
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={`chat-meta-popover-item ${selected ? 'selected' : ''}`}
                          onClick={() => {
                            setThinkingLevel(opt.value)
                            setOpenMenu(null)
                          }}
                        >
                          <span className="popover-ink-dot" aria-hidden="true" />
                          <span className="popover-item-title">
                            {opt.shortLabel}
                          </span>
                          <span className="popover-item-desc">{opt.desc}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {currentModel?.supportsTools && (hasSearchService || canOpenSettings) && (
              <div className="chat-meta-cell has-divider">
                {hasSearchService ? (
                  <button
                    type="button"
                    className={`chat-meta-segment ${webSearch ? '' : 'thinking-off'}`}
                    onClick={() => setWebSearch(!webSearch)}
                    aria-pressed={webSearch}
                    title={webSearch ? '联网：模型需要时会搜索，点一下关闭' : '联网已关闭，点一下打开'}
                  >
                    <WebInkIcon on={webSearch} />
                    <span className="chat-meta-label">联网</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`chat-meta-segment thinking-off ${openMenu === 'search' ? 'open' : ''}`}
                    onClick={() => setOpenMenu((prev) => (prev === 'search' ? null : 'search'))}
                    aria-expanded={openMenu === 'search'}
                  >
                    <WebInkIcon on={false} />
                    <span className="chat-meta-label">联网</span>
                  </button>
                )}
                {openMenu === 'search' && (
                  <div className="chat-meta-popover search-setup-popover">
                    <p>联网要先填一个搜索服务的 key。Tavily 每月免费 1000 次。</p>
                    <button
                      type="button"
                      className="settings-link"
                      onClick={() => {
                        setOpenMenu(null)
                        openSearchSettings()
                      }}
                    >
                      去设置
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {isStreaming ? (
          <button
            type="button"
            className="chat-send-btn stop-mode"
            onClick={() => sessionId && stopStreaming(sessionId)}
            aria-label="停止生成"
            title="停止生成"
          >
            <svg
              className="chat-send-icon"
              viewBox="0 0 24 24"
              fill="none"
               aria-hidden="true"
            >
              <rect
                x="7"
                y="7"
                width="10"
                height="10"
                rx="1.8"
                fill="currentColor"
              />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className="chat-send-btn"
            disabled={!canSend}
            onClick={handleSend}
            aria-label="发送"
            title="发送 (Enter)"
          >
            <svg
              className="chat-send-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.95"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <g transform="rotate(38 12 12)">
                {/* Nib body */}
                <path d="M12 2.5L5.8 13.2L8.2 18.8H15.8L18.2 13.2L12 2.5Z" />
                {/* Nib slit */}
                <line x1="12" y1="3" x2="12" y2="11.2" />
                {/* Breather hole */}
                <circle cx="12" cy="12.6" r="1.35" fill="currentColor" stroke="none" />
                {/* Collar base */}
                <line x1="7.2" y1="21.2" x2="16.8" y2="21.2" />
              </g>
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
