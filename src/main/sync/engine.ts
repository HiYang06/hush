import type Database from 'better-sqlite3'
import type { NoteScope } from '@shared/types'
import {
  SYNC_PUSH_LIMIT,
  SYNC_TABLES,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SyncChange,
  type SyncRow
} from '@shared/sync'
import { replaceNote, saveNote } from '../db/repo/notes'
import { applyRemote, emptyReport, setNoteBase, type SyncReport } from './apply'
import { mergeNote } from './merge'
import { asRemote, deleteRow, keyOf, readRow, SYNCED_SETTINGS, writeRow } from './rows'

// The HTTP call, passed in so tests can hand requests straight to the server app.
export type SyncTransport = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<{ status: number; json: any }>

// The server answered with an error; code is its { error } (unauthorized, stale, …).
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`Sync request failed: ${status} ${code}`)
  }
}

// Someone may push between our pull and our push every time; past this many rounds, try again later.
const MAX_ROUNDS = 3

export async function syncOnce(db: Database.Database, transport: SyncTransport): Promise<SyncReport> {
  const report = emptyReport()
  for (let round = 0; round < MAX_ROUNDS; round++) {
    mergeReport(report, await pull(db, transport))
    if (await pushAll(db, transport, report)) return report
  }
  return report
}

// Signing in, again or to another account, starts over: everything is pulled, and everything here that
// the account doesn't have yet goes up, attachments' bytes included. Pulling first means rows the server already has are taken from
// it and lose their dirty mark, so nothing newer on the server is overwritten.
export function prepareForLogin(db: Database.Database): void {
  db.transaction(() => {
    db.prepare('UPDATE sync_state SET pull_cursor = 0').run()
    db.prepare('DELETE FROM sync_note_base').run()
    // The new account may not have these bytes yet; the server says so for the ones it has.
    db.prepare('INSERT OR IGNORE INTO sync_uploads (file_id) SELECT id FROM files').run()
    for (const tbl of SYNC_TABLES) {
      const key = keyOf(tbl)
      const only = tbl === 'settings' ? `WHERE key IN (SELECT value FROM json_each(?))` : ''
      db.prepare(`INSERT OR IGNORE INTO sync_dirty (tbl, row_id) SELECT '${tbl}', ${key} FROM ${tbl} ${only}`).run(
        ...(tbl === 'settings' ? [JSON.stringify(SYNCED_SETTINGS)] : [])
      )
    }
  })()
}

export async function call<T>(transport: SyncTransport, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await transport(method, path, body)
  if (res.status !== 200) throw new SyncHttpError(res.status, res.json?.error ?? '')
  return res.json as T
}

async function pull(db: Database.Database, transport: SyncTransport): Promise<SyncReport> {
  let cursor = db.prepare('SELECT pull_cursor FROM sync_state').pluck().get() as number
  const rows: SyncRow[] = []
  for (;;) {
    const page = await call<PullResponse>(transport, 'GET', `/sync/pull?since=${cursor}`)
    rows.push(...page.rows)
    cursor = page.cursor
    if (!page.more) break
  }
  return rows.length > 0 ? applyRemote(db, rows, cursor) : emptyReport()
}

// False when the server refused because someone pushed after our last pull.
async function pushAll(db: Database.Database, transport: SyncTransport, report: SyncReport): Promise<boolean> {
  for (;;) {
    const changes = takeBatch(db)
    if (changes.length === 0) return true
    let res: { status: number; json: any }
    try {
      const since = db.prepare('SELECT pull_cursor FROM sync_state').pluck().get() as number
      res = await transport('POST', '/sync/push', { changes, since } satisfies PushRequest)
    } catch (err) {
      putBack(db, changes)
      throw err
    }
    if (res.status === 409 && res.json?.error === 'stale') {
      putBack(db, changes)
      return false
    }
    if (res.status !== 200) {
      putBack(db, changes)
      throw new SyncHttpError(res.status, res.json?.error ?? '')
    }
    const { results, cursor } = res.json as PushResponse
    db.transaction(() => {
      db.prepare('UPDATE sync_state SET pull_cursor = ?').run(cursor)
      results.forEach((result, i) => {
        const change = changes[i]
        if (change.tbl !== 'notes') return
        if (result.ok) {
          if (change.deleted) db.prepare('DELETE FROM sync_note_base WHERE note_id = ?').run(change.rowId)
          else setNoteBase(db, change.rowId, result.seq, String(change.data!.content))
        } else {
          resolveNote(db, change, result.current!, report)
        }
      })
    })()
  }
}

// A streaming reply goes up once it's finished.
const PUSHABLE = `NOT (tbl = 'messages' AND row_id IN (SELECT id FROM messages WHERE status = 'streaming'))`

export function hasChangesToPush(db: Database.Database): boolean {
  return db.prepare(`SELECT 1 FROM sync_dirty WHERE ${PUSHABLE} LIMIT 1`).get() !== undefined
}

// Reading the rows and clearing their dirty marks in one transaction: an edit made while the push is in
// flight marks the row again, so it goes up next time instead of being lost.
function takeBatch(db: Database.Database): SyncChange[] {
  return db.transaction(() => {
    const entries = db
      // Files first: a message that arrives elsewhere before its attachment's row shows a missing card.
      .prepare(`SELECT tbl, row_id AS rowId FROM sync_dirty WHERE ${PUSHABLE} ORDER BY tbl = 'files' DESC LIMIT ?`)
      .all(SYNC_PUSH_LIMIT) as { tbl: SyncChange['tbl']; rowId: string }[]
    const baseSeq = db.prepare('SELECT seq FROM sync_note_base WHERE note_id = ?').pluck()
    const clear = db.prepare('DELETE FROM sync_dirty WHERE tbl = ? AND row_id = ?')
    return entries.map(({ tbl, rowId }) => {
      clear.run(tbl, rowId)
      const data = readRow(db, tbl, rowId) ?? null
      const change: SyncChange = { tbl, rowId, deleted: data === null, data }
      return tbl === 'notes' ? { ...change, baseSeq: (baseSeq.get(rowId) as number | undefined) ?? 0 } : change
    })
  })()
}

function putBack(db: Database.Database, changes: SyncChange[]): void {
  const mark = db.prepare('INSERT OR IGNORE INTO sync_dirty (tbl, row_id) VALUES (?, ?)')
  db.transaction(() => {
    for (const c of changes) mark.run(c.tbl, c.rowId)
  })()
}

// The server moved on since this device last saw the note. Whatever happens, the server's version
// becomes the new base, and what's left to push goes up with its seq on the next batch.
function resolveNote(db: Database.Database, change: SyncChange, server: SyncRow, report: SyncReport): void {
  const noteId = change.rowId
  report.notes.add(noteId)
  report.tables.add('notes')
  const oldBase = db.prepare('SELECT content FROM sync_note_base WHERE note_id = ?').pluck().get(noteId) as string | undefined
  // The note as it is now: it may have been edited again while the push was in flight.
  const local = readRow(db, 'notes', noteId)
  if (server.deleted) {
    // Deleted elsewhere (its session or project went), deleted here too or not: the delete wins.
    db.prepare('DELETE FROM sync_note_base WHERE note_id = ?').run(noteId)
    db.prepare("DELETE FROM sync_dirty WHERE tbl = 'notes' AND row_id = ?").run(noteId)
    if (local) asRemote(db, () => deleteRow(db, 'notes', noteId))
    return
  }
  const serverContent = String(server.data!.content)
  setNoteBase(db, noteId, server.seq, serverContent)
  if (!local) {
    // Deleted here, edited there: the delete still goes up, now against the server's seq.
    db.prepare("INSERT OR IGNORE INTO sync_dirty (tbl, row_id) VALUES ('notes', ?)").run(noteId)
    return
  }
  const localContent = String(local.content)
  const target = { scope: local.scope as NoteScope, scopeId: String(local.scope_id) }
  // No base: both devices wrote the note before ever syncing it. Treated as a conflict, like any other.
  const merged =
    localContent === serverContent || localContent.trim() === ''
      ? serverContent
      : oldBase === undefined
        ? null
        : mergeNote(oldBase, localContent, serverContent)
  if (merged !== null) {
    db.prepare("DELETE FROM sync_dirty WHERE tbl = 'notes' AND row_id = ?").run(noteId)
    asRemote(db, () => writeRow(db, 'notes', server.data!))
    if (merged !== serverContent) saveNote(db, target, merged)
    return
  }
  // The server's version replaces ours, which is kept as a revision; both writes go up (the note's
  // with the server's seq, so it's accepted).
  replaceNote(db, target, serverContent, 'sync_conflict')
  report.noteConflicts++
}

function mergeReport(into: SyncReport, from: SyncReport): void {
  for (const t of from.tables) into.tables.add(t)
  for (const n of from.notes) into.notes.add(n)
  into.noteConflicts += from.noteConflicts
  into.conflictCopies.push(...from.conflictCopies)
}
