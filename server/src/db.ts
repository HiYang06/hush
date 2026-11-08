import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import type { Pool, PoolClient } from 'pg'

// bigint columns (seq) come back as strings by default; seqs stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, Number)

const MIGRATIONS = join(import.meta.dirname, '../migrations')

// Same rule as the app: a committed migration is never edited, a change is a new file.
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  )
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue
    await inTransaction(pool, async (client) => {
      await client.query(readFileSync(join(MIGRATIONS, name), 'utf8'))
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
    })
  }
}

export async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
