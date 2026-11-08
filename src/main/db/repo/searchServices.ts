import type Database from 'better-sqlite3'
import type { SearchService, SearchServiceId } from '@shared/types'

const SERVICE_IDS: SearchServiceId[] = ['tavily', 'exa']

// Both services are always listed, so the settings page can offer the ones not set up yet.
export function listSearchServices(db: Database.Database): SearchService[] {
  const set = new Set(db.prepare('SELECT id FROM search_services').pluck().all() as SearchServiceId[])
  return SERVICE_IDS.map((id) => ({ id, hasApiKey: set.has(id) }))
}

// The key arrives encrypted (main/secrets.ts); null removes the service.
export function setSearchServiceKey(db: Database.Database, id: SearchServiceId, apiKeyEnc: Buffer | null): void {
  if (apiKeyEnc === null) db.prepare('DELETE FROM search_services WHERE id = ?').run(id)
  else {
    db.prepare(
      'INSERT INTO search_services (id, api_key_enc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET api_key_enc = excluded.api_key_enc'
    ).run(id, apiKeyEnc)
  }
}

export function getSearchServiceKeysEnc(db: Database.Database): { id: SearchServiceId; apiKeyEnc: Buffer }[] {
  return db.prepare('SELECT id, api_key_enc AS apiKeyEnc FROM search_services').all() as {
    id: SearchServiceId
    apiKeyEnc: Buffer
  }[]
}
