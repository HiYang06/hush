// Pure: decides what the model sees. No database, network or files here (CLAUDE.md).
import { planFile } from '@shared/files'
import { effectiveThinkingLevel } from '@shared/thinking'
import type { Attachment, FileRecord, Message, Model, Session, ThinkingLevel } from '@shared/types'
import type { ChatMessage, ChatRequest, ContentPart } from './types'

export type ContextInput = {
  session: Session
  // This session's messages, in any order.
  messages: Message[]
  // For a thread: its main session's messages. Empty for a main session.
  parentMessages: Message[]
  // The project prompt of the main session this conversation belongs to.
  projectPrompt: string | null
  globalPrompt: string
  model: Pick<
    Model,
    | 'modelName'
    | 'supportsVision'
    | 'supportsTools'
    | 'supportsThinking'
    | 'thinkingCanDisable'
    | 'maxOutputTokens'
  >
  thinking: ThinkingLevel
  // Every file the messages attach, plus the files derived from them, with their bytes; read by the caller.
  files: Map<string, LoadedFile>
}

export type LoadedFile = { record: FileRecord; data: Buffer }

// Exactly one prompt, the first non-empty one; never concatenated. Empty means no system prompt (D-075).
export function pickSystemPrompt(projectPrompt: string | null, globalPrompt: string): string {
  return projectPrompt?.trim() || globalPrompt.trim()
}

function threadPrefix(session: Session): string | null {
  if (session.kind !== 'thread') return null
  return session.contextMode === 'fork'
    ? `我在读你上面的回答时，对这段不太理解：「${session.anchorQuote}」`
    : `关于这段话：「${session.anchorQuote}」`
}

const MARK_QUIZ_PROMPT =
  '下面是我读这个会话时标记的疑问。请针对它们考考我，检验我是不是真的理解了：一次只出一道题，先不要讲答案；等我回答后，指出对在哪、错在哪，讲清楚，再出下一道。全部考完后，总结我还没掌握的地方。'

export function expandAttachment(a: Exclude<Attachment, { type: 'file' }>): string {
  switch (a.type) {
    case 'thread_result':
      return `[追问结论] 关于「${a.quote}」：${a.text}`
    case 'note_ref':
      return `[笔记引用：${a.label}]\n${a.text}`
    case 'session_ref':
      return `[会话引用：${a.label}]\n${a.text}`
    case 'mark_quiz':
      return `[考考我：${a.label}]\n${MARK_QUIZ_PROMPT}\n\n${a.marks
        .map((m, i) => `${i + 1}. 原文：「${m.quote}」${m.comment ? `\n我的批注：${m.comment}` : ''}`)
        .join('\n\n')}`
  }
}

// Adjacent text joins into one part, so a plain-text conversation stays one text part per message.
function pushText(parts: ContentPart[], text: string): void {
  const last = parts[parts.length - 1]
  if (last?.type === 'text') last.text = `${last.text}\n\n${text}`
  else parts.push({ type: 'text', text })
}

function loaded(files: Map<string, LoadedFile>, id: string): LoadedFile {
  const file = files.get(id)
  if (!file) throw new Error(`File ${id} was not loaded`)
  return file
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

// Local date of a message, like "2026-10-25 周日". Derived from the fixed send time, so the rebuilt
// context is byte-identical every turn and the provider's cache keeps hitting.
export function messageDate(createdAt: number): string {
  const d = new Date(createdAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${WEEKDAYS[d.getDay()]}`
}

function userParts(
  message: Message,
  prefix: string | null,
  date: string | null,
  input: ContextInput
): ContentPart[] {
  const parts: ContentPart[] = []
  if (date) pushText(parts, `[${date}]`)
  for (const a of message.attachments) if (a.type !== 'file') pushText(parts, expandAttachment(a))
  for (const a of message.attachments) {
    if (a.type !== 'file') continue
    for (const p of planFile(loaded(input.files, a.fileId).record, input.model).parts) {
      if (p.type === 'text') {
        pushText(parts, p.text)
      } else {
        const { record, data } = loaded(input.files, p.fileId)
        parts.push({ type: 'image', mime: record.mime, data })
      }
    }
  }
  const own = prefix ? `${prefix}\n\n${message.content}` : message.content
  if (own.trim()) pushText(parts, own)
  return parts
}

// An earlier reply that went online keeps its [n] markers; the model gets the sources they point to,
// not the pages it read then (too many tokens every turn). Built from stored data, so the text never changes.
export function replyWithSources(m: Message): string {
  const cited = (m.web?.sources ?? []).filter((s) => m.content.includes(`[${s.n}]`))
  if (cited.length === 0) return m.content
  return `${m.content}\n\n来源：\n${cited.map((s) => `[${s.n}] ${s.title} ${s.url}`).join('\n')}`
}

// A failed or still-running reply is not part of the conversation the model should continue.
function usable(m: Message): boolean {
  return m.role === 'user' || m.status === 'done' || m.status === 'stopped'
}

// The messages the model sees, in order: for a fork thread, the main conversation up to the anchor first.
export function conversationMessages(input: Pick<ContextInput, 'session' | 'messages' | 'parentMessages'>): Message[] {
  const { session } = input
  const own = [...input.messages].sort((a, b) => a.seq - b.seq)
  let history: Message[] = []
  if (session.kind === 'thread' && session.contextMode === 'fork') {
    const anchor = input.parentMessages.find((m) => m.id === session.anchorMessageId)
    history = input.parentMessages
      .filter((m) => anchor && m.seq <= anchor.seq)
      .sort((a, b) => a.seq - b.seq)
  }
  return [...history, ...own].filter(usable)
}

export function buildContext(input: ContextInput): Omit<ChatRequest, 'signal'> {
  const { session } = input
  const firstUserId = [...input.messages].sort((a, b) => a.seq - b.seq).find((m) => m.role === 'user')?.id
  const prefix = threadPrefix(session)

  const messages: ChatMessage[] = []
  // A user message is dated only when its day differs from the previous one's.
  let lastDate: string | null = null
  for (const m of conversationMessages(input)) {
    let date: string | null = null
    if (m.role === 'user') {
      date = messageDate(m.createdAt)
      if (date === lastDate) date = null
      else lastDate = date
    }
    const content: ContentPart[] =
      m.role === 'user'
        ? userParts(m, m.id === firstUserId ? prefix : null, date, input)
        : m.content
          ? [{ type: 'text', text: replyWithSources(m) }]
          : []
    if (content.length === 0) continue
    const last = messages[messages.length - 1]
    // Skipping a failed reply can leave two user turns in a row; providers expect roles to alternate.
    if (last?.role === m.role) {
      const [first, ...rest] = content
      if (first.type === 'text') pushText(last.content, first.text)
      else last.content.push(first)
      last.content.push(...rest)
    } else {
      // Earlier thinking rides along, but adapters send it only where a provider requires it (D-030, D-053).
      messages.push({ role: m.role, content, ...(m.role === 'assistant' && m.thinking && { thinking: m.thinking }) })
    }
  }

  return {
    model: input.model.modelName,
    system: pickSystemPrompt(input.projectPrompt, input.globalPrompt),
    messages,
    thinking: input.model.supportsThinking ? effectiveThinkingLevel(input.model, input.thinking) : null,
    maxOutputTokens: input.model.maxOutputTokens
  }
}
