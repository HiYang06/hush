import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Note, NoteRevision, NoteRevisionReason, NoteTarget } from '@shared/types'
import { plainText } from '@shared/search'

const NOTE_COLUMNS = 'id, scope, scope_id AS scopeId, content, updated_at AS updatedAt'
const REVISION_LIMIT = 20

// Only notes that were ever written, most recently changed first.
export function listNotes(db: Database.Database): Note[] {
  return db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes ORDER BY updated_at DESC`).all() as Note[]
}

// A note's row is created on its first write; until then it reads as empty.
export function getNoteContent(db: Database.Database, target: NoteTarget): string {
  return (db
    .prepare('SELECT content FROM notes WHERE scope = ? AND scope_id = ?')
    .pluck()
    .get(target.scope, target.scopeId) ?? '') as string
}

// Derived from the scope, not random, so the same note written on two devices is one row to sync (D-067).
export const noteId = (target: NoteTarget): string => `${target.scope}:${target.scopeId}`

export function saveNote(db: Database.Database, target: NoteTarget, content: string): void {
  db.prepare(
    `INSERT INTO notes (id, scope, scope_id, content, plain, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (scope, scope_id) DO UPDATE SET
       content = excluded.content, plain = excluded.plain, updated_at = excluded.updated_at`
  ).run(noteId(target), target.scope, target.scopeId, content, plainText(content), Date.now())
}

// The block goes after a blank line, so it never runs into the paragraph before it.
export function withAppended(content: string, block: string): string {
  const current = content.trimEnd()
  return `${current ? `${current}\n\n` : ''}${block}\n`
}

export function appendToNote(db: Database.Database, target: NoteTarget, block: string): string {
  const content = withAppended(getNoteContent(db, target), block)
  saveNote(db, target, content)
  return content
}

// For writes the user didn't type (D-014): what was there is kept as a revision first, and only the
// latest REVISION_LIMIT are kept. A note that doesn't exist yet has nothing to keep.
export function replaceNote(
  db: Database.Database,
  target: NoteTarget,
  content: string,
  reason: NoteRevisionReason
): void {
  db.transaction(() => {
    const current = db
      .prepare('SELECT id, content FROM notes WHERE scope = ? AND scope_id = ?')
      .get(target.scope, target.scopeId) as { id: string; content: string } | undefined
    if (current) {
      db.prepare(
        'INSERT INTO note_revisions (id, note_id, content, reason, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(randomUUID(), current.id, current.content, reason, Date.now())
      // rowid breaks ties between revisions written in the same millisecond.
      db.prepare(
        `DELETE FROM note_revisions WHERE note_id = @id AND rowid NOT IN
           (SELECT rowid FROM note_revisions WHERE note_id = @id ORDER BY created_at DESC, rowid DESC LIMIT @limit)`
      ).run({ id: current.id, limit: REVISION_LIMIT })
    }
    saveNote(db, target, content)
  })()
}

export function listRevisions(db: Database.Database, target: NoteTarget): NoteRevision[] {
  return db
    .prepare(
      `SELECT r.id, r.note_id AS noteId, r.content, r.reason, r.created_at AS createdAt FROM note_revisions r
       JOIN notes n ON n.id = r.note_id
       WHERE n.scope = ? AND n.scope_id = ? ORDER BY r.created_at DESC, r.rowid DESC`
    )
    .all(target.scope, target.scopeId) as NoteRevision[]
}

// Restoring is itself a revision, so a restore can be undone the same way.
export function restoreRevision(db: Database.Database, id: string): { target: NoteTarget; content: string } {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT r.content, n.scope, n.scope_id AS scopeId FROM note_revisions r
         JOIN notes n ON n.id = r.note_id WHERE r.id = ?`
      )
      .get(id) as { content: string; scope: NoteTarget['scope']; scopeId: string } | undefined
    if (!row) throw new Error(`Note revision ${id} not found`)
    const target: NoteTarget = { scope: row.scope, scopeId: row.scopeId }
    replaceNote(db, target, row.content, 'restore')
    return { target, content: row.content }
  })()
}

// product.md §1: a standalone session's note goes to the end of the project's note when it moves in.
export function mergeSessionNote(db: Database.Database, session: { id: string; title: string }, projectId: string): void {
  const own: NoteTarget = { scope: 'session', scopeId: session.id }
  const content = getNoteContent(db, own).trim()
  if (content) {
    const project: NoteTarget = { scope: 'project', scopeId: projectId }
    const block = `## 来自《${session.title}》\n\n${content}`
    replaceNote(db, project, withAppended(getNoteContent(db, project), block), 'merge')
  }
  db.prepare("DELETE FROM notes WHERE scope = 'session' AND scope_id = ?").run(session.id)
}
