import type { Pool } from 'pg'
import type { FileUploadResponse } from '../../src/shared/sync.ts'
import { HttpError } from './errors.ts'
import type { Storage } from './storage.ts'

export async function usage(pool: Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ total: number }>(
    'SELECT COALESCE(SUM(size), 0)::bigint AS total FROM files WHERE user_id = $1',
    [userId]
  )
  return rows[0].total
}

async function has(pool: Pool, userId: string, sha256: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM files WHERE user_id = $1 AND sha256 = $2', [userId, sha256])
  return rowCount === 1
}

// The size is what the app says; the quota is checked again with R2's own number when the upload finishes.
export async function startUpload(
  pool: Pool,
  storage: Storage,
  quota: number,
  userId: string,
  sha256: string,
  size: unknown
): Promise<FileUploadResponse> {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'bad_request')
  if (await has(pool, userId, sha256)) return { exists: true }
  if ((await usage(pool, userId)) + size > quota) throw new HttpError(413, 'quota_exceeded')
  return { exists: false, url: await storage.uploadUrl(userId, sha256) }
}

// A presigned PUT can't bind the size, so the size counted is the one R2 reports for the stored object.
export async function finishUpload(pool: Pool, storage: Storage, userId: string, sha256: string): Promise<void> {
  const size = await storage.size(userId, sha256)
  if (size === null) throw new HttpError(409, 'not_uploaded')
  await pool.query(
    'INSERT INTO files (user_id, sha256, size) VALUES ($1, $2, $3) ON CONFLICT (user_id, sha256) DO NOTHING',
    [userId, sha256, size]
  )
}

export async function downloadUrl(pool: Pool, storage: Storage, userId: string, sha256: string): Promise<string> {
  if (!(await has(pool, userId, sha256))) throw new HttpError(404, 'not_found')
  return storage.downloadUrl(userId, sha256)
}
