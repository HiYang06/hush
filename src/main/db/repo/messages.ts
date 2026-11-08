import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Attachment, ErrorKind, Message, MessageStatus, WebActivity } from '@shared/types'
import { stripCitations } from '@shared/citations'
import { plainText } from '@shared/search'

const MESSAGE_COLUMNS = `id, session_id AS sessionId, seq, role, content, thinking,
  thinking_ms AS thinkingMs, attachments, status, error, error_kind AS errorKind, provider_id AS providerId,
  model_id AS modelId, input_tokens AS inputTokens, output_tokens AS outputTokens, web,
  created_at AS createdAt`

function toMessage(row: Record<string, unknown>): Message {
  return {
    ...row,
    attachments: JSON.parse(row.attachments as string),
    web: row.web === null ? null : JSON.parse(row.web as string)
  } as Message
}

export function listMessages(db: Database.Database, sessionId: string): Message[] {
  return (
    db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? ORDER BY seq`)
      .all(sessionId) as Record<string, unknown>[]
  ).map(toMessage)
}

// What the window shows for one conversation: the main session and every thread hanging off it.
export function listConversationMessages(db: Database.Database, mainSessionId: string): Message[] {
  return (
    db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE session_id = @id OR session_id IN (SELECT id FROM sessions WHERE parent_session_id = @id)
         ORDER BY session_id, seq`
      )
      .all({ id: mainSessionId }) as Record<string, unknown>[]
  ).map(toMessage)
}

// Tokens spent on one conversation, its threads included.
export function conversationUsage(db: Database.Database, mainSessionId: string): { input: number; output: number } {
  return db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM messages
       WHERE session_id = @id OR session_id IN (SELECT id FROM sessions WHERE parent_session_id = @id)`
    )
    .get({ id: mainSessionId }) as { input: number; output: number }
}

export function findMessage(db: Database.Database, id: string): Message | null {
  const row = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(id)
  return row ? toMessage(row as Record<string, unknown>) : null
}

export function getMessage(db: Database.Database, id: string): Message {
  const message = findMessage(db, id)
  if (!message) throw new Error(`Message ${id} not found`)
  return message
}

type NewMessage =
  | { role: 'user'; content: string; attachments: Attachment[] }
  | { role: 'assistant'; providerId: string; modelId: string }

// Appends after the session's last message; seq is what orders a conversation.
export function appendMessage(db: Database.Database, sessionId: string, message: NewMessage): Message {
  const id = randomUUID()
  const seq =
    (db.prepare('SELECT MAX(seq) FROM messages WHERE session_id = ?').pluck().get(sessionId) as
      | number
      | null) ?? 0
  if (message.role === 'user') {
    db.prepare(
      `INSERT INTO messages (id, session_id, seq, role, content, plain, attachments, status, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, ?, 'done', ?)`
    ).run(
      id,
      sessionId,
      seq + 1,
      message.content,
      plainText(message.content),
      JSON.stringify(message.attachments),
      Date.now()
    )
  } else {
    db.prepare(
      `INSERT INTO messages (id, session_id, seq, role, plain, status, provider_id, model_id, created_at)
       VALUES (?, ?, ?, 'assistant', '', 'streaming', ?, ?, ?)`
    ).run(id, sessionId, seq + 1, message.providerId, message.modelId, Date.now())
  }
  return getMessage(db, id)
}

export type ReplyProgress = {
  content: string
  thinking: string | null
  thinkingMs: number | null
  status: MessageStatus
  error: string | null
  errorKind: ErrorKind | null
  inputTokens: number | null
  outputTokens: number | null
  web: WebActivity | null
}

// Citation markers aren't text the reader sees (they render as small badges), so search skips them.
function replyPlainText(reply: ReplyProgress): string {
  const numbers = new Set(reply.web?.sources.map((s) => s.n))
  return plainText(numbers.size > 0 ? stripCitations(reply.content, numbers) : reply.content)
}

export function saveReply(db: Database.Database, id: string, reply: ReplyProgress): void {
  db.prepare(
    `UPDATE messages SET content = @content, plain = @plain, thinking = @thinking, thinking_ms = @thinkingMs,
       status = @status, error = @error, error_kind = @errorKind, input_tokens = @inputTokens, output_tokens = @outputTokens,
       web = @web
     WHERE id = @id`
  ).run({ ...reply, plain: replyPlainText(reply), web: reply.web && JSON.stringify(reply.web), id })
}

// Marks and threads anchored on these messages go with them (cascade).
export function deleteMessages(db: Database.Database, ids: string[]): void {
  const del = db.prepare('DELETE FROM messages WHERE id = ?')
  for (const id of ids) del.run(id)
}

// A reply still marked streaming at startup was cut off when the app quit; keep what arrived.
export function stopInterruptedReplies(db: Database.Database): void {
  db.prepare("UPDATE messages SET status = 'stopped' WHERE status = 'streaming'").run()
}
