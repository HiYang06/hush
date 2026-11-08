import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Pool } from 'pg'
import { deleteAccount, logout, startLogin, userForToken, verifyLogin } from './auth.ts'
import { HttpError } from './errors.ts'
import { downloadUrl, finishUpload, startUpload, usage } from './files.ts'
import type { Mailer } from './mail.ts'
import type { Storage } from './storage.ts'
import { parsePush, pull, push } from './sync.ts'
import type { MeResponse } from '../../src/shared/sync.ts'

// fileQuota: bytes of attachments each account may keep in object storage. mailDailyLimit: login mails
// per 24 hours for everyone together, null for none. privacyPage: the HTML served at /privacy.
export type Deps = {
  pool: Pool
  mailer: Mailer
  storage: Storage
  fileQuota: number
  mailDailyLimit: number | null
  privacyPage: string
}

type Env = { Variables: { userId: string; email: string; token: string } }

const readJson = async (c: Context): Promise<Record<string, unknown>> => {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'bad_request')
  return body as Record<string, unknown>
}

const sha256Param = (c: Context): string => {
  const sha = c.req.param('sha256') ?? ''
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, 'bad_request')
  return sha
}

export function createApp({ pool, mailer, storage, fileQuota, mailDailyLimit, privacyPage }: Deps): Hono<Env> {
  const app = new Hono<Env>()

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code }, err.status)
    console.error(err)
    return c.json({ error: 'internal' }, 500)
  })
  // A push of 500 rows with long replies stays well under this.
  app.use(bodyLimit({ maxSize: 20 * 1024 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }))

  app.get('/health', (c) => c.json({ ok: true }))
  app.get('/privacy', (c) => c.html(privacyPage))

  app.post('/auth/start', async (c) => {
    // nginx sets X-Real-IP from Cloudflare's CF-Connecting-IP and overwrites whatever the client sent.
    const ip = c.req.header('X-Real-IP') ?? 'unknown'
    await startLogin(pool, mailer, (await readJson(c)).email, ip, mailDailyLimit)
    return c.json({ ok: true })
  })
  app.post('/auth/verify', async (c) => {
    const body = await readJson(c)
    return c.json(await verifyLogin(pool, body.email, body.code))
  })

  const authed = new Hono<Env>()
  authed.use(async (c, next) => {
    const token = c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1]
    const user = token ? await userForToken(pool, token) : undefined
    if (!token || !user) throw new HttpError(401, 'unauthorized')
    c.set('userId', user.id)
    c.set('email', user.email)
    c.set('token', token)
    await next()
  })
  authed.get('/me', async (c) =>
    c.json({ email: c.get('email'), usage: await usage(pool, c.get('userId')), quota: fileQuota } satisfies MeResponse)
  )
  authed.post('/auth/logout', async (c) => {
    await logout(pool, c.get('token'))
    return c.json({ ok: true })
  })
  authed.delete('/account', async (c) => {
    await deleteAccount(pool, storage, c.get('userId'))
    return c.json({ ok: true })
  })
  authed.post('/sync/push', async (c) => {
    return c.json(await push(pool, c.get('userId'), parsePush(await readJson(c))))
  })
  authed.get('/sync/pull', async (c) => c.json(await pull(pool, c.get('userId'), c.req.query('since'))))
  authed.post('/files/:sha256/upload', async (c) => {
    const sha = sha256Param(c)
    return c.json(await startUpload(pool, storage, fileQuota, c.get('userId'), sha, (await readJson(c)).size))
  })
  authed.post('/files/:sha256/done', async (c) => {
    await finishUpload(pool, storage, c.get('userId'), sha256Param(c))
    return c.json({ ok: true })
  })
  authed.get('/files/:sha256/download', async (c) =>
    c.json({ url: await downloadUrl(pool, storage, c.get('userId'), sha256Param(c)) })
  )
  app.route('/', authed)

  return app
}
