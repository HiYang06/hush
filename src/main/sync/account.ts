import type Database from 'better-sqlite3'
import { decryptSecret, encryptSecret } from '../secrets'

export type Account = { email: string; token: string }

// In settings, which only syncs the keys in SYNCED_SETTINGS; the token is encrypted like an API key.
const KEY = 'sync_account'

export function readAccount(db: Database.Database): Account | null {
  const value = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(KEY) as string | undefined
  if (value === undefined) return null
  const { email, token } = JSON.parse(value) as { email: string; token: string }
  return { email, token: decryptSecret(Buffer.from(token, 'base64')) }
}

export function saveAccount(db: Database.Database, account: Account): void {
  const value = JSON.stringify({ email: account.email, token: encryptSecret(account.token).toString('base64') })
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    KEY,
    value
  )
}

export function clearAccount(db: Database.Database): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(KEY)
}
