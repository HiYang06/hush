import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PullResponse, PushResponse, SyncChange } from '../../src/shared/sync.ts'
import { createStorage } from '../src/storage.ts'
import { startTestServer, type TestServer } from './harness.ts'

let server: TestServer
let pool: TestServer['pool']
let mail: TestServer['mail']
let call: TestServer['call']
let login: TestServer['login']

beforeAll(async () => {
  server = await startTestServer()
  ;({ pool, mail, call, login } = server)
})

afterAll(() => server.close())

let emailCount = 0
const freshEmail = (): string => `person${++emailCount}@example.com`

const note = (rowId: string, content: string, baseSeq?: number): SyncChange => ({
  tbl: 'notes',
  rowId,
  deleted: false,
  data: { content },
  ...(baseSeq === undefined ? {} : { baseSeq })
})

const pushAs = async (token: string, changes: SyncChange[]): Promise<PushResponse['results']> =>
  (await call('POST', '/sync/push', { changes }, token)).json.results

const pullAs = async (token: string, since = 0): Promise<PullResponse> =>
  (await call('GET', `/sync/pull?since=${since}`, undefined, token)).json

describe('signing in', () => {
  it('mails a code, rejects a wrong one, and signs in with the right one, case-insensitively', async () => {
    const email = freshEmail()
    expect(await call('POST', '/auth/start', { email: ` ${email.toUpperCase()} ` })).toEqual({ status: 200, json: { ok: true } })
    const code = mail.get(email)!
    expect(code).toMatch(/^\d{6}$/)

    const wrong = code === '000000' ? '000001' : '000000'
    expect(await call('POST', '/auth/verify', { email, code: wrong })).toEqual({ status: 400, json: { error: 'code_wrong' } })
    const ok = await call('POST', '/auth/verify', { email, code })
    expect(ok.json.email).toBe(email)
    expect((await call('GET', '/me', undefined, ok.json.token)).json).toMatchObject({ email })

    // A code works once.
    expect((await call('POST', '/auth/verify', { email, code })).json).toEqual({ error: 'code_expired' })
  })

  it('signing in again reaches the same account', async () => {
    const email = freshEmail()
    const first = await login(email)
    await pushAs(first, [note('global:global', '一')])
    await pool.query("UPDATE login_codes SET sent_at = now() - interval '2 minutes'")
    const second = await login(email)
    expect((await pullAs(second)).rows.map((r) => r.data)).toEqual([{ content: '一' }])
  })

  it('refuses a second code within a minute', async () => {
    const email = freshEmail()
    await call('POST', '/auth/start', { email })
    expect(await call('POST', '/auth/start', { email })).toEqual({ status: 429, json: { error: 'too_soon' } })
  })

  it('locks the code after five wrong tries, even for the right code', async () => {
    const email = freshEmail()
    await call('POST', '/auth/start', { email })
    const code = mail.get(email)!
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 5; i++) await call('POST', '/auth/verify', { email, code: wrong })
    expect(await call('POST', '/auth/verify', { email, code })).toEqual({ status: 429, json: { error: 'too_many_attempts' } })
  })

  it('rejects an expired code', async () => {
    const email = freshEmail()
    await call('POST', '/auth/start', { email })
    await pool.query("UPDATE login_codes SET expires_at = now() - interval '1 second' WHERE email = $1", [email])
    expect((await call('POST', '/auth/verify', { email, code: mail.get(email) })).json).toEqual({ error: 'code_expired' })
  })

  it('limits codes per address and per network over a day', async () => {
    const email = freshEmail()
    const again = () => pool.query("UPDATE login_codes SET sent_at = now() - interval '2 minutes'")
    for (let i = 0; i < 10; i++) {
      expect((await call('POST', '/auth/start', { email })).status).toBe(200)
      await again()
    }
    expect((await call('POST', '/auth/start', { email })).json).toEqual({ error: 'email_daily_limit' })
    // A day later the address can ask again.
    await pool.query("UPDATE code_sends SET sent_at = now() - interval '25 hours' WHERE email = $1", [email])
    expect((await call('POST', '/auth/start', { email })).status).toBe(200)

    for (let i = 0; i < 20; i++) {
      expect((await call('POST', '/auth/start', { email: freshEmail() }, undefined, '198.51.100.7')).status).toBe(200)
    }
    const blocked = await call('POST', '/auth/start', { email: freshEmail() }, undefined, '198.51.100.7')
    expect(blocked).toEqual({ status: 429, json: { error: 'ip_daily_limit' } })
  })

  it('stops mailing codes for everyone past the daily total, and a failed send is not counted', async () => {
    const small = await startTestServer({ mailDailyLimit: 2 })
    try {
      expect((await small.call('POST', '/auth/start', { email: 'a@example.com' })).status).toBe(200)
      expect((await small.call('POST', '/auth/start', { email: 'b@example.com' })).status).toBe(200)
      expect((await small.call('POST', '/auth/start', { email: 'c@example.com' })).json).toEqual({ error: 'mail_daily_limit' })
    } finally {
      await small.close()
    }
    const failing = await startTestServer({ mailDailyLimit: 1, mailFails: true })
    try {
      expect((await failing.call('POST', '/auth/start', { email: 'a@example.com' })).status).toBe(500)
      expect((await failing.pool.query('SELECT count(*)::int AS n FROM code_sends')).rows[0].n).toBe(0)
    } finally {
      await failing.close()
    }
  })

  it('rejects a malformed email', async () => {
    expect(await call('POST', '/auth/start', { email: 'not-an-email' })).toEqual({ status: 400, json: { error: 'bad_email' } })
  })

  it('needs a valid token, and logging out ends it', async () => {
    expect((await call('GET', '/sync/pull')).status).toBe(401)
    expect((await call('GET', '/sync/pull', undefined, 'made-up')).status).toBe(401)
    const token = await login()
    expect((await call('POST', '/auth/logout', {}, token)).status).toBe(200)
    expect((await call('GET', '/me', undefined, token)).status).toBe(401)
  })
})

describe('sync', () => {
  it('hands out increasing seqs and pulls only what came after the cursor', async () => {
    const token = await login()
    expect(await pushAs(token, [note('a', '1'), note('b', '1')])).toEqual([
      { ok: true, seq: 1 },
      { ok: true, seq: 2 }
    ])
    expect((await pullAs(token)).rows.map((r) => r.rowId)).toEqual(['a', 'b'])

    await pushAs(token, [note('a', '2')])
    const after = await pullAs(token, 2)
    expect(after).toEqual({
      rows: [{ tbl: 'notes', rowId: 'a', seq: 3, deleted: false, data: { content: '2' } }],
      cursor: 3,
      more: false
    })
    expect(await pullAs(token, 3)).toEqual({ rows: [], cursor: 3, more: false })
  })

  it('keeps a deleted row as a tombstone', async () => {
    const token = await login()
    await pushAs(token, [note('a', '1')])
    await pushAs(token, [{ tbl: 'notes', rowId: 'a', deleted: true, data: null }])
    expect((await pullAs(token)).rows).toEqual([{ tbl: 'notes', rowId: 'a', seq: 2, deleted: true, data: null }])
  })

  it("never shows one account's rows to another", async () => {
    const a = await login()
    const b = await login()
    await pushAs(a, [note('global:global', 'A 的')])
    expect((await pullAs(b)).rows).toEqual([])
    // Same row id in another account is a separate row.
    await pushAs(b, [note('global:global', 'B 的')])
    expect((await pullAs(a)).rows.map((r) => r.data)).toEqual([{ content: 'A 的' }])
  })

  it('writes a row sent with baseSeq only if nobody changed it since, and returns what is there otherwise', async () => {
    const token = await login()
    expect(await pushAs(token, [note('n', '设备一', 0)])).toEqual([{ ok: true, seq: 1 }])
    expect(await pushAs(token, [note('n', '设备二', 0)])).toEqual([
      { ok: false, current: { tbl: 'notes', rowId: 'n', seq: 1, deleted: false, data: { content: '设备一' } } }
    ])
    expect(await pushAs(token, [note('n', '合并后', 1)])).toEqual([{ ok: true, seq: 2 }])
  })

  it('refuses a push from a device that has not pulled what others pushed since its cursor', async () => {
    const token = await login()
    const pushSince = async (since: number, changes: SyncChange[]): Promise<{ status: number; json: any }> =>
      call('POST', '/sync/push', { since, changes }, token)
    expect(await pushSince(0, [note('a', '设备一')])).toEqual({ status: 200, json: { results: [{ ok: true, seq: 1 }], cursor: 1 } })
    // Device two pulled nothing yet: refused, and nothing is written.
    expect(await pushSince(0, [note('b', '设备二')])).toEqual({ status: 409, json: { error: 'stale' } })
    expect((await pullAs(token)).rows.map((r) => r.rowId)).toEqual(['a'])
    expect((await pushSince(1, [note('b', '设备二')])).json).toEqual({ results: [{ ok: true, seq: 2 }], cursor: 2 })
    // A batch where every row is refused still reports where the server is.
    expect((await pushSince(2, [note('a', '旧', 0)])).json.cursor).toBe(2)
    expect((await call('POST', '/sync/push', { since: -1, changes: [] }, token)).status).toBe(400)
  })

  it('pages a large pull', async () => {
    const token = await login()
    for (let batch = 0; batch < 3; batch++) {
      await pushAs(token, Array.from({ length: 400 }, (_, i) => note(`r${batch * 400 + i}`, 'x')))
    }
    const first = await pullAs(token)
    expect([first.rows.length, first.cursor, first.more]).toEqual([1000, 1000, true])
    const second = await pullAs(token, first.cursor)
    expect([second.rows.length, second.cursor, second.more]).toEqual([200, 1200, false])
  })

  it('rejects unknown tables, malformed rows and oversized batches', async () => {
    const token = await login()
    const bad = async (changes: unknown): Promise<number> => (await call('POST', '/sync/push', { changes }, token)).status
    expect(await bad([{ tbl: 'search_services', rowId: 'tavily', deleted: false, data: {} }])).toBe(400)
    expect(await bad([{ tbl: 'notes', rowId: 'a', deleted: false, data: null }])).toBe(400)
    expect(await bad([{ tbl: 'notes', rowId: 'a', deleted: true, data: { content: '' } }])).toBe(400)
    expect(await bad([{ ...note('a', '1'), baseSeq: -1 }])).toBe(400)
    expect(await bad(Array.from({ length: 501 }, (_, i) => note(`r${i}`, 'x')))).toBe(400)
    expect((await pullAs(token)).rows).toEqual([])
  })
})

describe('files', () => {
  const sha = (c: string): string => c.repeat(64)
  const userIdOf = async (email: string): Promise<string> =>
    (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id

  it("signs short-lived URLs under the account's own prefix", async () => {
    const storage = createStorage({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'hush',
      accessKeyId: 'key',
      secretAccessKey: 'secret'
    })
    const upload = new URL(await storage.uploadUrl('user-1', sha('a')))
    expect(upload.pathname).toBe(`/hush/user-1/${sha('a')}`)
    expect(upload.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(upload.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(new URL(await storage.downloadUrl('user-1', sha('a'))).pathname).toBe(upload.pathname)
  })

  it('uploads once, counts what was stored, and only signs downloads for stored files', async () => {
    const email = freshEmail()
    const token = await login(email)
    const userId = await userIdOf(email)
    const start = await call('POST', `/files/${sha('b')}/upload`, { size: 3 }, token)
    expect(start.json).toEqual({ exists: false, url: expect.any(String) })
    expect((await call('GET', `/files/${sha('b')}/download`, undefined, token)).status).toBe(404)
    expect((await call('POST', `/files/${sha('b')}/done`, {}, token)).json.error).toBe('not_uploaded')

    await server.objectFetch('PUT', start.json.url, Buffer.from('hello'))
    expect((await call('POST', `/files/${sha('b')}/done`, {}, token)).status).toBe(200)
    expect((await call('POST', `/files/${sha('b')}/upload`, { size: 5 }, token)).json).toEqual({ exists: true })
    expect((await call('GET', '/me', undefined, token)).json).toEqual({ email, usage: 5, quota: 1024 * 1024 * 1024 })
    const download = (await call('GET', `/files/${sha('b')}/download`, undefined, token)).json.url
    expect(download).toContain(`${userId}/${sha('b')}`)

    // Another account has none of this one's files.
    const other = await login()
    expect((await call('GET', `/files/${sha('b')}/download`, undefined, other)).status).toBe(404)
    expect((await call('POST', `/files/${sha('b')}/upload`, { size: 5 }, other)).json.exists).toBe(false)
  })

  it('refuses uploads past the quota', async () => {
    const small = await startTestServer({ fileQuota: 10 })
    try {
      const token = await small.login()
      const first = await small.call('POST', `/files/${sha('c')}/upload`, { size: 8 }, token)
      await small.objectFetch('PUT', first.json.url, Buffer.alloc(8))
      await small.call('POST', `/files/${sha('c')}/done`, {}, token)
      const over = await small.call('POST', `/files/${sha('d')}/upload`, { size: 3 }, token)
      expect(over).toEqual({ status: 413, json: { error: 'quota_exceeded' } })
      expect((await small.call('POST', `/files/${sha('d')}/upload`, { size: 2 }, token)).status).toBe(200)
    } finally {
      await small.close()
    }
  })

  it('rejects bad hashes and sizes', async () => {
    const token = await login()
    expect((await call('POST', '/files/not-a-hash/upload', { size: 1 }, token)).status).toBe(400)
    expect((await call('POST', `/files/${sha('e')}/upload`, { size: -1 }, token)).status).toBe(400)
    expect((await call('POST', `/files/${sha('e')}/upload`, {}, token)).status).toBe(400)
  })
})

describe('account', () => {
  it('deleting the account removes its rows, files and tokens, and leaves other accounts alone', async () => {
    const email = freshEmail()
    const token = await login(email)
    const other = await login()
    const sha = 'f'.repeat(64)
    for (const t of [token, other]) {
      await pushAs(t, [note('global:global', '内容')])
      const start = await call('POST', `/files/${sha}/upload`, { size: 1 }, t)
      await server.objectFetch('PUT', start.json.url, Buffer.from('x'))
      await call('POST', `/files/${sha}/done`, {}, t)
    }
    const userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id

    expect(await call('DELETE', '/account', undefined, token)).toEqual({ status: 200, json: { ok: true } })
    expect((await call('GET', '/me', undefined, token)).status).toBe(401)
    expect([...server.objects.keys()].some((k) => k.startsWith(userId))).toBe(false)
    for (const tbl of ['users', 'sync_rows', 'files', 'tokens']) {
      const column = tbl === 'users' ? 'id' : 'user_id'
      expect((await pool.query(`SELECT 1 FROM ${tbl} WHERE ${column} = $1`, [userId])).rowCount).toBe(0)
    }
    expect((await pullAs(other)).rows).toHaveLength(1)
    expect((await call('GET', `/files/${sha}/download`, undefined, other)).status).toBe(200)

    // The address can sign up again, to a new empty account.
    await pool.query("UPDATE login_codes SET sent_at = now() - interval '2 minutes'")
    expect((await pullAs(await login(email))).rows).toEqual([])
  })

  it('serves the privacy policy without signing in', async () => {
    const res = await server.app.request('/privacy')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('隐私政策')
  })
})
