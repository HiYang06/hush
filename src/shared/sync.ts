// The sync protocol between the app and the Hush server (D-067, docs/plans/2026-10-31-cloud-sync.md).
// Imported by server/ too, so it must stay free of imports.

export const SYNC_TABLES = [
  'projects',
  'sessions',
  'messages',
  'marks',
  'mark_categories',
  'notes',
  'note_revisions',
  'files',
  'providers',
  'models',
  'settings'
] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

// One row as the server holds it. A deleted row is a tombstone: data is null.
export type SyncRow = {
  tbl: SyncTable
  rowId: string
  seq: number
  deleted: boolean
  data: Record<string, unknown> | null
}

// baseSeq: the seq this device last saw for the row (0 = it has never seen it). When given, the server
// only writes the row if it hasn't moved on since; notes send it, everything else is last-write-wins.
export type SyncChange = {
  tbl: SyncTable
  rowId: string
  deleted: boolean
  data: Record<string, unknown> | null
  baseSeq?: number
}

export type PushResult = { ok: true; seq: number } | { ok: false; current: SyncRow | null }

// since: the cursor this device has pulled up to. If anyone pushed after it, the whole push is refused
// with 409 { error: 'stale' } and the device pulls first. Otherwise two devices that both continued a
// session offline could both get their turn onto the server, at the same seq. The app always sends it.
export type PushRequest = { changes: SyncChange[]; since?: number }
// cursor: the server's latest seq after this push. Nothing from other devices sits between the request's
// since and it, so the device can move its pull cursor there without pulling its own rows back.
export type PushResponse = { results: PushResult[]; cursor: number }
export type PullResponse = { rows: SyncRow[]; cursor: number; more: boolean }
export type AuthResponse = { token: string; email: string }
// usage and quota are bytes of attachments in object storage.
export type MeResponse = { email: string; usage: number; quota: number }
// exists: the account already has this file, nothing to upload.
export type FileUploadResponse = { exists: true } | { exists: false; url: string }

export const SYNC_PUSH_LIMIT = 500
export const SYNC_PULL_LIMIT = 1000
