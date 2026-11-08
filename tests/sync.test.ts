import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { listRevisions, replaceNote, saveNote } from '../src/main/db/repo/notes'

const dirty = (db: Database.Database): string[] =>
  (db.prepare('SELECT tbl, row_id FROM sync_dirty ORDER BY tbl, row_id').all() as { tbl: string; row_id: string }[]).map(
    (r) => `${r.tbl}/${r.row_id}`
  )

function freshDb(): Database.Database {
  const db = openDb(':memory:')
  db.exec('DELETE FROM sync_dirty')
  return db
}

function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO sessions (id, kind, created_at, updated_at) VALUES ('s1', 'main', 0, 0);
    INSERT INTO messages (id, session_id, seq, role, content, status, created_at) VALUES ('m1', 's1', 1, 'assistant', '答', 'done', 0);
    INSERT INTO sessions (id, kind, parent_session_id, anchor_message_id, context_mode, created_at, updated_at)
      VALUES ('t1', 'thread', 's1', 'm1', 'fork', 0, 0);
    INSERT INTO marks (id, session_id, message_id, quote, start_offset, end_offset, prefix, suffix, created_at)
      VALUES ('k1', 's1', 'm1', '答', 0, 1, '', '', 0);
  `)
}

describe('sync tracking (migration 008)', () => {
  it('upgrades a version 7 database: note ids follow their scope, and every existing row is waiting to go up', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hush-')), 'hush.db')
    const old = new Database(file)
    const dir = join(__dirname, '../src/main/db/migrations')
    for (const name of readdirSync(dir).sort().slice(0, 7)) old.exec(readFileSync(join(dir, name), 'utf8'))
    old.pragma('user_version = 7')
    old.exec(`
      INSERT INTO notes (id, scope, scope_id, content, updated_at) VALUES ('random-uuid', 'session', 's9', '旧', 0);
      INSERT INTO note_revisions (id, note_id, content, reason, created_at) VALUES ('r1', 'random-uuid', '更旧', 'merge', 0);
      INSERT INTO settings (key, value) VALUES ('system_prompt', '你好'), ('window_bounds', '{}');
    `)
    old.close()

    const db = openDb(file)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.prepare('SELECT id FROM notes').pluck().all()).toEqual(['session:s9'])
    expect(listRevisions(db, { scope: 'session', scopeId: 's9' }).map((r) => r.id)).toEqual(['r1'])
    expect(dirty(db)).toEqual([
      'mark_categories/cat-knowledge',
      'mark_categories/cat-question',
      'mark_categories/cat-quote',
      'note_revisions/r1',
      'notes/session:s9',
      'settings/system_prompt'
    ])
  })

  it('records inserts, updates and deletes, including rows removed by a cascade', () => {
    const db = freshDb()
    seed(db)
    expect(dirty(db)).toEqual(['marks/k1', 'messages/m1', 'sessions/s1', 'sessions/t1'])

    db.exec('DELETE FROM sync_dirty')
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run()
    expect(dirty(db)).toEqual(['marks/k1', 'messages/m1', 'sessions/s1', 'sessions/t1'])
  })

  it('keeps one entry per row however often it is written, as a streaming reply is', () => {
    const db = freshDb()
    seed(db)
    for (let i = 0; i < 5; i++) db.prepare("UPDATE messages SET content = ? WHERE id = 'm1'").run(`答${i}`)
    expect(dirty(db).filter((d) => d.startsWith('messages/'))).toEqual(['messages/m1'])
  })

  it('records nothing while remote changes are being applied', () => {
    const db = freshDb()
    db.exec('UPDATE sync_state SET applying = 1')
    seed(db)
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run()
    expect(dirty(db)).toEqual([])
  })

  it('records only the settings that follow the account', () => {
    const db = freshDb()
    db.exec("INSERT INTO settings (key, value) VALUES ('system_prompt', 'a'), ('window_bounds', '{}')")
    expect(dirty(db)).toEqual(['settings/system_prompt'])
  })

  it('gives a note the same id on every device, and keeps a conflicting version as a revision', () => {
    const db = freshDb()
    const target = { scope: 'project', scopeId: 'p1' } as const
    saveNote(db, target, '一')
    replaceNote(db, target, '二', 'sync_conflict')
    expect(db.prepare('SELECT id FROM notes').pluck().all()).toEqual(['project:p1'])
    expect(listRevisions(db, target).map((r) => [r.content, r.reason])).toEqual([['一', 'sync_conflict']])
  })
})
