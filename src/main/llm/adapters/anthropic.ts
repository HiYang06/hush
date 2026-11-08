import type {
  ContentBlockParam,
  ToolResultBlockParam,
  MessageParam,
  MessageCreateParamsBase,
  RawMessageStreamEvent
} from '@anthropic-ai/sdk/resources/messages'
import type { ModelInfo } from '@anthropic-ai/sdk/resources/models'
import type { StreamEvent } from '@shared/types'
import { anthropicClient } from '../clients'
import type { ChatRequest, Connection, ContentPart } from '../types'
import { guard } from './errors'
import { labelledImages, runRounds, type Round, type Usage } from './toolLoop'

type ToolResultContent = Exclude<ToolResultBlockParam['content'], string | undefined>

// max_tokens is required by this API; used when the model's max output is unknown (D-034).
export const DEFAULT_MAX_TOKENS = 32_000

// Only for models that predate adaptive thinking (Claude 4.5 and earlier).
const THINKING_BUDGET = { low: 2_048, medium: 8_192, high: 24_576 } as const

// Which `thinking` values the model accepts; sending any other one is a 400 (protocols.md).
export type AnthropicThinkingSupport = {
  adaptive: boolean
  enabled: boolean
  disabled: boolean
  betweenTools: boolean
  effort: boolean
}

// Anthropic-compatible third parties usually report no capabilities; current Claude models are the best guess.
export const ASSUME_CURRENT_MODEL: AnthropicThinkingSupport = {
  adaptive: true,
  enabled: false,
  disabled: true,
  betweenTools: false,
  effort: true
}

export function thinkingSupportFrom(info: Pick<ModelInfo, 'capabilities'>): AnthropicThinkingSupport {
  const caps = info.capabilities
  if (!caps) return ASSUME_CURRENT_MODEL
  const types = caps.thinking.types
  return {
    adaptive: types.adaptive.supported,
    enabled: types.enabled.supported,
    disabled: types.disabled.supported,
    betweenTools: types.between_tools.supported,
    effort: caps.effort.supported
  }
}

function toBlock(part: ContentPart): ContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: part.data.toString('base64')
        }
      }
  }
}

export function toAnthropicParams(
  req: Omit<ChatRequest, 'signal'>,
  support: AnthropicThinkingSupport
): MessageCreateParamsBase & { messages: MessageParam[] } {
  let maxTokens = req.maxOutputTokens ?? DEFAULT_MAX_TOKENS
  const params: MessageCreateParamsBase & { messages: MessageParam[] } = {
    model: req.model,
    max_tokens: maxTokens,
    ...(req.system && { system: req.system }),
    messages: req.messages.map((m) => ({ role: m.role, content: m.content.map(toBlock) })),
    // Automatic caching: the breakpoint follows the end of the conversation as it grows (D-033).
    cache_control: { type: 'ephemeral' }
  }
  if (req.tools) {
    // No eager_input_streaming: the inputs are one short query, and compatible third parties may reject the field.
    params.tools = req.tools.specs.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }))
  }

  const level = req.thinking
  if (level === 'off') {
    if (support.disabled) params.thinking = { type: 'disabled' }
    else if (support.betweenTools) params.thinking = { type: 'between_tools' }
  } else if (level !== null) {
    if (support.adaptive) {
      params.thinking = { type: 'adaptive', display: 'summarized' }
      if (support.effort) params.output_config = { effort: level }
    } else if (support.enabled) {
      // The budget must stay below max_tokens and at least 1,024.
      maxTokens = Math.max(maxTokens, THINKING_BUDGET[level] + 4_096)
      params.max_tokens = maxTokens
      params.thinking = {
        type: 'enabled',
        budget_tokens: THINKING_BUDGET[level],
        display: 'summarized'
      }
    }
  }
  return params
}

export async function* fromAnthropicEvents(
  events: AsyncIterable<RawMessageStreamEvent>
): AsyncGenerator<StreamEvent, { usage: Usage; stopReason: string }> {
  // input_tokens only counts what came after the last cache breakpoint; the cached parts are separate.
  let input = 0
  let output = 0
  let stopReason = 'unknown'
  for await (const event of events) {
    switch (event.type) {
      case 'message_start': {
        const u = event.message.usage
        input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
        output = u.output_tokens
        break
      }
      case 'content_block_delta':
        if (event.delta.type === 'text_delta') yield { type: 'text', delta: event.delta.text }
        // With display "omitted" a thinking block still streams one empty delta; nothing to show.
        else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
          yield { type: 'thinking', delta: event.delta.thinking }
        }
        break
      case 'message_delta':
        output = event.usage.output_tokens
        stopReason = event.delta.stop_reason ?? stopReason
        break
    }
  }
  return { usage: { input, output }, stopReason }
}

// One lookup per model per app run: which thinking settings the model accepts doesn't change.
const supportCache = new Map<string, Promise<AnthropicThinkingSupport>>()

function lookupSupport(conn: Connection, model: string): Promise<AnthropicThinkingSupport> {
  const key = `${conn.baseUrl}\n${model}`
  let support = supportCache.get(key)
  if (!support) {
    support = anthropicClient(conn)
      .models.retrieve(model)
      .then(thinkingSupportFrom)
      // A third party without the Models API, or a network blip: fall back, don't fail the chat,
      // and forget the failure so the next request asks again.
      .catch(() => {
        supportCache.delete(key)
        return ASSUME_CURRENT_MODEL
      })
    supportCache.set(key, support)
  }
  return support
}

export function streamAnthropic(conn: Connection, req: ChatRequest): AsyncGenerator<StreamEvent> {
  async function* run(): AsyncGenerator<StreamEvent> {
    const support = req.thinking === null ? ASSUME_CURRENT_MODEL : await lookupSupport(conn, req.model)
    const params = toAnthropicParams(req, support)
    const client = anthropicClient(conn)
    const round: Round<MessageParam> = async function* (history, toolsAllowed) {
      const stream = client.messages.stream(
        { ...params, messages: history, ...(params.tools && !toolsAllowed && { tool_choice: { type: 'none' } }) },
        { signal: req.signal }
      )
      const { usage, stopReason } = yield* fromAnthropicEvents(stream)
      // The whole turn goes back verbatim: thinking blocks must keep their signatures (protocols.md).
      const message = await stream.finalMessage()
      const calls = message.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []
      )
      return { calls, reply: [{ role: 'assistant', content: message.content }], usage, stopReason }
    }
    yield* runRounds(
      req.tools,
      params.messages,
      round,
      // All results of one turn go in a single message, or the model learns to stop calling in parallel.
      (calls, outputs): MessageParam[] => [
        {
          role: 'user',
          content: calls.map((c, i) => ({
            type: 'tool_result' as const,
            tool_use_id: c.id,
            // Anthropic takes images inside a tool result, right where they belong.
            content:
              outputs[i].images.length === 0
                ? outputs[i].text
                : [{ type: 'text' as const, text: outputs[i].text }, ...labelledImages([outputs[i]]).map(toBlock)] as ToolResultContent
          }))
        }
      ],
      req.signal
    )
  }
  return guard(run(), req.signal)
}
