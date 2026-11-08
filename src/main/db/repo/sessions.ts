import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Session, ThreadAnchor } from '@shared/types'
import { mergeSessionNote } from './notes'

const SESSION_COLUMNS = `id, kind, project_id AS projectId, parent_session_id AS parentSessionId,
  anchor_message_id AS anchorMessageId, anchor_quote AS anchorQuote, anchor_start AS anchorStart,
  anchor_end AS anchorEnd, anchor_prefix AS anchorPrefix, anchor_suffix AS anchorSuffix,
  context_mode AS contextMode, title, provider_id AS providerId, model_id AS modelId,
  created_at AS createdAt, updated_at AS updatedAt`

export function listSessions(db: Database.Database): Session[] {
  return db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC`)
    .all() as Session[]
}

export function getSession(db: Database.Database, id: string): Session {
  const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id)
  if (!row) throw new Error(`Session ${id} not found`)
  return row as Session
}

export function createMainSession(
  db: Database.Database,
  input: { title: string; projectId: string | null; providerId: string; modelId: string }
): Session {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, kind, project_id, title, provider_id, model_id, created_at, updated_at)
     VALUES (?, 'main', ?, ?, ?, ?, ?, ?)`
  ).run(id, input.projectId, input.title, input.providerId, input.modelId, now, now)
  return getSession(db, id)
}

export function createThreadSession(
  db: Database.Database,
  input: ThreadAnchor & { title: string; providerId: string; modelId: string }
): Session {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, kind, parent_session_id, anchor_message_id, anchor_quote, anchor_start,
       anchor_end, anchor_prefix, anchor_suffix, context_mode, title, provider_id, model_id, created_at, updated_at)
     VALUES (@id, 'thread', @parentSessionId, @anchorMessageId, @anchorQuote, @anchorStart, @anchorEnd,
       @anchorPrefix, @anchorSuffix, @contextMode, @title, @providerId, @modelId, @now, @now)`
  ).run({ ...input, id, now })
  return getSession(db, id)
}

export function renameSession(db: Database.Database, id: string, title: string): Session {
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  return getSession(db, id)
}

// The automatic title only replaces the placeholder: not a title the user typed meanwhile, nor a deleted session.
export function replacePlaceholderTitle(
  db: Database.Database,
  id: string,
  placeholder: string,
  title: string
): Session | null {
  const { changes } = db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND title = ?').run(title, id, placeholder)
  return changes > 0 ? getSession(db, id) : null
}

// Only main sessions belong to a project; a thread follows its main session (architecture.md).
// Moving doesn't touch updated_at: the session keeps its place in the time groups.
// A standalone session moving into a project brings its note along (product.md §1).
export function moveSession(db: Database.Database, id: string, projectId: string | null): Session {
  return db.transaction(() => {
    const before = getSession(db, id)
    const { changes } = db
      .prepare("UPDATE sessions SET project_id = ? WHERE id = ? AND kind = 'main'")
      .run(projectId, id)
    if (changes === 0) throw new Error(`Main session ${id} not found`)
    if (before.projectId === null && projectId !== null) mergeSessionNote(db, before, projectId)
    return getSession(db, id)
  })()
}

// Messages, marks and threads go with it through ON DELETE CASCADE; notes are keyed by scope, so by hand.
export function deleteSession(db: Database.Database, id: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM notes WHERE scope = 'session' AND scope_id = ?").run(id)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  })()
}

// Sending a message moves the session to the top of its group and remembers the model it now uses.
export function touchSession(
  db: Database.Database,
  id: string,
  model: { providerId: string; modelId: string }
): Session {
  db.prepare('UPDATE sessions SET provider_id = ?, model_id = ?, updated_at = ? WHERE id = ?').run(
    model.providerId,
    model.modelId,
    Date.now(),
    id
  )
  return getSession(db, id)
}

export function getGlobalPrompt(db: Database.Database): string {
  return (db.prepare("SELECT value FROM settings WHERE key = 'system_prompt'").pluck().get() ??
    '') as string
}

// A blank prompt is no prompt, so the built-in default applies again.
export function setGlobalPrompt(db: Database.Database, prompt: string): void {
  if (!prompt.trim()) db.prepare("DELETE FROM settings WHERE key = 'system_prompt'").run()
  else
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('system_prompt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(prompt)
}
