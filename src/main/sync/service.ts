import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { AuthResponse, MeResponse } from '@shared/sync'
import type { FileRecord, SyncApplied, SyncNotice, SyncState, SyncStatus } from '@shared/types'
import type { SyncReport } from './apply'
import { clearAccount, readAccount, saveAccount } from './account'
import { call, hasChangesToPush, prepareForLogin, syncOnce, SyncHttpError, type SyncTransport } from './engine'
import { downloadFile, uploadPending, type ObjectTransport } from './files'
import { createRunner } from './runner'

export type SyncService = {
  status: () => SyncStatus
  sendCode: (email: string) => Promise<void>
  login: (email: string, code: string) => Promise<SyncStatus>
  logout: () => Promise<SyncStatus>
  // Deletes everything in the cloud; this device keeps its content and is signed out.
  deleteAccount: () => Promise<SyncStatus>
  privacyUrl: string
  markSeen: () => SyncStatus
  // An attachment's bytes from the cloud; throws a message for the person when it can't.
  download: (sha256: string) => Promise<Buffer>
  // After a local change: syncs a little later, and only if something is waiting to go up.
  changed: () => void
  // At start, on focus, every minute: pulls what other devices did.
  check: () => void
}

const REQUEST_TIMEOUT_MS = 30_000
// Attachments can be tens of MB on a slow connection.
const OBJECT_TIMEOUT_MS = 10 * 60_000

// What the server's error codes mean to the person signing in.
const LOGIN_ERRORS: Record<string, string> = {
  bad_email: '邮箱格式不对',
  too_soon: '刚发过验证码，请一分钟后再试',
  code_wrong: '验证码不对',
  code_expired: '验证码已过期，请重新发送',
  too_many_attempts: '输错次数太多，请重新发送验证码',
  email_daily_limit: '今天这个邮箱的验证码发得太多了，明天再试',
  ip_daily_limit: '今天这个网络请求的验证码太多了，明天再试',
  mail_daily_limit: '今天发送的验证码太多了，请明天再试'
}

export function httpTransport(baseUrl: string, token: string | null): SyncTransport {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    // nginx's own rate-limit answer is an HTML page, not the server's JSON.
    return { status: res.status, json: await res.json().catch(() => null) }
  }
}

const objectTransport: ObjectTransport = async (method, url, body) => {
  const res = await fetch(url, { method, body, signal: AbortSignal.timeout(OBJECT_TIMEOUT_MS) })
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) }
}

// fetch rejects with a TypeError when there's no connection at all.
const isOffline = (err: unknown): boolean =>
  err instanceof TypeError || (err instanceof DOMException && err.name === 'TimeoutError')

export function createSyncService(deps: {
  db: Database.Database
  baseUrl: string
  emitStatus: (status: SyncStatus) => void
  emitApplied: (applied: SyncApplied) => void
  readFile: (file: FileRecord) => Buffer
}): SyncService {
  const { db, baseUrl } = deps
  let state: SyncState = 'idle'
  let lastSyncedAt: number | null = null
  let error: string | null = null
  let notices: SyncNotice[] = []
  let unseen = false
  let storage: SyncStatus['storage'] = null
  let quotaFull = false

  const status = (): SyncStatus => ({
    email: readAccount(db)?.email ?? null,
    state,
    lastSyncedAt,
    error,
    notices,
    unseen,
    storage
  })
  const publish = (): void => deps.emitStatus(status())

  const notify = (texts: string[]): void => {
    if (texts.length === 0) return
    notices = [...texts.map((text) => ({ id: randomUUID(), text, at: Date.now() })), ...notices]
    unseen = true
  }

  const noticesFor = (report: SyncReport): string[] => [
    ...(report.noteConflicts > 0 ? ['note 有冲突：用了另一台设备的版本，你的版本在 note 的历史里'] : []),
    ...report.conflictCopies.map((id) => {
      const title = db.prepare('SELECT title FROM sessions WHERE id = ?').pluck().get(id) as string
      return `两台设备都接着聊了同一个会话，这台的那一轮放进了《${title}》`
    })
  ]

  const run = async (): Promise<void> => {
    const account = readAccount(db)
    if (!account || state === 'expired') return
    state = 'syncing'
    publish()
    try {
      const api = httpTransport(baseUrl, account.token)
      const uploads = await uploadPending(db, api, objectTransport, deps.readFile)
      if (uploads.quotaFull && !quotaFull) {
        const left = db.prepare('SELECT count(*) FROM sync_uploads').pluck().get() as number
        notify([`云端附件空间已满，${left} 个附件只在这台设备上，另一台设备打不开`])
      }
      quotaFull = uploads.quotaFull
      const report = await syncOnce(db, api)
      if (storage === null || uploads.uploaded > 0) {
        const me = await call<MeResponse>(api, 'GET', '/me')
        storage = { usage: me.usage, quota: me.quota }
      }
      state = 'idle'
      error = null
      lastSyncedAt = Date.now()
      notify(noticesFor(report))
      if (report.tables.size > 0 || report.notes.size > 0) {
        deps.emitApplied({ tables: [...report.tables], notes: [...report.notes] })
      }
    } catch (err) {
      if (err instanceof SyncHttpError) {
        state = err.status === 401 ? 'expired' : 'failed'
        error = err.status === 401 ? null : `服务器返回 ${err.status}`
      } else if (isOffline(err)) {
        state = 'offline'
        error = null
      } else {
        // A bug here, not a network problem: shown on the 账号与同步 page, with the stack in the console.
        console.error(err)
        state = 'failed'
        error = err instanceof Error ? err.message : String(err)
      }
    }
    publish()
  }
  const runner = createRunner(run)

  // Login calls go out before there's an account; a dropped connection gets its own message.
  const loginCall = async (
    path: string,
    body: unknown,
    token: string | null = null,
    method: 'POST' | 'DELETE' = 'POST'
  ): Promise<any> => {
    let res: { status: number; json: any }
    try {
      res = await httpTransport(baseUrl, token)(method, path, body)
    } catch {
      throw new Error('连不上同步服务器，请检查网络')
    }
    if (res.status === 200) return res.json
    const known = LOGIN_ERRORS[res.json?.error]
    if (known) throw new Error(known)
    throw new Error(res.status === 429 ? '请求太频繁，请稍后再试' : `服务器返回 ${res.status}`)
  }

  const forgetAccount = (): SyncStatus => {
    clearAccount(db)
    state = 'idle'
    error = null
    lastSyncedAt = null
    notices = []
    unseen = false
    storage = null
    quotaFull = false
    publish()
    return status()
  }

  return {
    status,
    sendCode: async (email) => {
      await loginCall('/auth/start', { email })
    },
    login: async (email, code) => {
      const auth = (await loginCall('/auth/verify', { email, code })) as AuthResponse
      saveAccount(db, auth)
      prepareForLogin(db)
      state = 'idle'
      error = null
      runner.now()
      return status()
    },
    logout: async () => {
      const account = readAccount(db)
      runner.stop()
      if (account) {
        // Signing out works offline too; the server just keeps a token nobody holds any more.
        await loginCall('/auth/logout', {}, account.token).catch(() => undefined)
      }
      return forgetAccount()
    },
    deleteAccount: async () => {
      const account = readAccount(db)
      if (!account) return status()
      // Unlike signing out, this needs the server: the cloud copy is what goes.
      await loginCall('/account', undefined, account.token, 'DELETE')
      runner.stop()
      return forgetAccount()
    },
    privacyUrl: `${baseUrl}/privacy`,
    markSeen: () => {
      unseen = false
      publish()
      return status()
    },
    download: async (sha256) => {
      const account = readAccount(db)
      if (!account) throw new Error('这个附件在另一台设备上，登录同一账号后才能下载')
      try {
        return await downloadFile(httpTransport(baseUrl, account.token), objectTransport, sha256)
      } catch (err) {
        if (isOffline(err)) throw new Error('这个附件还没下载到这台设备，联网后再试')
        if (!(err instanceof SyncHttpError)) throw err
        if (err.status === 404) throw new Error('这个附件还没从另一台设备传上来，可能是云端空间满了')
        if (err.status === 401) throw new Error('登录已过期，重新登录后才能下载附件')
        throw new Error(`下载附件失败（服务器返回 ${err.status}）`)
      }
    },
    changed: () => {
      if (state === 'expired' || !readAccount(db)) return
      if (hasChangesToPush(db)) runner.soon()
    },
    check: () => {
      if (state !== 'expired' && readAccount(db)) runner.now()
    }
  }
}
