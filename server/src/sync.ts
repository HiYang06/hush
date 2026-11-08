import type { Pool } from 'pg'
import {
  SYNC_PULL_LIMIT,
  SYNC_PUSH_LIMIT,
  SYNC_TABLES,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type PushResult,
  type SyncChange,
  type SyncRow
} from '../../src/shared/sync.ts'
import { inTransaction } from './db.ts'
import { HttpError } from './errors.ts'

type DbRow = { tbl: SyncRow['tbl']; row_id: string; seq: number; deleted: boolean; data: SyncRow['data'] }

const toSyncRow = (r: DbRow): SyncRow => ({ tbl: r.tbl, rowId: r.row_id, seq: r.seq, deleted: r.deleted, data: r.data })

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parsePush(body: unknown): PushRequest {
  const changes = isObject(body) ? body.changes : undefined
  if (!Array.isArray(changes) || changes.length > SYNC_PUSH_LIMIT) throw new HttpError(400, 'bad_request')
  const since = isObject(body) ? body.since : undefined
  if (since !== undefined && !(Number.isSafeInteger(since) && (since as number) >= 0)) throw new HttpError(400, 'bad_request')
  for (const c of changes) {
    const valid =
      isObject(c) &&
      (SYNC_TABLES as readonly unknown[]).includes(c.tbl) &&
      typeof c.rowId === 'string' &&
      c.rowId.length > 0 &&
      c.rowId.length <= 200 &&
      (c.deleted === true ? c.data === null : c.deleted === false && isObject(c.data)) &&
      (c.baseSeq === undefined || (Number.isSafeInteger(c.baseSeq) && (c.baseSeq as number) >= 0))
    if (!valid) throw new HttpError(400, 'bad_request')
  }
  return { changes: changes as SyncChange[], since: since as number | undefined }
}

export async function push(pool: Pool, userId: string, { changes, since }: PushRequest): Promise<PushResponse> {
  return inTransaction(pool, async (client) => {
    // Every push for this user waits on this lock, so seqs are handed out and committed in order:
    // a pull can never see seq n+1 while n is still uncommitted, and skip n forever.
    let next = (await client.query<{ next_seq: number }>('SELECT next_seq FROM users WHERE id = $1 FOR UPDATE', [userId]))
      .rows[0].next_seq
    if (since !== undefined && next - 1 > since) throw new HttpError(409, 'stale')
    const results: PushResult[] = []
    for (const change of changes) {
      if (change.baseSeq !== undefined) {
        const current = (
          await client.query<DbRow>(
            'SELECT tbl, row_id, seq, deleted, data FROM sync_rows WHERE user_id = $1 AND tbl = $2 AND row_id = $3',
            [userId, change.tbl, change.rowId]
          )
        ).rows[0]
        if ((current?.seq ?? 0) !== change.baseSeq) {
          results.push({ ok: false, current: current ? toSyncRow(current) : null })
          continue
        }
      }
      const seq = next++
      await client.query(
        `INSERT INTO sync_rows (user_id, tbl, row_id, seq, deleted, data) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, tbl, row_id) DO UPDATE SET seq = excluded.seq, deleted = excluded.deleted, data = excluded.data`,
        [userId, change.tbl, change.rowId, seq, change.deleted, change.data]
      )
      results.push({ ok: true, seq })
    }
    await client.query('UPDATE users SET next_seq = $2 WHERE id = $1', [userId, next])
    return { results, cursor: next - 1 }
  })
}

// Pulling from 0 returns every live row and tombstone once, in its latest state: a full snapshot,
// with nothing to replay.
export async function pull(pool: Pool, userId: string, sinceInput: unknown): Promise<PullResponse> {
  const since = Number(sinceInput ?? 0)
  if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'bad_request')
  const rows = (
    await pool.query<DbRow>(
      'SELECT tbl, row_id, seq, deleted, data FROM sync_rows WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
      [userId, since, SYNC_PULL_LIMIT + 1]
    )
  ).rows
  const more = rows.length > SYNC_PULL_LIMIT
  const page = rows.slice(0, SYNC_PULL_LIMIT).map(toSyncRow)
  return { rows: page, cursor: page.at(-1)?.seq ?? since, more }
}
