import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { FileRecord } from '@shared/types'

const FILE_COLUMNS = `id, sha256, name, mime, size, path, extracted, is_scanned AS isScanned,
  created_at AS createdAt`

function toFile(row: Record<string, unknown>): FileRecord {
  return {
    ...row,
    extracted: row.extracted === null ? null : JSON.parse(row.extracted as string),
    isScanned: row.isScanned === null ? null : row.isScanned === 1
  } as FileRecord
}

export function getFile(db: Database.Database, id: string): FileRecord {
  const row = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE id = ?`).get(id)
  if (!row) throw new Error(`File ${id} not found`)
  return toFile(row as Record<string, unknown>)
}

export function getFiles(db: Database.Database, ids: string[]): FileRecord[] {
  if (ids.length === 0) return []
  return (
    db
      .prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Record<string, unknown>[]
  ).map(toFile)
}

export function findFileBySha(db: Database.Database, sha256: string): FileRecord | null {
  const row = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE sha256 = ?`).get(sha256)
  return row ? toFile(row as Record<string, unknown>) : null
}

export function insertFile(
  db: Database.Database,
  file: Omit<FileRecord, 'id' | 'createdAt'>
): FileRecord {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO files (id, sha256, name, mime, size, path, extracted, is_scanned, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    file.sha256,
    file.name,
    file.mime,
    file.size,
    file.path,
    file.extracted === null ? null : JSON.stringify(file.extracted),
    file.isScanned === null ? null : Number(file.isScanned),
    Date.now()
  )
  return getFile(db, id)
}

export function updateExtraction(
  db: Database.Database,
  id: string,
  extracted: FileRecord['extracted'],
  isScanned: FileRecord['isScanned']
): FileRecord {
  db.prepare('UPDATE files SET extracted = ?, is_scanned = ? WHERE id = ?').run(
    extracted === null ? null : JSON.stringify(extracted),
    isScanned === null ? null : Number(isScanned),
    id
  )
  return getFile(db, id)
}
