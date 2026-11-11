import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { listMarkCategories } from '../src/main/db/repo/markCategories'
import { search } from '../src/main/db/repo/search'

function seedThread(db: ReturnType<typeof openDb>): void {
  db.exec(`
    INSERT INTO sessions (id, kind, created_at, updated_at) VALUES ('s1', 'main', 0, 0);
    INSERT INTO messages (id, session_id, seq, role, content, plain, status, created_at)
      VALUES ('m1', 's1', 1, 'assistant', '矩阵的**特征值**分解', '矩阵的特征值分解', 'done', 0);
    INSERT INTO sessions (id, kind, parent_session_id, anchor_message_id, context_mode, created_at, updated_at)
      VALUES ('t1', 'thread', 's1', 'm1', 'fork', 0, 0);
    INSERT INTO marks (id, session_id, message_id, quote, start_offset, end_offset, prefix, suffix, category_id, created_at)
      VALUES ('k1', 's1', 'm1', '特征值', 3, 6, '', '', 'cat-knowledge', 0);
  `)
}

function searchMessages(db: ReturnType<typeof openDb>, query: string): string[] {
  return db
    .prepare(
      'SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?'
    )
    .pluck()
    .all(query) as string[]
}

describe('openDb', () => {
  it('applies all migrations and seeds mark categories', () => {
    const db = openDb(':memory:')
    expect(db.pragma('user_version', { simple: true })).toBe(11)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(listMarkCategories(db)).toEqual([
      { id: 'cat-knowledge', name: '知识点', color: 'amber', sortOrder: 1 },
      { id: 'cat-question', name: '疑问', color: 'blue', sortOrder: 2 },
      { id: 'cat-quote', name: '原话', color: 'green', sortOrder: 3 }
    ])
  })

  it('does not rerun migrations when reopening an existing file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hush-')), 'hush.db')
    openDb(file).close()
    const db = openDb(file)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(listMarkCategories(db)).toHaveLength(3)
  })

  it('upgrades a version 3 database to a plain-text index, filling in existing rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hush-')), 'hush.db')
    const old = new Database(file)
    for (const name of ['001_init.sql', '002_thinking_can_disable.sql', '003_model_limits.sql']) {
      old.exec(readFileSync(join(__dirname, '../src/main/db/migrations', name), 'utf8'))
    }
    old.pragma('user_version = 3')
    old.exec(`
      INSERT INTO sessions (id, kind, title, created_at, updated_at) VALUES ('s1', 'main', '会话', 0, 0);
      INSERT INTO messages (id, session_id, seq, role, content, status, created_at)
        VALUES ('m1', 's1', 1, 'assistant', '矩阵的**特**征值分解', 'done', 0);
      INSERT INTO notes (id, scope, scope_id, content, updated_at) VALUES ('n1', 'global', 'global', '## 特征值', 0);
    `)
    old.close()

    const db = openDb(file)
    expect(db.pragma('user_version', { simple: true })).toBe(11)
    const found = search(db, '特征值')
    expect(found.messages.map((m) => m.snippet)).toEqual(['矩阵的特征值分解'])
    expect(found.notes.map((n) => n.snippet)).toEqual(['特征值'])
    expect(search(db, '特征').messages).toHaveLength(1)
  })

  it('fills in plain text left NULL, on the next open', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hush-')), 'hush.db')
    const first = openDb(file)
    first.exec(`
      INSERT INTO sessions (id, kind, title, created_at, updated_at) VALUES ('s1', 'main', '会话', 0, 0);
      INSERT INTO messages (id, session_id, seq, role, content, status, created_at)
        VALUES ('m1', 's1', 1, 'user', '*特征值*', 'done', 0);
    `)
    expect(search(first, '特征值').messages).toHaveLength(0)
    first.close()
    expect(search(openDb(file), '特征值').messages).toHaveLength(1)
  })

  it('enables project memory for existing projects when upgrading version 10', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hush-')), 'hush.db')
    const old = new Database(file)
    const dir = join(__dirname, '../src/main/db/migrations')
    for (const name of readdirSync(dir).sort().slice(0, 10)) old.exec(readFileSync(join(dir, name), 'utf8'))
    old.pragma('user_version = 10')
    old.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', '线代', 0, 0)")
    old.close()

    const db = openDb(file)
    expect(db.prepare("SELECT name, memory_enabled FROM projects WHERE id = 'p1'").get()).toEqual({ name: '线代', memory_enabled: 1 })
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('refuses a database newer than the app', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hush-')), 'hush.db')
    const db = openDb(file)
    db.pragma('user_version = 999')
    db.close()
    expect(() => openDb(file)).toThrow(/newer than this app supports/)
  })
})

describe('schema', () => {
  it('keeps messages_fts in sync with the plain text, including Chinese substrings', () => {
    const db = openDb(':memory:')
    seedThread(db)
    expect(searchMessages(db, '特征值')).toEqual(['m1'])

    db.prepare("UPDATE messages SET plain = '奇异值分解' WHERE id = 'm1'").run()
    expect(searchMessages(db, '特征值')).toEqual([])
    expect(searchMessages(db, '奇异值')).toEqual(['m1'])
  })

  it('deleting a main session cascades to messages, threads, marks and the search index', () => {
    const db = openDb(':memory:')
    seedThread(db)
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run()

    const count = (table: string): number =>
      db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number
    expect([count('sessions'), count('messages'), count('marks')]).toEqual([0, 0, 0])
    expect(searchMessages(db, '特征值')).toEqual([])
  })

  it('rejects a thread without its anchor', () => {
    const db = openDb(':memory:')
    expect(() =>
      db.exec("INSERT INTO sessions (id, kind, created_at, updated_at) VALUES ('t', 'thread', 0, 0)")
    ).toThrow(/CHECK constraint failed/)
  })
})
