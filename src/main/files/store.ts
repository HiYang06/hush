import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import type { FileRecord, NewFile } from '@shared/types'
import { findFileBySha, insertFile, updateExtraction } from '../db/repo/files'

export type FileStore = {
  add: (input: NewFile) => FileRecord
  read: (file: FileRecord) => Buffer
  pathOf: (file: FileRecord) => string
  // A file synced from another device is only metadata until it's first needed; this brings its bytes.
  ensure: (file: FileRecord) => Promise<void>
}

// Fetches a file's bytes by sha256 from the cloud; throws a message for the person when it can't.
export type Download = (sha256: string) => Promise<Buffer>

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

// Files live on disk named by their sha256, so identical content is stored once (D-018).
// The extension is kept so "open with the default app" picks the right app.
export function createFileStore(db: Database.Database, dir: string, download: Download): FileStore {
  mkdirSync(dir, { recursive: true })
  const pathOf = (file: FileRecord): string => join(dir, file.path)
  // A card, the preview and a send can all ask for the same file at once; it's fetched once.
  const downloading = new Map<string, Promise<void>>()

  return {
    add(input) {
      const data = Buffer.from(input.data)
      const sha256 = createHash('sha256').update(data).digest('hex')
      // Same bytes added again (even under another name) reuse the first record and its stored file, but
      // take the new extraction: how files are prepared improves, and old files should benefit (D-058).
      const existing = findFileBySha(db, sha256)
      if (existing) return updateExtraction(db, existing.id, input.extracted, input.isScanned)

      const dot = input.name.lastIndexOf('.')
      const ext = EXTENSION_BY_MIME[input.mime] ?? (dot < 0 ? '' : input.name.slice(dot + 1).toLowerCase())
      const path = ext ? `${sha256}.${ext}` : sha256
      writeFileSync(join(dir, path), data)
      return insertFile(db, {
        sha256,
        name: input.name,
        mime: input.mime,
        size: data.length,
        path,
        extracted: input.extracted,
        isScanned: input.isScanned
      })
    },
    read: (file) => readFileSync(pathOf(file)),
    pathOf,
    ensure(file) {
      if (existsSync(pathOf(file))) return Promise.resolve()
      let pending = downloading.get(file.sha256)
      if (!pending) {
        pending = download(file.sha256)
          .then((data) => {
            // Written aside and renamed, so a half-written file is never taken for the real one.
            const partial = `${pathOf(file)}.partial`
            writeFileSync(partial, data)
            renameSync(partial, pathOf(file))
          })
          .finally(() => downloading.delete(file.sha256))
        downloading.set(file.sha256, pending)
      }
      return pending
    }
  }
}
