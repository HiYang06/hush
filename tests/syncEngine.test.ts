import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { listRevisions, saveNote } from '../src/main/db/repo/notes'
import { createProject, getProject, updateProject } from '../src/main/db/repo/projects'
import { search } from '../src/main/db/repo/search'
import { createFileStore, type FileStore } from '../src/main/files/store'
import { prepareForLogin, syncOnce, type SyncTransport } from '../src/main/sync/engine'
import { downloadFile, uploadPending, type ObjectTransport } from '../src/main/sync/files'

// Two devices on one account, each its own database, syncing through the real server code (PGlite).
// Loaded at run time: server/ has its own tsconfig and node_modules, which the app's typecheck must
// not follow into (server/tests/harness.ts has the full type).
type TestServer = {
  call: (method: string, path: string, body?: unknown, token?: string) => Promise<{ status: number; json: any }>
  objectFetch: ObjectTransport
  login: () => Promise<string>
  close: () => Promise<void>
}
const HARNESS = '../server/tests/harness.ts'
let startServer: (options?: { fileQuota?: number }) => Promise<TestServer>
let server: TestServer
beforeAll(async () => {
  ;({ startTestServer: startServer } = (await import(/* @vite-ignore */ HARNESS)) as {
    startTestServer: typeof startServer
  })
  server = await startServer()
})
afterAll(() => server.close())

type Device = { db: Database.Database; sync: () => ReturnType<typeof syncOnce>; transport: SyncTransport }

let token: string
beforeEach(async () => {
  token = await server.login()
})

function device(intercept?: (path: string) => Promise<void> | void): Device {
  const db = openDb(':memory:')
  const transport: SyncTransport = async (method, path, body) => {
    await intercept?.(path)
    return server.call(method, path, body, token)
  }
  return { db, transport, sync: () => syncOnce(db, transport) }
}

const all = (db: Database.Database, sql: string, ...params: unknown[]): unknown[] => db.prepare(sql).all(...params)
const one = (db: Database.Database, sql: string, ...params: unknown[]): unknown => db.prepare(sql).pluck().get(...params)
const dirty = (db: Database.Database): number => one(db, 'SELECT count(*) FROM sync_dirty') as number

function seedSession(db: Database.Database, id = 's1'): void {
  db.exec(`
    INSERT INTO sessions (id, kind, title, created_at, updated_at) VALUES ('${id}', 'main', '牛顿定律', 0, 0);
    INSERT INTO messages (id, session_id, seq, role, content, plain, status, created_at) VALUES
      ('${id}-m1', '${id}', 1, 'user', '什么是惯性', '什么是惯性', 'done', 0),
      ('${id}-m2', '${id}', 2, 'assistant', '惯性是……', '惯性是……', 'done', 0);
  `)
}

function addTurn(db: Database.Database, session: string, prefix: string, seq: number): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, seq, role, content, status, created_at) VALUES
       (?, ?, ?, 'user', ?, 'done', 0), (?, ?, ?, 'assistant', ?, 'done', 0)`
  ).run(`${prefix}-q`, session, seq, `${prefix} 问`, `${prefix}-a`, session, seq + 1, `${prefix} 答`)
}

const messagesOf = (db: Database.Database, session: string): string[] =>
  db.prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY seq').pluck().all(session) as string[]

const global = { scope: 'global', scopeId: 'global' } as const
const noteOf = (db: Database.Database): string => one(db, "SELECT content FROM notes WHERE id = 'global:global'") as string

describe('sync engine', () => {
  it('syncs project memory through the server in both directions without dropping the new column', async () => {
    const a = device()
    const b = device()
    const project = createProject(a.db, '线代')
    await a.sync()
    await b.sync()
    expect(getProject(b.db, project.id).memoryEnabled).toBe(true)

    updateProject(a.db, project.id, { memoryEnabled: false })
    await a.sync()
    await b.sync()
    expect(getProject(b.db, project.id).memoryEnabled).toBe(false)
    expect(dirty(a.db) + dirty(b.db)).toBe(0)

    updateProject(b.db, project.id, { memoryEnabled: true })
    await b.sync()
    await a.sync()
    expect(getProject(a.db, project.id).memoryEnabled).toBe(true)
    expect(dirty(a.db) + dirty(b.db)).toBe(0)
  })

  it('copies everything to a new device, without the API key, and settles with nothing left to push', async () => {
    const a = device()
    seedSession(a.db)
    a.db.exec(`
      INSERT INTO providers (id, name, protocol, base_url, api_key_enc, created_at) VALUES ('p1', 'DeepSeek', 'openai_chat', 'https://x', X'0102', 0);
      INSERT INTO marks (id, session_id, message_id, quote, start_offset, end_offset, prefix, suffix, created_at)
        VALUES ('k1', 's1', 's1-m2', '惯性', 0, 2, '', '', 0);
      INSERT INTO settings (key, value) VALUES ('system_prompt', '简洁'), ('window_bounds', '{}');
    `)
    saveNote(a.db, global, '笔记')
    await a.sync()
    expect(dirty(a.db)).toBe(0)

    const b = device()
    await b.sync()
    expect(messagesOf(b.db, 's1')).toEqual(['什么是惯性', '惯性是……'])
    expect(one(b.db, "SELECT quote FROM marks WHERE id = 'k1'")).toBe('惯性')
    expect(noteOf(b.db)).toBe('笔记')
    expect(all(b.db, "SELECT name, api_key_enc FROM providers WHERE id = 'p1'")).toEqual([{ name: 'DeepSeek', api_key_enc: null }])
    expect(all(b.db, 'SELECT key, value FROM settings')).toEqual([{ key: 'system_prompt', value: '简洁' }])
    // The search index comes from B's own triggers, fed by the synced plain column.
    expect(search(b.db, '惯性是').messages.map((m) => m.id)).toEqual(['s1-m2'])
    expect(dirty(b.db)).toBe(0)

    // What B pulled isn't pushed back: a further round on either side moves nothing.
    const cursor = one(b.db, 'SELECT pull_cursor FROM sync_state')
    await a.sync()
    await b.sync()
    expect(one(b.db, 'SELECT pull_cursor FROM sync_state')).toBe(cursor)
    expect(one(a.db, "SELECT hex(api_key_enc) FROM providers WHERE id = 'p1'")).toBe('0102')
  })

  it('carries deletes, including the rows a cascade removed', async () => {
    const a = device()
    const b = device()
    seedSession(a.db)
    await a.sync()
    await b.sync()
    a.db.prepare("DELETE FROM sessions WHERE id = 's1'").run()
    await a.sync()
    await b.sync()
    expect(one(b.db, 'SELECT count(*) FROM sessions')).toBe(0)
    expect(one(b.db, 'SELECT count(*) FROM messages')).toBe(0)
  })

  it('merges note edits to different lines', async () => {
    const a = device()
    const b = device()
    saveNote(a.db, global, '一\n二\n三')
    await a.sync()
    await b.sync()
    saveNote(a.db, global, '一（A 改）\n二\n三')
    saveNote(b.db, global, '一\n二\n三（B 改）')
    await a.sync()
    const report = await b.sync()
    expect(noteOf(b.db)).toBe('一（A 改）\n二\n三（B 改）')
    expect(report.notes).toEqual(new Set(['global:global']))
    expect(report.noteConflicts).toBe(0)
    await a.sync()
    expect(noteOf(a.db)).toBe('一（A 改）\n二\n三（B 改）')
  })

  it('keeps the server version and saves ours as a revision when both changed the same line', async () => {
    const a = device()
    const b = device()
    saveNote(a.db, global, '原来')
    await a.sync()
    await b.sync()
    saveNote(a.db, global, 'A 的')
    saveNote(b.db, global, 'B 的')
    await a.sync()
    expect((await b.sync()).noteConflicts).toBe(1)
    expect(noteOf(b.db)).toBe('A 的')
    expect(listRevisions(b.db, global).map((r) => [r.content, r.reason])).toEqual([['B 的', 'sync_conflict']])
    await a.sync()
    expect(noteOf(a.db)).toBe('A 的')
    expect(listRevisions(a.db, global).map((r) => [r.content, r.reason])).toEqual([['B 的', 'sync_conflict']])
  })

  it('treats a note both devices wrote before ever syncing as a conflict', async () => {
    const a = device()
    const b = device()
    saveNote(a.db, global, 'A 先写的')
    saveNote(b.db, global, 'B 先写的')
    await a.sync()
    expect((await b.sync()).noteConflicts).toBe(1)
    expect(noteOf(b.db)).toBe('A 先写的')
    expect(listRevisions(b.db, global).map((r) => r.content)).toEqual(['B 先写的'])
  })

  it('moves a turn both devices added offline to a copy of the session, with the start of the conversation', async () => {
    const a = device()
    const b = device()
    seedSession(a.db)
    await a.sync()
    await b.sync()
    addTurn(a.db, 's1', 'A', 3)
    addTurn(b.db, 's1', 'B', 3)
    b.db.exec(`INSERT INTO marks (id, session_id, message_id, quote, start_offset, end_offset, prefix, suffix, created_at)
      VALUES ('kb', 's1', 'B-a', 'B', 0, 1, '', '', 0)`)
    await a.sync()
    const report = await b.sync()

    expect(report.conflictCopies).toHaveLength(1)
    const copy = report.conflictCopies[0]
    expect(messagesOf(b.db, 's1')).toEqual(['什么是惯性', '惯性是……', 'A 问', 'A 答'])
    expect(messagesOf(b.db, copy)).toEqual(['什么是惯性', '惯性是……', 'B 问', 'B 答'])
    expect(one(b.db, 'SELECT title FROM sessions WHERE id = ?', copy)).toBe('牛顿定律（冲突副本）')
    expect(one(b.db, "SELECT session_id FROM marks WHERE id = 'kb'")).toBe(copy)

    await a.sync()
    expect(messagesOf(a.db, 's1')).toEqual(['什么是惯性', '惯性是……', 'A 问', 'A 答'])
    expect(messagesOf(a.db, copy)).toEqual(['什么是惯性', '惯性是……', 'B 问', 'B 答'])
    // A third device starting from nothing gets the same, with no clash.
    const c = device()
    await c.sync()
    expect(messagesOf(c.db, copy)).toEqual(messagesOf(b.db, copy))
  })

  it('pulls again and retries when another device pushed between its pull and its push', async () => {
    const a = device()
    let raced = false
    const b = device(async (path) => {
      if (path === '/sync/push' && !raced) {
        raced = true
        saveNote(a.db, global, 'A 抢先')
        await a.sync()
      }
    })
    seedSession(b.db)
    await b.sync()
    expect(raced).toBe(true)
    expect(noteOf(b.db)).toBe('A 抢先')
    await a.sync()
    expect(messagesOf(a.db, 's1')).toEqual(['什么是惯性', '惯性是……'])
  })

  it('keeps an edit made while its push was in flight', async () => {
    let a: Device
    let typed = false
    a = device((path) => {
      if (path === '/sync/push' && !typed) {
        typed = true
        saveNote(a.db, global, '推送途中又改')
      }
    })
    saveNote(a.db, global, '第一版')
    await a.sync()
    // The edit marked the note again, so the same round pushed it too.
    expect(typed).toBe(true)
    expect(dirty(a.db)).toBe(0)
    const b = device()
    await b.sync()
    expect(noteOf(b.db)).toBe('推送途中又改')
  })

  it('holds a streaming reply back until it is finished', async () => {
    const a = device()
    const b = device()
    seedSession(a.db)
    a.db.prepare("UPDATE messages SET status = 'streaming' WHERE id = 's1-m2'").run()
    await a.sync()
    await b.sync()
    expect(messagesOf(b.db, 's1')).toEqual(['什么是惯性'])
    a.db.prepare("UPDATE messages SET status = 'done' WHERE id = 's1-m2'").run()
    await a.sync()
    await b.sync()
    expect(messagesOf(b.db, 's1')).toEqual(['什么是惯性', '惯性是……'])
  })

  it('keeps one row when both devices added the same model to a synced provider', async () => {
    const a = device()
    const b = device()
    a.db.exec("INSERT INTO providers (id, name, protocol, base_url, created_at) VALUES ('p1', 'X', 'openai_chat', 'https://x', 0)")
    await a.sync()
    await b.sync()
    a.db.exec("INSERT INTO models (id, provider_id, model_name, display_name) VALUES ('ma', 'p1', 'gpt', 'GPT')")
    b.db.exec(`INSERT INTO models (id, provider_id, model_name, display_name) VALUES ('mb', 'p1', 'gpt', 'GPT');
      INSERT INTO sessions (id, kind, title, provider_id, model_id, created_at, updated_at) VALUES ('s2', 'main', '', 'p1', 'mb', 0, 0)`)
    await a.sync()
    await b.sync()
    expect(all(b.db, 'SELECT id FROM models')).toEqual([{ id: 'ma' }])
    expect(one(b.db, "SELECT model_id FROM sessions WHERE id = 's2'")).toBe('ma')
    await a.sync()
    expect(one(a.db, "SELECT model_id FROM sessions WHERE id = 's2'")).toBe('ma')
  })

  it('signing in again after time signed out keeps newer changes from both sides', async () => {
    const a = device()
    const b = device()
    seedSession(a.db)
    saveNote(a.db, global, '一样的')
    await a.sync()
    await b.sync()
    // B signs out; meanwhile A renames the session and B starts a new one.
    a.db.prepare("UPDATE sessions SET title = 'A 改的标题' WHERE id = 's1'").run()
    await a.sync()
    seedSession(b.db, 's2')
    prepareForLogin(b.db)
    const report = await b.sync()

    expect(report.noteConflicts).toBe(0)
    expect(one(b.db, "SELECT title FROM sessions WHERE id = 's1'")).toBe('A 改的标题')
    expect(dirty(b.db)).toBe(0)
    await a.sync()
    expect(messagesOf(a.db, 's2')).toEqual(['什么是惯性', '惯性是……'])
    expect(one(a.db, "SELECT title FROM sessions WHERE id = 's1'")).toBe('A 改的标题')
  })
})

describe('attachments', () => {
  type FileDevice = { db: Database.Database; files: FileStore; sync: () => Promise<{ uploaded: number; quotaFull: boolean }> }

  // Uploads then syncs rows, as the sync service does; downloads go through the store like in the app.
  function fileDevice(on: TestServer, account: () => string): FileDevice {
    const db = openDb(':memory:')
    const api: SyncTransport = (method, path, body) => on.call(method, path, body, account())
    const files = createFileStore(db, mkdtempSync(join(tmpdir(), 'hush-sync-')), (sha) =>
      downloadFile(api, on.objectFetch, sha)
    )
    return {
      db,
      files,
      sync: async () => {
        const uploads = await uploadPending(db, api, on.objectFetch, files.read)
        await syncOnce(db, api)
        return uploads
      }
    }
  }

  const add = (d: FileDevice, text: string, name = 'a.txt') =>
    d.files.add({ name, mime: 'text/plain', data: new TextEncoder().encode(text), extracted: null, isScanned: null })

  function attach(db: Database.Database, session: string, fileId: string): void {
    db.prepare(
      `INSERT INTO messages (id, session_id, seq, role, content, attachments, status, created_at)
       VALUES (?, ?, 3, 'user', '看附件', ?, 'done', 0)`
    ).run(`${session}-f`, session, JSON.stringify([{ type: 'file', fileId }]))
  }

  it('uploads bytes before the row, and the other device downloads them only when needed', async () => {
    const a = fileDevice(server, () => token)
    const b = fileDevice(server, () => token)
    seedSession(a.db)
    const file = add(a, '讲义正文')
    attach(a.db, 's1', file.id)
    expect(await a.sync()).toEqual({ uploaded: 1, quotaFull: false })
    expect(one(a.db, 'SELECT count(*) FROM sync_uploads')).toBe(0)

    await b.sync()
    const there = b.files.pathOf(file)
    expect(existsSync(there)).toBe(false)
    await b.files.ensure(file)
    expect(b.files.read(file).toString()).toBe('讲义正文')
    // B's copy came from the cloud, so B never uploads it back.
    expect(await b.sync()).toEqual({ uploaded: 0, quotaFull: false })
  })

  it('keeps one row when both devices added the same bytes, pointing earlier messages at it', async () => {
    const a = fileDevice(server, () => token)
    const b = fileDevice(server, () => token)
    seedSession(a.db)
    seedSession(b.db, 's2')
    const fromA = add(a, '同一份讲义')
    const fromB = add(b, '同一份讲义', '另一个名字.txt')
    attach(a.db, 's1', fromA.id)
    attach(b.db, 's2', fromB.id)
    await a.sync()
    // B already has these bytes, so the upload is skipped (the server has them from A).
    expect(await b.sync()).toEqual({ uploaded: 0, quotaFull: false })
    await a.sync()

    for (const d of [a, b]) {
      expect(all(d.db, 'SELECT id FROM files')).toEqual([{ id: fromA.id }])
      expect(one(d.db, "SELECT attachments FROM messages WHERE id = 's2-f'")).toBe(JSON.stringify([{ type: 'file', fileId: fromA.id }]))
    }
    expect(dirty(a.db) + dirty(b.db)).toBe(0)
  })

  it('leaves files here when the account is full, and still syncs everything else', async () => {
    const small = await startServer({ fileQuota: 10 })
    try {
      const smallToken = await small.login()
      const a = fileDevice(small, () => smallToken)
      const b = fileDevice(small, () => smallToken)
      seedSession(a.db)
      add(a, '12345678')
      const big = add(a, '这份放不下了')
      attach(a.db, 's1', big.id)
      expect(await a.sync()).toEqual({ uploaded: 1, quotaFull: true })
      expect(all(a.db, 'SELECT file_id FROM sync_uploads')).toEqual([{ file_id: big.id }])

      await b.sync()
      expect(one(b.db, 'SELECT name FROM files WHERE id = ?', big.id)).toBe('a.txt')
      expect(messagesOf(b.db, 's1')).toHaveLength(3)
      await expect(b.files.ensure(big)).rejects.toMatchObject({ status: 404 })
    } finally {
      await small.close()
    }
  })
})
