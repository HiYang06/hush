import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuthResponse } from '../../src/shared/sync.ts'
import { inTransaction } from './db.ts'
import { HttpError } from './errors.ts'
import type { Mailer } from './mail.ts'
import type { Storage } from './storage.ts'

const MAX_ATTEMPTS = 5
// Over any 24 hours. Codes can't be guessed in bulk anyway (5 tries each); these keep one address from
// being flooded with mail and one network from spending the mail quota.
const DAILY_PER_EMAIL = 10
const DAILY_PER_IP = 20

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function normalizeEmail(input: unknown): string {
  const email = typeof input === 'string' ? input.trim().toLowerCase() : ''
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'bad_email')
  return email
}

// The code is stored and the mail sent in one transaction: if sending fails, no code is left behind
// to block the retry for a minute, and the send isn't counted. mailDailyLimit: all addresses together,
// null for none.
export async function startLogin(
  pool: Pool,
  mailer: Mailer,
  input: unknown,
  ip: string,
  mailDailyLimit: number | null
): Promise<void> {
  const email = normalizeEmail(input)
  await inTransaction(pool, async (client) => {
    const recent = await client.query(
      "SELECT 1 FROM login_codes WHERE email = $1 AND sent_at > now() - interval '60 seconds'",
      [email]
    )
    if (recent.rowCount) throw new HttpError(429, 'too_soon')
    const { rows } = await client.query<{ email: number; ip: number; total: number }>(
      `SELECT count(*) FILTER (WHERE email = $1)::int AS email, count(*) FILTER (WHERE ip = $2)::int AS ip,
              count(*)::int AS total
       FROM code_sends WHERE sent_at > now() - interval '24 hours'`,
      [email, ip]
    )
    if (rows[0].email >= DAILY_PER_EMAIL) throw new HttpError(429, 'email_daily_limit')
    if (rows[0].ip >= DAILY_PER_IP) throw new HttpError(429, 'ip_daily_limit')
    if (mailDailyLimit !== null && rows[0].total >= mailDailyLimit) throw new HttpError(429, 'mail_daily_limit')
    await client.query("DELETE FROM code_sends WHERE sent_at < now() - interval '2 days'")
    await client.query('INSERT INTO code_sends (email, ip) VALUES ($1, $2)', [email, ip])
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    await client.query(
      `INSERT INTO login_codes (email, code_hash, attempts, sent_at, expires_at)
       VALUES ($1, $2, 0, now(), now() + interval '10 minutes')
       ON CONFLICT (email) DO UPDATE SET
         code_hash = excluded.code_hash, attempts = 0, sent_at = excluded.sent_at, expires_at = excluded.expires_at`,
      [email, sha256(code)]
    )
    await mailer(email, code)
  })
}

export async function verifyLogin(pool: Pool, emailInput: unknown, code: unknown): Promise<AuthResponse> {
  const email = normalizeEmail(emailInput)
  if (typeof code !== 'string') throw new HttpError(400, 'code_wrong')
  // Counting the attempt in the same statement that reads the code, so parallel guesses can't share one.
  const row = (
    await pool.query<{ code_hash: string; attempts: number }>(
      `UPDATE login_codes SET attempts = attempts + 1 WHERE email = $1 AND expires_at > now()
       RETURNING code_hash, attempts`,
      [email]
    )
  ).rows[0]
  if (!row) throw new HttpError(400, 'code_expired')
  if (row.attempts > MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts')
  if (!timingSafeEqual(Buffer.from(sha256(code.trim())), Buffer.from(row.code_hash))) {
    throw new HttpError(400, 'code_wrong')
  }

  await pool.query('DELETE FROM login_codes WHERE email = $1', [email])
  const userId = (
    await pool.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = excluded.email RETURNING id',
      [email]
    )
  ).rows[0].id
  const token = randomBytes(32).toString('base64url')
  await pool.query('INSERT INTO tokens (token_hash, user_id) VALUES ($1, $2)', [sha256(token), userId])
  return { token, email }
}

export async function userForToken(pool: Pool, token: string): Promise<{ id: string; email: string } | undefined> {
  return (
    await pool.query<{ id: string; email: string }>(
      'SELECT u.id, u.email FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1',
      [sha256(token)]
    )
  ).rows[0]
}

// Objects first: if that fails the account is still there to retry with. The user row's cascade takes
// tokens, sync rows and file records with it.
export async function deleteAccount(pool: Pool, storage: Storage, userId: string): Promise<void> {
  await storage.deletePrefix(userId)
  await pool.query('DELETE FROM users WHERE id = $1', [userId])
}

export async function logout(pool: Pool, token: string): Promise<void> {
  await pool.query('DELETE FROM tokens WHERE token_hash = $1', [sha256(token)])
}
