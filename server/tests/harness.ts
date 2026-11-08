import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import pg from 'pg'
import { createApp } from '../src/app.ts'
import { migrate } from '../src/db.ts'
import type { Storage } from '../src/storage.ts'

export type TestServer = {
  app: ReturnType<typeof createApp>
  pool: pg.Pool
  // The fake object storage: what's been uploaded, by "<userId>/<sha256>".
  objects: Map<string, Buffer>
  // Stands in for fetch() on the URLs the fake storage signs.
  objectFetch: (method: 'PUT' | 'GET', url: string, body?: Uint8Array) => Promise<{ status: number; body: Buffer }>
  mail: Map<string, string>
  // ip stands in for the X-Real-IP header nginx sets.
  call: (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    ip?: string
  ) => Promise<{ status: number; json: any }>
  login: (email?: string) => Promise<string>
  close: () => Promise<void>
}

// A real Postgres (PGlite, compiled to WebAssembly) behind a socket, so the server's own pg driver
// and SQL are what's tested. One connection: PGlite is single-connection underneath. Also used by the
// app's sync engine tests (tests/syncEngine.test.ts at the repo root).
const OBJECT_URL = 'memory://objects/'

// R2 in memory. Signed URLs are plain object addresses; signing itself is tested on createStorage.
function memoryStorage(objects: Map<string, Buffer>): Storage {
  return {
    uploadUrl: async (userId, sha256) => `${OBJECT_URL}${userId}/${sha256}`,
    downloadUrl: async (userId, sha256) => `${OBJECT_URL}${userId}/${sha256}`,
    size: async (userId, sha256) => objects.get(`${userId}/${sha256}`)?.length ?? null,
    deletePrefix: async (userId) => {
      for (const key of objects.keys()) if (key.startsWith(`${userId}/`)) objects.delete(key)
    }
  }
}

export async function startTestServer(
  options: { fileQuota?: number; mailDailyLimit?: number; mailFails?: boolean } = {}
): Promise<TestServer> {
  const pglite = await PGlite.create()
  const socket = new PGLiteSocketServer({ db: pglite, port: 0 })
  await socket.start()
  const pool = new pg.Pool({ connectionString: `postgres://postgres@${socket.getServerConn()}/postgres`, max: 1 })
  await migrate(pool)
  const mail = new Map<string, string>()
  const objects = new Map<string, Buffer>()
  const app = createApp({
    pool,
    mailer: async (email, code) => {
      if (options.mailFails) throw new Error('mail service down')
      mail.set(email, code)
    },
    storage: memoryStorage(objects),
    fileQuota: options.fileQuota ?? 1024 * 1024 * 1024,
    mailDailyLimit: options.mailDailyLimit ?? null,
    privacyPage: '<h1>隐私政策</h1>'
  })

  const objectFetch: TestServer['objectFetch'] = async (method, url, body) => {
    const key = url.slice(OBJECT_URL.length)
    if (method === 'PUT') {
      objects.set(key, Buffer.from(body!))
      return { status: 200, body: Buffer.alloc(0) }
    }
    const stored = objects.get(key)
    return stored ? { status: 200, body: stored } : { status: 404, body: Buffer.alloc(0) }
  }

  // Each call comes from its own address unless a test names one, so the per-IP limit stays out of the way.
  let ipCount = 0
  const call: TestServer['call'] = async (method, path, body, token, ip = `client-${++ipCount}`) => {
    const res = await app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Real-IP': ip,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: res.status, json: await res.json() }
  }

  let emailCount = 0
  const login: TestServer['login'] = async (email = `user${++emailCount}@example.com`) => {
    await call('POST', '/auth/start', { email })
    return (await call('POST', '/auth/verify', { email, code: mail.get(email) })).json.token
  }

  return {
    app,
    pool,
    objects,
    objectFetch,
    mail,
    call,
    login,
    close: async () => {
      await pool.end()
      await socket.stop()
      await pglite.close()
    }
  }
}
