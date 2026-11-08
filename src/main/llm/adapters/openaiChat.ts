import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam
} from 'openai/resources/chat/completions'
import type { StreamEvent } from '@shared/types'
import { openAiClient } from '../clients'
import type { ChatRequest, Connection, ContentPart, ToolCall } from '../types'
import { guard } from './errors'
import { runRounds, toolImagesMessage, type Round, type Usage } from './toolLoop'

// DeepSeek and others read back their reasoning under this field; OpenAI's types don't have it.
type CompatibleAssistant = ChatCompletionAssistantMessageParam & { reasoning_content?: string }

function toPart(part: ContentPart): ChatCompletionContentPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'image':
      return {
        type: 'image_url',
        image_url: { url: `data:${part.mime};base64,${part.data.toString('base64')}`, detail: 'auto' }
      }
  }
}

export function toOpenAiChatParams(req: Omit<ChatRequest, 'signal'>): ChatCompletionCreateParamsStreaming {
  const messages: ChatCompletionMessageParam[] = req.system ? [{ role: 'system', content: req.system }] : []
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content.map(toPart) })
    else {
      const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
      const assistant: CompatibleAssistant = { role: 'assistant', content: text }
      // With tools, DeepSeek wants every earlier turn's reasoning back and answers 400 otherwise (protocols.md).
      if (req.tools && m.thinking) assistant.reasoning_content = m.thinking
      messages.push(assistant)
    }
  }
  const params: ChatCompletionCreateParamsStreaming = {
    model: req.model,
    messages,
    stream: true,
    // Without this the stream carries no token usage at all.
    stream_options: { include_usage: true }
  }
  if (req.maxOutputTokens !== null) params.max_completion_tokens = req.maxOutputTokens
  // OpenAI's own values; compatible providers that spell "off" differently will answer with an error (D-035).
  if (req.thinking !== null) params.reasoning_effort = req.thinking === 'off' ? 'none' : req.thinking
  if (req.tools) {
    params.tools = req.tools.specs.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  }
  return params
}

// Official Chat Completions never streams reasoning text; compatible providers do, each in its own field.
type CompatibleDelta = ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null
  reasoning?: string | null
  reasoning_details?: { type?: string; text?: string; summary?: string }[] | null
}

// Read only the first field present: OpenRouter sends the same text in both `reasoning` and `reasoning_details`.
export function reasoningText(delta: CompatibleDelta): string {
  if (delta.reasoning_content) return delta.reasoning_content
  if (delta.reasoning) return delta.reasoning
  return (delta.reasoning_details ?? []).map((d) => d.text ?? d.summary ?? '').join('')
}

type ChatRoundEnd = { usage: Usage; stopReason: string; reply: CompatibleAssistant; calls: ToolCall[] }

export async function* fromOpenAiChatChunks(
  chunks: AsyncIterable<ChatCompletionChunk>
): AsyncGenerator<StreamEvent, ChatRoundEnd> {
  let input = 0
  let output = 0
  let stopReason = 'unknown'
  let text = ''
  let reasoning = ''
  // A call's id and name come in its first piece; the JSON arguments arrive in pieces after, by index.
  const calls: { id: string; name: string; args: string }[] = []
  for await (const chunk of chunks) {
    const choice = chunk.choices[0]
    if (choice) {
      const delta = choice.delta as CompatibleDelta
      const thinking = reasoningText(delta)
      if (thinking) {
        reasoning += thinking
        yield { type: 'thinking', delta: thinking }
      }
      if (delta.content) {
        text += delta.content
        yield { type: 'text', delta: delta.content }
      }
      for (const piece of delta.tool_calls ?? []) {
        const call = (calls[piece.index] ??= { id: '', name: '', args: '' })
        if (piece.id) call.id = piece.id
        if (piece.function?.name) call.name = piece.function.name
        call.args += piece.function?.arguments ?? ''
      }
      if (choice.finish_reason) stopReason = choice.finish_reason
    }
    // With include_usage the last chunk has an empty `choices` and the totals.
    if (chunk.usage) {
      input = chunk.usage.prompt_tokens
      output = chunk.usage.completion_tokens
    }
  }
  const reply: CompatibleAssistant = { role: 'assistant', content: text || null }
  if (calls.length > 0) {
    reply.tool_calls = calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.args }
    }))
  }
  if (reasoning) reply.reasoning_content = reasoning
  return {
    usage: { input, output },
    stopReason,
    reply,
    calls: calls.map((c) => ({ id: c.id, name: c.name, input: parseArguments(c.args) }))
  }
}

// A model can emit broken JSON; the tool then sees no input and says so instead of the reply failing.
function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args || '{}')
  } catch {
    return {}
  }
}

export function streamOpenAiChat(conn: Connection, req: ChatRequest): AsyncGenerator<StreamEvent> {
  async function* run(): AsyncGenerator<StreamEvent> {
    const params = toOpenAiChatParams(req)
    const client = openAiClient(conn)
    const round: Round<ChatCompletionMessageParam> = async function* (history, toolsAllowed) {
      const stream = await client.chat.completions.create(
        { ...params, messages: history, ...(params.tools && !toolsAllowed && { tool_choice: 'none' }) },
        { signal: req.signal }
      )
      const { usage, stopReason, reply, calls } = yield* fromOpenAiChatChunks(stream)
      return { calls, reply: [reply], usage, stopReason }
    }
    yield* runRounds(
      req.tools,
      params.messages,
      round,
      (calls, outputs) => {
        const results: ChatCompletionMessageParam[] = calls.map((c, i) => ({
          role: 'tool' as const,
          tool_call_id: c.id,
          content: outputs[i].text
        }))
        const images = toolImagesMessage(outputs)
        return images ? [...results, { role: 'user' as const, content: images.map(toPart) }] : results
      },
      req.signal
    )
  }
  return guard(run(), req.signal)
}
