import type {
  ResponseCreateParamsStreaming,
  ResponseInputContent,
  ResponseInputItem,
  ResponseStreamEvent
} from 'openai/resources/responses/responses'
import type { StreamEvent } from '@shared/types'
import { openAiClient } from '../clients'
import type { ChatRequest, Connection, ContentPart, ToolCall } from '../types'
import { guard } from './errors'
import { runRounds, toolImagesMessage, type Round, type Usage } from './toolLoop'

function toInput(part: ContentPart): ResponseInputContent {
  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text }
    case 'image':
      return {
        type: 'input_image',
        image_url: `data:${part.mime};base64,${part.data.toString('base64')}`,
        detail: 'auto'
      }
  }
}

export function toOpenAiResponsesParams(req: Omit<ChatRequest, 'signal'>): ResponseCreateParamsStreaming {
  const input: ResponseInputItem[] = req.messages.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.content.map(toInput) }
      : { role: 'assistant', content: m.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }
  )
  const params: ResponseCreateParamsStreaming = {
    model: req.model,
    ...(req.system && { instructions: req.system }),
    input,
    // Hush sends the full history every time; nothing needs to live on OpenAI's servers.
    store: false,
    stream: true
  }
  if (req.maxOutputTokens !== null) params.max_output_tokens = req.maxOutputTokens
  if (req.thinking === 'off') params.reasoning = { effort: 'none' }
  else if (req.thinking !== null) params.reasoning = { effort: req.thinking, summary: 'auto' }
  if (req.tools) {
    // Not strict: strict mode requires every parameter, and `recency` is optional.
    params.tools = req.tools.specs.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false
    }))
    // With store: false, reasoning items can only be sent back to the next round in encrypted form.
    params.include = ['reasoning.encrypted_content']
  }
  return params
}

type ResponsesRoundEnd = { usage: Usage; stopReason: string; reply: ResponseInputItem[]; calls: ToolCall[] }

export async function* fromOpenAiResponsesEvents(
  events: AsyncIterable<ResponseStreamEvent>
): AsyncGenerator<StreamEvent, ResponsesRoundEnd | null> {
  for await (const event of events) {
    switch (event.type) {
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        yield { type: 'thinking', delta: event.delta }
        break
      case 'response.output_text.delta':
        yield { type: 'text', delta: event.delta }
        break
      // Ran out of output tokens or hit a content filter: what arrived so far stays, like a normal finish.
      case 'response.completed':
      case 'response.incomplete': {
        const r = event.response
        // Reasoning items go back with the calls, or the model loses its train of thought (protocols.md).
        const reply = r.output.flatMap((item): ResponseInputItem[] =>
          item.type === 'reasoning' || item.type === 'function_call' || item.type === 'message' ? [item] : []
        )
        const calls = r.output.flatMap((item) =>
          item.type === 'function_call'
            ? [{ id: item.call_id, name: item.name, input: parseArguments(item.arguments) }]
            : []
        )
        return {
          usage: { input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 },
          stopReason: r.incomplete_details?.reason ?? r.status ?? 'completed',
          reply,
          calls
        }
      }
      // A stream can report the same failure twice (an `error`, then `response.failed`); stop at the first.
      case 'response.failed':
        yield {
          type: 'error',
          kind: 'other',
          message: event.response.error?.message ?? 'The response failed.'
        }
        return null
      case 'error':
        yield { type: 'error', kind: 'other', message: event.message }
        return null
    }
  }
  return null
}

// A model can emit broken JSON; the tool then sees no input and says so instead of the reply failing.
function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args || '{}')
  } catch {
    return {}
  }
}

export function streamOpenAiResponses(conn: Connection, req: ChatRequest): AsyncGenerator<StreamEvent> {
  async function* run(): AsyncGenerator<StreamEvent> {
    const params = toOpenAiResponsesParams(req)
    const client = openAiClient(conn)
    const round: Round<ResponseInputItem> = async function* (history, toolsAllowed) {
      const stream = await client.responses.create(
        { ...params, input: history, ...(params.tools && !toolsAllowed && { tool_choice: 'none' }) },
        { signal: req.signal }
      )
      return yield* fromOpenAiResponsesEvents(stream)
    }
    yield* runRounds(
      req.tools,
      params.input as ResponseInputItem[],
      round,
      (calls, outputs) => {
        const results: ResponseInputItem[] = calls.map((c, i) => ({
          type: 'function_call_output' as const,
          call_id: c.id,
          output: outputs[i].text
        }))
        const images = toolImagesMessage(outputs)
        return images ? [...results, { role: 'user' as const, content: images.map(toInput) }] : results
      },
      req.signal
    )
  }
  return guard(run(), req.signal)
}
