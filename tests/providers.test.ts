import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@anthropic-ai/sdk/resources/models'
import { openDb } from '../src/main/db'
import {
  addModel,
  createProvider,
  deleteProvider,
  getProviderApiKeyEnc,
  listModels,
  listProviders,
  updateModel,
  updateProvider
} from '../src/main/db/repo/providers'
import { anthropicCapabilities, describeListError, openAiListed, withCatalog } from '../src/main/llm/listModels'
import { lookupModel, needsReview } from '../src/shared/modelCatalog'

const KEY = Buffer.from('encrypted-key')

const NO_CAPS = {
  supportsVision: false,
  supportsThinking: false,
  thinkingCanDisable: true,
  supportsTools: true,
  contextWindow: null,
  maxOutputTokens: null
}

function newProvider(db: ReturnType<typeof openDb>, name = 'Anthropic') {
  return createProvider(db, {
    name,
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnc: KEY
  })
}

describe('providers', () => {
  it('creates providers in order and only reports whether a key is set', () => {
    const db = openDb(':memory:')
    const a = newProvider(db, 'A')
    const b = createProvider(db, {
      name: 'B',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKeyEnc: null
    })
    expect(listProviders(db).map((p) => [p.name, p.sortOrder, p.hasApiKey])).toEqual([
      ['A', 1, true],
      ['B', 2, false]
    ])
    expect(a).not.toHaveProperty('apiKeyEnc')
    expect(getProviderApiKeyEnc(db, a.id)).toEqual(KEY)
    expect(getProviderApiKeyEnc(db, b.id)).toBeNull()
  })

  it('keeps the key when a patch omits it and clears it on null', () => {
    const db = openDb(':memory:')
    const { id } = newProvider(db)

    const renamed = updateProvider(db, id, { name: '官方', baseUrl: 'https://proxy.example' })
    expect(renamed).toMatchObject({ name: '官方', baseUrl: 'https://proxy.example', hasApiKey: true })
    expect(getProviderApiKeyEnc(db, id)).toEqual(KEY)

    expect(updateProvider(db, id, { apiKeyEnc: null }).hasApiKey).toBe(false)
  })

  it('deletes its models along with the provider', () => {
    const db = openDb(':memory:')
    const { id } = newProvider(db)
    addModel(db, id, { modelName: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', ...NO_CAPS })
    deleteProvider(db, id)
    expect(listModels(db)).toEqual([])
  })
})

describe('models', () => {
  it('stores capability flags as booleans and updates only the given fields', () => {
    const db = openDb(':memory:')
    const { id: providerId } = newProvider(db)
    const model = addModel(db, providerId, {
      modelName: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5',
      supportsVision: true,
      supportsThinking: true,
      thinkingCanDisable: false,
      supportsTools: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000
    })
    expect(model).toMatchObject({ enabled: true, supportsVision: true, thinkingCanDisable: false })

    const updated = updateModel(db, model.id, { supportsVision: false, displayName: 'Opus' })
    expect(updated).toMatchObject({
      displayName: 'Opus',
      supportsVision: false,
      supportsThinking: true
    })
  })

  it('sets and clears the token limits', () => {
    const db = openDb(':memory:')
    const { id: providerId } = newProvider(db)
    const model = addModel(db, providerId, { modelName: 'gpt-5.5', displayName: 'GPT-5.5', ...NO_CAPS })
    expect(model).toMatchObject({ contextWindow: null, maxOutputTokens: null })

    expect(updateModel(db, model.id, { contextWindow: 400_000, maxOutputTokens: 128_000 })).toMatchObject({
      contextWindow: 400_000,
      maxOutputTokens: 128_000
    })
    expect(updateModel(db, model.id, { maxOutputTokens: null })).toMatchObject({
      contextWindow: 400_000,
      maxOutputTokens: null
    })
  })

  it('rejects the same model id twice under one provider', () => {
    const db = openDb(':memory:')
    const { id } = newProvider(db)
    const input = { modelName: 'gpt-5.5', displayName: 'GPT-5.5', ...NO_CAPS }
    addModel(db, id, input)
    expect(() => addModel(db, id, input)).toThrow(/UNIQUE/)
  })
})

describe('anthropicCapabilities', () => {
  const supported = (s: boolean) => ({ supported: s })
  function info(thinking: { disabled: boolean; betweenTools: boolean }) {
    return {
      capabilities: {
        image_input: supported(true),
        pdf_input: supported(false),
        thinking: {
          supported: true,
          types: {
            adaptive: supported(true),
            enabled: supported(false),
            disabled: supported(thinking.disabled),
            between_tools: supported(thinking.betweenTools)
          }
        }
      }
    } as unknown as ModelInfo
  }

  it('maps the reported capabilities', () => {
    expect(anthropicCapabilities(info({ disabled: true, betweenTools: false }))).toEqual({
      supportsVision: true,
      supportsThinking: true,
      thinkingCanDisable: true,
      supportsTools: true
    })
  })

  it('treats between_tools as a way to turn thinking off, as on Sonnet 5.5', () => {
    expect(anthropicCapabilities(info({ disabled: false, betweenTools: true }))?.thinkingCanDisable).toBe(true)
    expect(anthropicCapabilities(info({ disabled: false, betweenTools: false }))?.thinkingCanDisable).toBe(false)
  })

  it('returns null when a compatible provider reports no capabilities', () => {
    expect(anthropicCapabilities({ capabilities: null })).toBeNull()
  })
})

describe('describeListError', () => {
  it('turns HTTP statuses into a next step', () => {
    expect(describeListError({ status: 401 })).toMatch(/检查 key/)
    expect(describeListError({ status: 404 })).toMatch(/手动输入模型/)
    expect(describeListError({ status: 503 })).toMatch(/503/)
  })

  it('treats a missing status as an unreachable address', () => {
    expect(describeListError(new TypeError('fetch failed'))).toMatch(/连不上/)
  })

  it('keeps the original message for other statuses', () => {
    expect(describeListError(Object.assign(new Error('bad base url'), { status: 400 }))).toBe('bad base url')
  })
})

describe('modelCatalog', () => {
  it('matches relay-prefixed ids case-insensitively', () => {
    expect(lookupModel('deepseek/deepseek-flash')?.maxOutputTokens).toBe(384_000)
    expect(lookupModel('google-vertex/Gemini-4-argon')?.capabilities.supportsVision).toBe(true)
  })

  it('takes the narrower pattern first', () => {
    expect(lookupModel('glm-5.3-flash')?.capabilities.supportsVision).toBe(true)
    expect(lookupModel('glm-5.3')?.capabilities.supportsVision).toBe(false)
  })

  it('knows nothing about unlisted models', () => {
    expect(lookupModel('llama-4-maverick')).toBeNull()
  })

  it('asks for review only when unknown and without a max output', () => {
    expect(needsReview({ modelName: 'llama-4', maxOutputTokens: null })).toBe(true)
    expect(needsReview({ modelName: 'llama-4', maxOutputTokens: 8192 })).toBe(false)
    expect(needsReview({ modelName: 'kimi-k3.1-pro', maxOutputTokens: null })).toBe(false)
  })
})

describe('openAiListed', () => {
  it('reads Kimi fields', () => {
    const m = openAiListed('kimi-k2.6', { context_length: 262144, supports_image_in: true, supports_reasoning: false })
    expect(m.contextWindow).toBe(262144)
    expect(m.capabilities).toEqual({
      supportsVision: true,
      supportsThinking: false,
      thinkingCanDisable: false,
      supportsTools: true
    })
  })

  it('reads OpenRouter fields', () => {
    const m = openAiListed('anthropic/claude-sonnet-5.5', {
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: 64000 },
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['reasoning', 'tools', 'max_tokens']
    })
    expect(m.maxOutputTokens).toBe(64000)
    // thinkingCanDisable isn't in the list, so it comes from the catalog's claude- entry.
    expect(m.capabilities).toEqual({
      supportsVision: true,
      supportsThinking: true,
      thinkingCanDisable: true,
      supportsTools: true
    })
  })

  it('leaves capabilities unknown when the list says nothing', () => {
    expect(openAiListed('deepseek-flash', {})).toEqual({
      modelName: 'deepseek-flash',
      displayName: 'deepseek-flash',
      capabilities: null,
      contextWindow: null,
      maxOutputTokens: null
    })
  })
})

describe('withCatalog', () => {
  it('fills only what the provider left out', () => {
    const m = withCatalog({ ...openAiListed('deepseek-flash', { context_length: 500_000 }) })
    expect(m.contextWindow).toBe(500_000)
    expect(m.maxOutputTokens).toBe(384_000)
    expect(m.capabilities?.supportsThinking).toBe(true)
  })

  it('leaves unknown models alone', () => {
    const m = openAiListed('my-finetune', {})
    expect(withCatalog(m)).toBe(m)
  })
})
