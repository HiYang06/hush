import type { ModelInfo } from '@anthropic-ai/sdk/resources/models'
import type { ModelCapabilities, RemoteModel } from '@shared/types'
import { lookupModel } from '@shared/modelCatalog'
import { anthropicClient, geminiClient, openAiClient } from './clients'
import type { Connection } from './types'

export async function listRemoteModels(conn: Connection): Promise<RemoteModel[]> {
  let models: RemoteModel[]
  try {
    switch (conn.protocol) {
      case 'anthropic':
        models = await listAnthropic(conn)
        break
      case 'openai_chat':
      case 'openai_responses':
        models = await listOpenAi(conn)
        break
      case 'gemini':
        models = await listGemini(conn)
        break
    }
  } catch (err) {
    throw new Error(describeListError(err))
  }
  return models.map(withCatalog)
}

// What the provider reported wins; the catalog only fills what it left out.
export function withCatalog(model: RemoteModel): RemoteModel {
  const known = lookupModel(model.modelName)
  if (!known) return model
  return {
    ...model,
    capabilities: model.capabilities ?? known.capabilities,
    contextWindow: model.contextWindow ?? known.contextWindow,
    maxOutputTokens: model.maxOutputTokens ?? known.maxOutputTokens
  }
}

// All three SDKs put the HTTP status on `status`; a request that never got a response has none.
export function describeListError(err: unknown): string {
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number') return '连不上这个地址。检查地址是否正确，以及网络是否可用。'
  if (status === 401) return '服务商不认这个 API key（401）。检查 key 是不是这家服务商的、有没有复制完整。'
  if (status === 403) return '服务商拒绝了访问（403）：key 没有权限，或所在地区不支持。'
  if (status === 404) return '这个地址找不到模型列表（404）。检查地址，或手动输入模型 id。'
  if (status === 429) return '请求太频繁，或额度已经用完（429）。稍后再试。'
  if (status >= 500) return `服务商那边出错了（${status}）。稍后再试。`
  return err instanceof Error ? err.message : String(err)
}

async function listAnthropic(conn: Connection): Promise<RemoteModel[]> {
  const client = anthropicClient(conn)
  const models: RemoteModel[] = []
  for await (const info of client.models.list()) {
    models.push({
      modelName: info.id,
      displayName: info.display_name,
      capabilities: anthropicCapabilities(info),
      contextWindow: info.max_input_tokens,
      maxOutputTokens: info.max_tokens
    })
  }
  return models
}

export function anthropicCapabilities(info: Pick<ModelInfo, 'capabilities'>): ModelCapabilities | null {
  const caps = info.capabilities
  if (!caps) return null
  const types = caps.thinking.types
  return {
    supportsVision: caps.image_input.supported,
    supportsThinking: caps.thinking.supported,
    // between_tools is how Sonnet 5.5 turns off up-front thinking; without tools it is the same as off.
    thinkingCanDisable: types.disabled.supported || types.between_tools.supported,
    // Every Claude model on the official API takes tools; the Models API has no flag for it.
    supportsTools: true
  }
}

async function listOpenAi(conn: Connection): Promise<RemoteModel[]> {
  const client = openAiClient(conn)
  const models: RemoteModel[] = []
  for await (const model of client.models.list()) {
    models.push(openAiListed(model.id, model as unknown as ListedFields))
  }
  return models.sort((a, b) => a.modelName.localeCompare(b.modelName))
}

// Fields some OpenAI-compatible lists add beyond the spec: Kimi (context_length, supports_*)
// and OpenRouter (context_length, top_provider, architecture, supported_parameters).
type ListedFields = {
  context_length?: unknown
  top_provider?: { max_completion_tokens?: unknown } | null
  architecture?: { input_modalities?: unknown } | null
  supported_parameters?: unknown
  supports_image_in?: unknown
  supports_reasoning?: unknown
}

export function openAiListed(id: string, raw: ListedFields): RemoteModel {
  const num = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null)
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
  const modalities = raw.architecture?.input_modalities
  const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : null
  const vision = bool(raw.supports_image_in) ?? (Array.isArray(modalities) ? modalities.includes('image') : undefined)
  const thinking = bool(raw.supports_reasoning) ?? (params ? params.includes('reasoning') : undefined)
  const tools = params ? params.includes('tools') : undefined
  const known = lookupModel(id)?.capabilities
  const capabilities: ModelCapabilities | null =
    vision === undefined && thinking === undefined && tools === undefined
      ? null
      : {
          supportsVision: vision ?? known?.supportsVision ?? false,
          supportsThinking: thinking ?? known?.supportsThinking ?? false,
          thinkingCanDisable: known?.thinkingCanDisable ?? false,
          supportsTools: tools ?? known?.supportsTools ?? true
        }
  return {
    modelName: id,
    displayName: id,
    capabilities,
    contextWindow: num(raw.context_length),
    maxOutputTokens: num(raw.top_provider?.max_completion_tokens)
  }
}

async function listGemini(conn: Connection): Promise<RemoteModel[]> {
  const ai = geminiClient(conn)
  const models: RemoteModel[] = []
  for await (const model of await ai.models.list()) {
    // The list also holds embedding, image and audio models that can't chat.
    if (!model.name || !model.supportedActions?.includes('generateContent')) continue
    const modelName = model.name.replace(/^models\//, '')
    models.push({
      modelName,
      displayName: model.displayName ?? modelName,
      capabilities: null,
      contextWindow: model.inputTokenLimit ?? null,
      maxOutputTokens: model.outputTokenLimit ?? null
    })
  }
  return models
}
