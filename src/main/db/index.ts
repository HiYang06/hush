import Database from 'better-sqlite3'
import { plainText } from '@shared/search'

// Bundled as strings at build time, so there are no .sql files to ship or locate at runtime.
const migrationFiles = import.meta.glob<string>('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true
})

// Index i holds migration version i + 1; filenames start with a zero-padded number, so sorting by name is enough.
const migrations = Object.keys(migrationFiles)
  .sort()
  .map((path) => migrationFiles[path])

export function openDb(filename: string): Database.Database {
  const db = new Database(filename)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  fillPlainText(db)
  return db
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > migrations.length) {
    throw new Error(
      `Database version ${current} is newer than this app supports (${migrations.length})`
    )
  }
  for (let version = current + 1; version <= migrations.length; version++) {
    db.transaction(() => {
      db.exec(migrations[version - 1])
      db.pragma(`user_version = ${version}`)
    })()
  }
}

// Rows from before migration 004 have no plain text yet, and SQL can't strip Markdown, so it's done here.
function fillPlainText(db: Database.Database): void {
  for (const table of ['messages', 'notes']) {
    const rows = db.prepare(`SELECT rowid, content FROM ${table} WHERE plain IS NULL`).all() as {
      rowid: number
      content: string
    }[]
    const update = db.prepare(`UPDATE ${table} SET plain = ? WHERE rowid = ?`)
    db.transaction(() => {
      for (const row of rows) update.run(plainText(row.content), row.rowid)
    })()
  }
}
