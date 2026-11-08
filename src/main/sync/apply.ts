import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { SyncRow, SyncTable } from '@shared/sync'
import { asLocal, asRemote, deleteRow, isDirty, readRow, SYNCED_SETTINGS, writeRow, type RowData } from './rows'

export type SyncReport = {
  tables: Set<SyncTable>
  // Notes whose local content sync changed, so an open editor can take the new text.
  notes: Set<string>
  noteConflicts: number
  conflictCopies: string[]
}

export const emptyReport = (): SyncReport => ({ tables: new Set(), notes: new Set(), noteConflicts: 0, conflictCopies: [] })

export function setNoteBase(db: Database.Database, noteId: string, seq: number, content: string): void {
  db.prepare(
    `INSERT INTO sync_note_base (note_id, seq, content) VALUES (?, ?, ?)
     ON CONFLICT (note_id) DO UPDATE SET seq = excluded.seq, content = excluded.content`
  ).run(noteId, seq, content)
}

// Writes one pull (all of its pages) in a single transaction. Rows arrive in server seq order, which
// doesn't put parents first (a session edited later has a later seq than its messages), so foreign
// keys are only checked at the end.
export function applyRemote(db: Database.Database, rows: SyncRow[], cursor: number): SyncReport {
  const report = emptyReport()
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON')
    asRemote(db, () => {
      for (const row of applyOrder(rows)) applyRow(db, row, report)
      dropDanglingReferences(db)
    })
    db.prepare('UPDATE sync_state SET pull_cursor = ?').run(cursor)
  })()
  return report
}

// Deletes first: regenerating a reply deletes it and writes a new one at the same seq. Messages by their
// place in the session, so a clash is met at the first message of the other device's turn.
function applyOrder(rows: SyncRow[]): SyncRow[] {
  const sessionSeq = (r: SyncRow): number => (r.tbl === 'messages' ? Number(r.data!.seq) : 0)
  const kept = rows.filter((r) => !r.deleted)
  return [...rows.filter((r) => r.deleted), ...kept.sort((x, y) => sessionSeq(x) - sessionSeq(y))]
}

function applyRow(db: Database.Database, row: SyncRow, report: SyncReport): void {
  const { tbl, rowId } = row
  if (tbl === 'settings' && !SYNCED_SETTINGS.includes(rowId)) return
  if (tbl === 'notes') {
    // An unpushed local edit is merged when its push is refused, so the merge lives in one place.
    if (isDirty(db, tbl, rowId)) return
    report.notes.add(rowId)
    if (row.deleted) {
      db.prepare('DELETE FROM sync_note_base WHERE note_id = ?').run(rowId)
    } else {
      setNoteBase(db, rowId, row.seq, String(row.data!.content))
    }
  } else {
    // Everything but notes is last-write-wins, and the server's copy is the later write.
    db.prepare('DELETE FROM sync_dirty WHERE tbl = ? AND row_id = ?').run(tbl, rowId)
  }
  report.tables.add(tbl)
  if (row.deleted) {
    deleteRow(db, tbl, rowId)
    return
  }
  if (tbl === 'messages') resolveSeqClash(db, row.data!, report)
  if (tbl === 'models') resolveModelClash(db, row.data!)
  if (tbl === 'files') resolveFileClash(db, row.data!)
  writeRow(db, tbl, row.data!)
}

// Both devices continued the same session offline: the server's turn stays, and this device's unpushed
// turn moves to a copy of the session (messages before the last turn never change, so they can't be
// interleaved). Pushes are refused until a device has pulled everything (PushRequest.since), so the
// local side of a clash is always unpushed; a clean one can only be a reply the server already replaced.
function resolveSeqClash(db: Database.Database, incoming: RowData, report: SyncReport): void {
  const sessionId = String(incoming.session_id)
  const seq = Number(incoming.seq)
  const clash = db
    .prepare('SELECT id FROM messages WHERE session_id = ? AND seq = ? AND id <> ?')
    .pluck()
    .get(sessionId, seq, incoming.id) as string | undefined
  if (clash === undefined) return
  if (!isDirty(db, 'messages', clash)) {
    deleteRow(db, 'messages', clash)
    return
  }
  const copyId = randomUUID()
  // The copy and the moves are this device's own changes, so they're recorded and pushed.
  asLocal(db, () => moveToCopy(db, sessionId, seq, copyId))
  report.tables.add('sessions')
  report.conflictCopies.push(copyId)
}

function moveToCopy(db: Database.Database, sessionId: string, seq: number, copyId: string): void {
  copySession(db, sessionId, copyId)
  const local = db
    .prepare(
      `SELECT id FROM messages WHERE session_id = ? AND seq >= ?
         AND id IN (SELECT row_id FROM sync_dirty WHERE tbl = 'messages')`
    )
    .pluck()
    .all(sessionId, seq) as string[]
  const earlier = db.prepare('SELECT id FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq').pluck().all(sessionId, seq) as string[]
  // Copies of the shared start, so the copy reads (and continues) as a whole conversation.
  for (const id of earlier) writeRow(db, 'messages', { ...readRow(db, 'messages', id)!, id: randomUUID(), session_id: copyId })
  const ids = JSON.stringify(local)
  db.prepare('UPDATE messages SET session_id = ? WHERE id IN (SELECT value FROM json_each(?))').run(copyId, ids)
  db.prepare('UPDATE marks SET session_id = ? WHERE message_id IN (SELECT value FROM json_each(?))').run(copyId, ids)
  db.prepare('UPDATE sessions SET parent_session_id = ? WHERE anchor_message_id IN (SELECT value FROM json_each(?))').run(copyId, ids)
}

// Both devices added the same model to a provider before syncing: one row per (provider, model name)
// is allowed, so the server's stays and sessions here switch to it. Recorded, so the other device
// learns of the switch and the delete.
function resolveModelClash(db: Database.Database, incoming: RowData): void {
  const local = db
    .prepare('SELECT id FROM models WHERE provider_id = ? AND model_name = ? AND id <> ?')
    .pluck()
    .get(incoming.provider_id, incoming.model_name, incoming.id) as string | undefined
  if (local === undefined) return
  asLocal(db, () => {
    db.prepare('UPDATE sessions SET model_id = ? WHERE model_id = ?').run(incoming.id, local)
    deleteRow(db, 'models', local)
  })
}

// Both devices added the same bytes before syncing: sha256 is unique, so the server's row stays and what
// pointed at the local one points at it. Same bytes, so earlier messages say exactly what they said.
// Recorded, so the other device learns of the delete. The stored file is reused when the extension
// matches; otherwise it's downloaded again the first time it's needed.
function resolveFileClash(db: Database.Database, incoming: RowData): void {
  const local = db
    .prepare('SELECT id FROM files WHERE sha256 = ? AND id <> ?')
    .pluck()
    .get(incoming.sha256, incoming.id) as string | undefined
  if (local === undefined) return
  const remote = String(incoming.id)
  asLocal(db, () => {
    for (const [tbl, column] of [
      ['messages', 'attachments'],
      ['files', 'extracted']
    ]) {
      db.prepare(`UPDATE ${tbl} SET ${column} = REPLACE(${column}, ?, ?) WHERE instr(${column}, ?) > 0`).run(
        `"fileId":"${local}"`,
        `"fileId":"${remote}"`,
        `"fileId":"${local}"`
      )
    }
    deleteRow(db, 'files', local)
  })
}

function copySession(db: Database.Database, sessionId: string, copyId: string): void {
  const session = readRow(db, 'sessions', sessionId)!
  writeRow(db, 'sessions', { ...session, id: copyId, title: `${session.title}（冲突副本）`, updated_at: Date.now() })
}

// A remote row can point at a row this device deleted and hasn't pushed the delete for yet. The delete
// wins: the reference is cleared where the schema says SET NULL, otherwise the orphan goes too.
function dropDanglingReferences(db: Database.Database): void {
  const violations = db.pragma('foreign_key_check') as { table: string; rowid: number; fkid: number }[]
  for (const v of violations) {
    const fk = (db.pragma(`foreign_key_list(${v.table})`) as { id: number; from: string; on_delete: string }[]).find(
      (f) => f.id === v.fkid
    )!
    if (fk.on_delete === 'SET NULL') {
      db.prepare(`UPDATE ${v.table} SET ${fk.from} = NULL WHERE rowid = ?`).run(v.rowid)
    } else {
      db.prepare(`DELETE FROM ${v.table} WHERE rowid = ?`).run(v.rowid)
    }
  }
}
