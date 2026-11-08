import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import type { FileUploadResponse } from '@shared/sync'
import type { FileRecord } from '@shared/types'
import { getFile } from '../db/repo/files'
import { call, SyncHttpError, type SyncTransport } from './engine'

// Moves bytes to and from the signed object-storage URLs; passed in like SyncTransport, for the tests.
export type ObjectTransport = (
  method: 'PUT' | 'GET',
  url: string,
  body?: Uint8Array
) => Promise<{ status: number; body: Buffer }>

// quotaFull: the account has no room for the next file; it and the rest stay here until there is.
export type UploadResult = { uploaded: number; quotaFull: boolean }

// Runs before rows are pushed, so a device that pulls a file's row normally finds its bytes in the cloud.
export async function uploadPending(
  db: Database.Database,
  api: SyncTransport,
  objects: ObjectTransport,
  readFile: (file: FileRecord) => Buffer
): Promise<UploadResult> {
  // In the order they were added, so when room runs out it's the newest that wait.
  const ids = db
    .prepare('SELECT file_id FROM sync_uploads JOIN files ON files.id = file_id ORDER BY files.rowid')
    .pluck()
    .all() as string[]
  let uploaded = 0
  for (const id of ids) {
    const file = getFile(db, id)
    const res = await api('POST', `/files/${file.sha256}/upload`, { size: file.size })
    if (res.status === 413 && res.json?.error === 'quota_exceeded') return { uploaded, quotaFull: true }
    if (res.status !== 200) throw new SyncHttpError(res.status, res.json?.error ?? '')
    const start = res.json as FileUploadResponse
    if (!start.exists) {
      const put = await objects('PUT', start.url, readFile(file))
      if (put.status !== 200) throw new SyncHttpError(put.status, 'upload_failed')
      await call(api, 'POST', `/files/${file.sha256}/done`, {})
      uploaded++
    }
    db.prepare('DELETE FROM sync_uploads WHERE file_id = ?').run(id)
  }
  return { uploaded, quotaFull: false }
}

export async function downloadFile(api: SyncTransport, objects: ObjectTransport, sha256: string): Promise<Buffer> {
  const { url } = await call<{ url: string }>(api, 'GET', `/files/${sha256}/download`)
  const res = await objects('GET', url)
  if (res.status !== 200) throw new SyncHttpError(res.status, 'download_failed')
  if (createHash('sha256').update(res.body).digest('hex') !== sha256) {
    throw new Error(`Downloaded file does not match ${sha256}`)
  }
  return res.body
}
