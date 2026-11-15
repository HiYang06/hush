// Pure: decides what the model sees. No database, network or files here (CLAUDE.md).
import { planFile } from '@shared/files'
import { effectiveThinkingLevel } from '@shared/thinking'
import type { Attachment, FileRecord, Message, Model, Session, ThinkingLevel } from '@shared/types'
import type { ChatMessage, ChatRequest, ContentPart, ProjectSessionRef } from './types'

export type ContextInput = {
  session: Session
  // This session's messages, in any order.
  messages: Message[]
  // For a thread: its main session's messages. Empty for a main session.
  parentMessages: Message[]
  // For a thread: its main session, whose compaction a fork thread may start from. Null for a main session.
  parentSession: Session | null
  // Build only up to and including this message (a compaction request). Absent: the whole conversation.
  through?: string
  // The project prompt of the main session this conversation belongs to.
  projectPrompt: string | null
  projectSessions: ProjectSessionRef[]
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
  // Every file the messages attach, plus the files derived from them, with a lazy byte reader supplied by the caller.
  files: Map<string, LoadedFile>
}

export type LoadedFile = { record: FileRecord; data: () => Buffer }

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

export const MAX_LISTED_SESSIONS = 50

export function projectSessionList(sessions: ProjectSessionRef[]): string {
  if (sessions.length === 0) return ''
  const listed = [...sessions].sort((a, b) => a.n - b.n).slice(-MAX_LISTED_SESSIONS)
  const omitted = sessions.length - listed.length
  return [
    '[项目会话] 这个 project 里的其他会话。需要用到之前聊过的内容时，用 search_project_sessions 检索、read_session 阅读：',
    ...(omitted > 0 ? [`（更早的 ${omitted} 个会话没有列出，可以检索到）`] : []),
    ...listed.map((s) => `${s.n}. ${s.title}（${messageDate(s.createdAt).split(' ')[0]}）`)
  ].join('\n')
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
        parts.push({ type: 'image', mime: record.mime, data: data() })
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

type Conversation = Pick<ContextInput, 'session' | 'messages' | 'parentMessages' | 'parentSession'>

// The compaction the model starts from: the session's own, else, for a fork thread, its main session's when that
// one ends at or before the anchor (a later one summarizes replies the thread never saw). throughIndex is the
// boundary's place in conversationMessages; null when the boundary message is gone (deleted on another device).
export type ActiveCompaction = { summary: string; throughIndex: number; compactedAt: number }

export function activeCompaction(input: Conversation): ActiveCompaction | null {
  const { session, parentSession } = input
  const conversation = conversationMessages(input)
  const at = (summary: string, id: string, compactedAt: number | null): ActiveCompaction | null => {
    const throughIndex = conversation.findIndex((m) => m.id === id)
    return throughIndex === -1 ? null : { summary, throughIndex, compactedAt: compactedAt ?? 0 }
  }
  if (session.compactSummary !== null && session.compactThroughId !== null) {
    return at(session.compactSummary, session.compactThroughId, session.compactedAt)
  }
  if (session.kind !== 'thread' || session.contextMode !== 'fork' || parentSession === null) return null
  if (parentSession.compactSummary === null || parentSession.compactThroughId === null) return null
  const boundary = input.parentMessages.find((m) => m.id === parentSession.compactThroughId)
  const anchor = input.parentMessages.find((m) => m.id === session.anchorMessageId)
  if (!boundary || !anchor || boundary.seq > anchor.seq) return null
  return at(parentSession.compactSummary, boundary.id, parentSession.compactedAt)
}

// What stands in for the compacted messages: the summary, then every file they attached, as it was sent then
// (a PDF stays readable page by page). Changes only when the conversation is compacted again, so it stays cached.
function compactedParts(summary: string, compacted: Message[], input: ContextInput): ContentPart[] {
  const parts: ContentPart[] = [{ type: 'text', text: `[前面对话的摘要]\n${summary}` }]
  const fileIds = [
    ...new Set(compacted.flatMap((m) => m.attachments.flatMap((a) => (a.type === 'file' ? [a.fileId] : []))))
  ]
  if (fileIds.length > 0) pushText(parts, '[前面对话里附过的文件]')
  for (const id of fileIds) {
    for (const p of planFile(loaded(input.files, id).record, input.model).parts) {
      if (p.type === 'text') {
        pushText(parts, p.text)
      } else {
        const { record, data } = loaded(input.files, p.fileId)
        parts.push({ type: 'image', mime: record.mime, data: data() })
      }
    }
  }
  return parts
}

export function buildContext(input: ContextInput): Omit<ChatRequest, 'signal'> {
  const { session } = input
  const firstUserId = [...input.messages].sort((a, b) => a.seq - b.seq).find((m) => m.role === 'user')?.id
  const prefix = threadPrefix(session)

  let conversation = conversationMessages(input)
  if (input.through !== undefined) {
    conversation = conversation.slice(0, conversation.findIndex((m) => m.id === input.through) + 1)
  }
  const compaction = activeCompaction(input)
  const messages: ChatMessage[] = []
  if (compaction) {
    messages.push({
      role: 'user',
      content: compactedParts(compaction.summary, conversation.slice(0, compaction.throughIndex + 1), input)
    })
    conversation = conversation.slice(compaction.throughIndex + 1)
  }
  // A user message is dated only when its day differs from the previous one's.
  let lastDate: string | null = null
  for (const m of conversation) {
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
    system: [pickSystemPrompt(input.projectPrompt, input.globalPrompt), projectSessionList(input.projectSessions)]
      .filter(Boolean).join('\n\n'),
    messages,
    thinking: input.model.supportsThinking ? effectiveThinkingLevel(input.model, input.thinking) : null,
    maxOutputTokens: input.model.maxOutputTokens
  }
}
