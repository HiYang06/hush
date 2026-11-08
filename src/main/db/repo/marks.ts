import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Mark, MarkInput, MarkPatch } from '@shared/types'
import { getMessage } from './messages'
import { getSession } from './sessions'

const MARK_COLUMNS = `id, session_id AS sessionId, message_id AS messageId, quote,
  start_offset AS startOffset, end_offset AS endOffset, prefix, suffix, comment,
  category_id AS categoryId, created_at AS createdAt`

// Includes the marks made in its threads: session_id always names the main session.
export function listMarks(db: Database.Database, mainSessionId: string): Mark[] {
  return db.prepare(`SELECT ${MARK_COLUMNS} FROM marks WHERE session_id = ?`).all(mainSessionId) as Mark[]
}

export function getMark(db: Database.Database, id: string): Mark {
  const row = db.prepare(`SELECT ${MARK_COLUMNS} FROM marks WHERE id = ?`).get(id)
  if (!row) throw new Error(`Mark ${id} not found`)
  return row as Mark
}

// Marks never overlap (product.md §4); the window offers "编辑 mark" instead, so this is the last guard.
export function createMark(db: Database.Database, input: MarkInput): Mark {
  return db.transaction(() => {
    const overlapping = db
      .prepare('SELECT 1 FROM marks WHERE message_id = ? AND start_offset < ? AND end_offset > ?')
      .get(input.messageId, input.endOffset, input.startOffset)
    if (overlapping) throw new Error('The passage overlaps an existing mark')
    const session = getSession(db, getMessage(db, input.messageId).sessionId)
    const id = randomUUID()
    db.prepare(
      `INSERT INTO marks (id, session_id, message_id, quote, start_offset, end_offset, prefix, suffix,
         comment, category_id, created_at)
       VALUES (@id, @sessionId, @messageId, @quote, @startOffset, @endOffset, @prefix, @suffix,
         @comment, @categoryId, @createdAt)`
    ).run({
      ...input,
      id,
      sessionId: session.kind === 'thread' ? session.parentSessionId : session.id,
      createdAt: Date.now()
    })
    return getMark(db, id)
  })()
}

export function updateMark(db: Database.Database, id: string, patch: MarkPatch): Mark {
  db.prepare('UPDATE marks SET comment = ?, category_id = ? WHERE id = ?').run(patch.comment, patch.categoryId, id)
  return getMark(db, id)
}

export function deleteMark(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM marks WHERE id = ?').run(id)
}
