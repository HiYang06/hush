import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { effectiveThinkingLevel } from '@shared/thinking'
import type {
  Mark,
  MarkCategory,
  Message,
  OrganizeInput,
  OrganizeStarted,
  StreamEvent,
  ThreadSession
} from '@shared/types'
import { getFiles } from '../db/repo/files'
import { listMarkCategories } from '../db/repo/markCategories'
import { listMarks } from '../db/repo/marks'
import { listMessages } from '../db/repo/messages'
import { getNoteContent } from '../db/repo/notes'
import { getModel } from '../db/repo/providers'
import { getSession, listSessions } from '../db/repo/sessions'
import { streamChat } from './adapters'
import { expandAttachment } from './context'
import type { ChatRequest, Connection } from './types'

// The first, fixed version (product.md §6); opened up for editing once it has been used for a while.
export const ORGANIZE_SESSION_PROMPT = `你在帮用户把一次学习对话整理成笔记。
- 输出一节或几节 Markdown，每节以「## 标题」开头，节内按知识点用「###」分小标题，每个知识点用几句话讲清楚，像用户自己写的复习笔记。
- 只写知识本身，不写对话过程（不要写"用户问了…""回答说…"）。
- 用户标出的重点和批注要体现出来；用户追问过的地方说明原来不好懂，把追问里得到的解释融进对应的知识点。
- 现有笔记里已经有的内容不要重复。没有新内容时只输出「没有需要补充的内容」。
- 代码、公式、表格照常用 Markdown，公式用 $…$ 和 $$…$$。
- 直接输出笔记，不要开场白和结尾。`

export const REWRITE_NOTE_PROMPT = `你在帮用户重新整理一份学习笔记。
- 合并重复的内容，按主题重新安排标题层级（## / ###），让结构清楚。
- 不新增笔记里没有的知识，不删除用户写下的观点和批注；只合并、调整顺序、改写措辞。
- 以「>」开头、最后一行是「> —— [《…》](hush://message/…)」的引用块是从对话收录的原文，整块原样保留，一个字都不能改，但可以挪位置。
- 输出完整的新笔记，不要开场白和结尾。`

export type SessionTranscript = {
  messages: Message[]
  threads: { thread: ThreadSession; messages: Message[] }[]
  marks: Mark[]
  categories: MarkCategory[]
  // Attached files are named, not sent: organizing needs what was discussed, not the files again.
  fileNames: Map<string, string>
  note: string
}

// A failed or still-running reply holds nothing worth organizing.
const usable = (m: Message): boolean =>
  m.role === 'user' || ((m.status === 'done' || m.status === 'stopped') && m.content.trim() !== '')

export function turn(m: Message, fileNames: Map<string, string>): string {
  if (m.role === 'assistant') return `回答：${m.content}`
  const parts = m.attachments.map((a) =>
    a.type === 'file' ? `[附件：${fileNames.get(a.fileId) ?? '文件'}]` : expandAttachment(a)
  )
  return `我：${[...parts, m.content].filter((p) => p.trim()).join('\n')}`
}

// One plain-text message: the conversation with each thread right after the reply it asks about,
// then the marks, then what the note already holds.
export function sessionTranscript(t: SessionTranscript): string {
  const byAnchor = new Map<string, SessionTranscript['threads']>()
  for (const entry of t.threads) {
    const list = byAnchor.get(entry.thread.anchorMessageId) ?? []
    list.push(entry)
    byAnchor.set(entry.thread.anchorMessageId, list)
  }

  const conversation: string[] = []
  for (const m of [...t.messages].sort((a, b) => a.seq - b.seq).filter(usable)) {
    conversation.push(turn(m, t.fileNames))
    for (const { thread, messages } of byAnchor.get(m.id) ?? []) {
      const turns = [...messages].sort((a, b) => a.seq - b.seq).filter(usable)
      if (turns.length === 0) continue
      conversation.push(
        `〔追问，关于「${thread.anchorQuote}」〕\n${turns.map((x) => turn(x, t.fileNames)).join('\n\n')}\n〔追问结束〕`
      )
    }
  }

  const sections = [`<对话>\n${conversation.join('\n\n')}\n</对话>`]
  if (t.marks.length > 0) {
    const names = new Map(t.categories.map((c) => [c.id, c.name]))
    const lines = t.marks.map((mark) => {
      const category = mark.categoryId ? names.get(mark.categoryId) : undefined
      return `- ${category ? `【${category}】` : ''}「${mark.quote}」${mark.comment ? ` 批注：${mark.comment}` : ''}`
    })
    sections.push(`<用户标出的重点>\n${lines.join('\n')}\n</用户标出的重点>`)
  }
  if (t.note.trim()) sections.push(`<现有笔记（这些已经写过，不要重复）>\n${t.note.trim()}\n</现有笔记>`)
  return sections.join('\n\n')
}

function fileNamesOf(db: Database.Database, messages: Message[]): Map<string, string> {
  const ids = messages.flatMap((m) => m.attachments.flatMap((a) => (a.type === 'file' ? [a.fileId] : [])))
  return new Map(getFiles(db, ids).map((f) => [f.id, f.name]))
}

// What a session_ref carries: the main conversation only, without threads, marks or note (D-065).
export function conversationTranscript(db: Database.Database, sessionId: string): string {
  const messages = listMessages(db, sessionId)
  return sessionTranscript({ messages, threads: [], marks: [], categories: [], fileNames: fileNamesOf(db, messages), note: '' })
}

export type OrganizerDeps = {
  db: Database.Database
  connection: (providerId: string) => Connection
  emit: (jobId: string, event: StreamEvent) => void
  stream?: (conn: Connection, req: ChatRequest) => AsyncIterable<StreamEvent>
}

export type Organizer = {
  // Returns at once; the text then streams in as `organize:event`s. Nothing is written to the database.
  start: (input: OrganizeInput) => OrganizeStarted
  stop: (jobId: string) => void
  // Resolves when every job in flight has finished; for tests.
  idle: () => Promise<void>
}

export function createOrganizer({ db, connection, emit, stream = streamChat }: OrganizerDeps): Organizer {
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>()

  function transcriptOf(sessionId: string, note: string): string {
    const main = getSession(db, sessionId)
    const threads = listSessions(db)
      .filter((s): s is ThreadSession => s.kind === 'thread' && s.parentSessionId === main.id)
      .map((thread) => ({ thread, messages: listMessages(db, thread.id) }))
    const messages = listMessages(db, main.id)
    return sessionTranscript({
      messages,
      threads,
      marks: listMarks(db, main.id),
      categories: listMarkCategories(db),
      fileNames: fileNamesOf(db, [...messages, ...threads.flatMap((t) => t.messages)]),
      note
    })
  }

  return {
    start(input) {
      const model = getModel(db, input.modelId)
      const conn = connection(model.providerId)
      const base = getNoteContent(db, input.target)
      const [system, text] =
        input.mode === 'session'
          ? [ORGANIZE_SESSION_PROMPT, transcriptOf(input.sessionId, base)]
          : [REWRITE_NOTE_PROMPT, `<笔记>\n${base}\n</笔记>`]

      const jobId = randomUUID()
      const controller = new AbortController()
      const request: ChatRequest = {
        model: model.modelName,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        thinking: model.supportsThinking ? effectiveThinkingLevel(model, input.thinking) : null,
        maxOutputTokens: model.maxOutputTokens,
        signal: controller.signal
      }
      const done = (async () => {
        for await (const event of stream(conn, request)) emit(jobId, event)
      })().finally(() => running.delete(jobId))
      running.set(jobId, { controller, done })
      return { jobId, base }
    },

    stop(jobId) {
      running.get(jobId)?.controller.abort()
    },

    async idle() {
      await Promise.all([...running.values()].map((r) => r.done))
    }
  }
}
