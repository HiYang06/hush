import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import pg from 'pg'
import { createApp } from './app.ts'
import { migrate } from './db.ts'
import { consoleMailer, resendMailer } from './mail.ts'
import { createStorage } from './storage.ts'

function need(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

// Printing codes to the log is for local runs only; in production a missing key must stop the server.
const mailer =
  process.env.NODE_ENV === 'production' || process.env.RESEND_API_KEY
    ? resendMailer(need('RESEND_API_KEY'), need('MAIL_FROM'))
    : consoleMailer

const pool = new pg.Pool({ connectionString: need('DATABASE_URL') })
await migrate(pool)

// Attachments each account may keep in R2; raising it needs only a restart, no app release.
const FILE_QUOTA_MB = Number(process.env.FILE_QUOTA_MB ?? 1024)
// Login mails per 24 hours for everyone, under Resend's free daily quota of 100; 0 turns the limit off.
const MAIL_DAILY_LIMIT = Number(process.env.MAIL_DAILY_LIMIT ?? 90)

const app = createApp({
  pool,
  mailer,
  fileQuota: FILE_QUOTA_MB * 1024 * 1024,
  mailDailyLimit: MAIL_DAILY_LIMIT === 0 ? null : MAIL_DAILY_LIMIT,
  privacyPage: readFileSync(join(import.meta.dirname, '../public/privacy.html'), 'utf8'),
  storage: createStorage({
    endpoint: need('R2_ENDPOINT'),
    bucket: need('R2_BUCKET'),
    accessKeyId: need('R2_ACCESS_KEY_ID'),
    secretAccessKey: need('R2_SECRET_ACCESS_KEY')
  })
})

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (info) => {
  console.log(`hush-server listening on ${info.port}`)
})
