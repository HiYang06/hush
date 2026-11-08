import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Model, ModelInput, ModelPatch, Provider, ProviderProtocol } from '@shared/types'

// The key arrives here already encrypted (main/secrets.ts), so this file never sees plaintext.
export type ProviderRow = {
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  apiKeyEnc: Buffer | null
}

const PROVIDER_COLUMNS = `id, name, protocol, base_url AS baseUrl, api_key_enc IS NOT NULL AS hasApiKey,
  sort_order AS sortOrder, created_at AS createdAt`

const MODEL_COLUMNS = `id, provider_id AS providerId, model_name AS modelName, display_name AS displayName,
  enabled, supports_vision AS supportsVision,
  supports_thinking AS supportsThinking, thinking_can_disable AS thinkingCanDisable,
  supports_tools AS supportsTools,
  context_window AS contextWindow, max_output_tokens AS maxOutputTokens`

// SQLite has no boolean type; flags come back as 0/1.
function toProvider(row: Record<string, unknown>): Provider {
  return { ...row, hasApiKey: row.hasApiKey === 1 } as Provider
}

function toModel(row: Record<string, unknown>): Model {
  return {
    ...row,
    enabled: row.enabled === 1,
    supportsVision: row.supportsVision === 1,
    supportsThinking: row.supportsThinking === 1,
    thinkingCanDisable: row.thinkingCanDisable === 1,
    supportsTools: row.supportsTools === 1
  } as Model
}

export function listProviders(db: Database.Database): Provider[] {
  return (
    db
      .prepare(`SELECT ${PROVIDER_COLUMNS} FROM providers ORDER BY sort_order, created_at`)
      .all() as Record<string, unknown>[]
  ).map(toProvider)
}

export function getProvider(db: Database.Database, id: string): Provider {
  const row = db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id = ?`).get(id)
  if (!row) throw new Error(`Provider ${id} not found`)
  return toProvider(row as Record<string, unknown>)
}

export function getProviderApiKeyEnc(db: Database.Database, id: string): Buffer | null {
  return db.prepare('SELECT api_key_enc FROM providers WHERE id = ?').pluck().get(id) as Buffer | null
}

export function createProvider(db: Database.Database, input: ProviderRow): Provider {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO providers (id, name, protocol, base_url, api_key_enc, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM providers), ?)`
  ).run(id, input.name, input.protocol, input.baseUrl, input.apiKeyEnc, Date.now())
  return getProvider(db, id)
}

// The protocol can't change: the models already added were listed under it.
export type ProviderRowPatch = Partial<Omit<ProviderRow, 'protocol'>>

const PROVIDER_PATCH_COLUMNS: Record<keyof ProviderRowPatch, string> = {
  name: 'name',
  baseUrl: 'base_url',
  apiKeyEnc: 'api_key_enc'
}

// An undefined field is left as is; apiKeyEnc: null clears the key.
export function updateProvider(db: Database.Database, id: string, patch: ProviderRowPatch): Provider {
  const keys = (Object.keys(patch) as (keyof ProviderRowPatch)[]).filter(
    (k) => patch[k] !== undefined
  )
  if (keys.length > 0) {
    const sets = keys.map((k) => `${PROVIDER_PATCH_COLUMNS[k]} = @${k}`).join(', ')
    db.prepare(`UPDATE providers SET ${sets} WHERE id = @id`).run({
      ...Object.fromEntries(keys.map((k) => [k, patch[k]])),
      id
    })
  }
  return getProvider(db, id)
}

export function deleteProvider(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM providers WHERE id = ?').run(id)
}

export function listModels(db: Database.Database): Model[] {
  return (
    db.prepare(`SELECT ${MODEL_COLUMNS} FROM models ORDER BY rowid`).all() as Record<
      string,
      unknown
    >[]
  ).map(toModel)
}

export function getModel(db: Database.Database, id: string): Model {
  const row = db.prepare(`SELECT ${MODEL_COLUMNS} FROM models WHERE id = ?`).get(id)
  if (!row) throw new Error(`Model ${id} not found`)
  return toModel(row as Record<string, unknown>)
}

export function addModel(db: Database.Database, providerId: string, input: ModelInput): Model {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO models (id, provider_id, model_name, display_name,
       supports_vision, supports_thinking, thinking_can_disable, supports_tools,
       context_window, max_output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    providerId,
    input.modelName,
    input.displayName,
    Number(input.supportsVision),
    Number(input.supportsThinking),
    Number(input.thinkingCanDisable),
    Number(input.supportsTools),
    input.contextWindow,
    input.maxOutputTokens
  )
  return getModel(db, id)
}

const MODEL_PATCH_COLUMNS: Record<keyof ModelPatch, string> = {
  displayName: 'display_name',
  enabled: 'enabled',
  supportsVision: 'supports_vision',
  supportsThinking: 'supports_thinking',
  thinkingCanDisable: 'thinking_can_disable',
  supportsTools: 'supports_tools',
  contextWindow: 'context_window',
  maxOutputTokens: 'max_output_tokens'
}

export function updateModel(db: Database.Database, id: string, patch: ModelPatch): Model {
  const keys = (Object.keys(patch) as (keyof ModelPatch)[]).filter((k) => patch[k] !== undefined)
  if (keys.length > 0) {
    const sets = keys.map((k) => `${MODEL_PATCH_COLUMNS[k]} = @${k}`).join(', ')
    const values = Object.fromEntries(
      keys.map((k) => [k, typeof patch[k] === 'boolean' ? Number(patch[k]) : patch[k]])
    )
    db.prepare(`UPDATE models SET ${sets} WHERE id = @id`).run({ ...values, id })
  }
  return getModel(db, id)
}

export function deleteModel(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM models WHERE id = ?').run(id)
}
