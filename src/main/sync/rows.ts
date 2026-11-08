import type Database from 'better-sqlite3'
import type { SyncTable } from '@shared/sync'

export type RowData = Record<string, unknown>

// Must match the WHEN clause of the settings triggers in migration 008.
export const SYNCED_SETTINGS: readonly string[] = ['system_prompt']

// rowid is this device's own (FTS uses it); the API key stays on the device that typed it (D-067).
const LOCAL_ONLY: Partial<Record<SyncTable, readonly string[]>> = {
  messages: ['rowid'],
  notes: ['rowid'],
  providers: ['api_key_enc']
}

export const keyOf = (tbl: SyncTable): string => (tbl === 'settings' ? 'key' : 'id')

const columnCache = new WeakMap<Database.Database, Map<SyncTable, string[]>>()

// Also the whitelist for column names arriving from the server, which end up in SQL text.
export function syncedColumns(db: Database.Database, tbl: SyncTable): string[] {
  let byTable = columnCache.get(db)
  if (!byTable) columnCache.set(db, (byTable = new Map()))
  let columns = byTable.get(tbl)
  if (!columns) {
    const all = (db.pragma(`table_info(${tbl})`) as { name: string }[]).map((c) => c.name)
    columns = all.filter((c) => !LOCAL_ONLY[tbl]?.includes(c))
    byTable.set(tbl, columns)
  }
  return columns
}

export function readRow(db: Database.Database, tbl: SyncTable, rowId: string): RowData | undefined {
  return db
    .prepare(`SELECT ${syncedColumns(db, tbl).join(', ')} FROM ${tbl} WHERE ${keyOf(tbl)} = ?`)
    .get(rowId) as RowData | undefined
}

// An upsert, never INSERT OR REPLACE: REPLACE deletes first, and the cascade would take the row's
// messages and marks with it. Columns this device doesn't have (a newer app's) are dropped.
export function writeRow(db: Database.Database, tbl: SyncTable, data: RowData): void {
  const key = keyOf(tbl)
  const columns = syncedColumns(db, tbl).filter((c) => c in data)
  const updates = columns.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`)
  db.prepare(
    `INSERT INTO ${tbl} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})
     ON CONFLICT (${key}) DO ${updates.length > 0 ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`
  ).run(Object.fromEntries(columns.map((c) => [c, data[c]])))
}

export function deleteRow(db: Database.Database, tbl: SyncTable, rowId: string): void {
  db.prepare(`DELETE FROM ${tbl} WHERE ${keyOf(tbl)} = ?`).run(rowId)
}

export function isDirty(db: Database.Database, tbl: SyncTable, rowId: string): boolean {
  return db.prepare('SELECT 1 FROM sync_dirty WHERE tbl = ? AND row_id = ?').get(tbl, rowId) !== undefined
}

// Writes made inside asRemote are remote changes and aren't recorded for pushing (see sync_state in 008);
// asLocal is for this device's own writes made in the middle of applying, which are.
export const asRemote = <T>(db: Database.Database, fn: () => T): T => withApplying(db, 1, fn)
export const asLocal = <T>(db: Database.Database, fn: () => T): T => withApplying(db, 0, fn)

function withApplying<T>(db: Database.Database, value: 0 | 1, fn: () => T): T {
  const before = db.prepare('SELECT applying FROM sync_state').pluck().get() as 0 | 1
  db.prepare('UPDATE sync_state SET applying = ?').run(value)
  try {
    return fn()
  } finally {
    db.prepare('UPDATE sync_state SET applying = ?').run(before)
  }
}
