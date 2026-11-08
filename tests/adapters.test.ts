import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProviderProtocol, StreamEvent } from '@shared/types'
import { streamChat } from '../src/main/llm/adapters'
import {
  ASSUME_CURRENT_MODEL,
  DEFAULT_MAX_TOKENS,
  toAnthropicParams,
  type AnthropicThinkingSupport
} from '../src/main/llm/adapters/anthropic'
import { classifyError } from '../src/main/llm/adapters/errors'
import { thinkingConfig, toGeminiParams } from '../src/main/llm/adapters/gemini'
import { reasoningText, toOpenAiChatParams } from '../src/main/llm/adapters/openaiChat'
import { toOpenAiResponsesParams } from '../src/main/llm/adapters/openaiResponses'
import { MAX_TOOL_ROUNDS } from '../src/main/llm/adapters/toolLoop'
import type { ChatRequest, Tools } from '../src/main/llm/types'

const PNG = Buffer.from('fake-png')

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'm',
    system: '你是一个耐心的老师',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', mime: 'image/png', data: PNG },
          { type: 'text', text: '这张图是什么' }
        ]
      },
      { role: 'assistant', content: [{ type: 'text', text: '一张图' }] },
      { role: 'user', content: [{ type: 'text', text: '再说说' }] }
    ],
    thinking: 'medium',
    maxOutputTokens: null,
    signal: new AbortController().signal,
    ...overrides
  }
}

describe('anthropic params', () => {
  const legacy: AnthropicThinkingSupport = {
    adaptive: false,
    enabled: true,
    disabled: true,
    betweenTools: false,
    effort: false
  }

  it('uses adaptive thinking with effort, automatic caching and a default max_tokens', () => {
    const p = toAnthropicParams(request(), ASSUME_CURRENT_MODEL)
    expect(p).toMatchObject({
      max_tokens: DEFAULT_MAX_TOKENS,
      system: '你是一个耐心的老师',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' }
    })
    expect(p.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
      { type: 'text', text: '这张图是什么' }
    ])
  })

  it('falls back to a token budget on models before adaptive thinking, keeping max_tokens above it', () => {
    const p = toAnthropicParams(request({ thinking: 'high', maxOutputTokens: 8_000 }), legacy)
    expect(p.thinking).toEqual({ type: 'enabled', budget_tokens: 24_576, display: 'summarized' })
    expect(p.max_tokens).toBeGreaterThan(24_576)
    expect(p.output_config).toBeUndefined()
  })

  it('turns thinking off the way the model accepts', () => {
    expect(toAnthropicParams(request({ thinking: 'off' }), ASSUME_CURRENT_MODEL).thinking).toEqual({
      type: 'disabled'
    })
    const sonnet55 = { ...ASSUME_CURRENT_MODEL, disabled: false, betweenTools: true }
    expect(toAnthropicParams(request({ thinking: 'off' }), sonnet55).thinking).toEqual({
      type: 'between_tools'
    })
  })

  it('sends no thinking settings for a model without thinking', () => {
    const p = toAnthropicParams(request({ thinking: null, maxOutputTokens: 4_096 }), ASSUME_CURRENT_MODEL)
    expect(p.thinking).toBeUndefined()
    expect(p.output_config).toBeUndefined()
    expect(p.max_tokens).toBe(4_096)
  })
})

describe('openai params', () => {
  it('chat: system message first, images as data URLs, effort and usage requested', () => {
    const p = toOpenAiChatParams(request({ maxOutputTokens: 16_000 }))
    expect(p.messages[0]).toEqual({ role: 'system', content: '你是一个耐心的老师' })
    expect(p.messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }, { type: 'text' }]
    })
    expect(p.messages[2]).toEqual({ role: 'assistant', content: '一张图' })
    expect(p).toMatchObject({
      reasoning_effort: 'medium',
      max_completion_tokens: 16_000,
      stream_options: { include_usage: true }
    })
  })

  it('chat: off is "none", no thinking capability sends nothing, unknown max output is omitted', () => {
    expect(toOpenAiChatParams(request({ thinking: 'off' })).reasoning_effort).toBe('none')
    const p = toOpenAiChatParams(request({ thinking: null }))
    expect(p).not.toHaveProperty('reasoning_effort')
    expect(p).not.toHaveProperty('max_completion_tokens')
  })

  it('chat: reads reasoning from whichever field a compatible provider uses, once', () => {
    expect(reasoningText({ reasoning_content: 'a' })).toBe('a')
    expect(reasoningText({ reasoning: 'b', reasoning_details: [{ text: 'b' }] })).toBe('b')
    expect(reasoningText({ reasoning_details: [{ type: 'reasoning.summary', summary: 'c' }] })).toBe('c')
    expect(reasoningText({ content: 'answer' })).toBe('')
  })

  it('responses: instructions, store false, summaries with effort', () => {
    const p = toOpenAiResponsesParams(request())
    expect(p).toMatchObject({
      instructions: '你是一个耐心的老师',
      store: false,
      reasoning: { effort: 'medium', summary: 'auto' }
    })
    expect(p.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: `data:image/png;base64,${PNG.toString('base64')}`, detail: 'auto' },
          { type: 'input_text', text: '这张图是什么' }
        ]
      },
      { role: 'assistant', content: '一张图' },
      { role: 'user', content: [{ type: 'input_text', text: '再说说' }] }
    ])
    expect(toOpenAiResponsesParams(request({ thinking: 'off' })).reasoning).toEqual({ effort: 'none' })
  })
})

describe('gemini params', () => {
  it('uses a budget on 2.x and a level on later models', () => {
    expect(thinkingConfig('gemini-2.5-flash', 'off')).toEqual({ thinkingBudget: 0, includeThoughts: false })
    expect(thinkingConfig('gemini-2.5-pro', 'high')).toEqual({ thinkingBudget: 24_576, includeThoughts: true })
    expect(thinkingConfig('gemini-3.8-flash', 'medium')).toEqual({ thinkingLevel: 'MEDIUM', includeThoughts: true })
    expect(thinkingConfig('gemini-4-argon', 'off')).toEqual({ thinkingLevel: 'MINIMAL', includeThoughts: false })
  })

  it('maps roles and inline data', () => {
    const p = toGeminiParams(request({ model: 'gemini-3.8-flash' }))
    expect(p.contents).toEqual([
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }, { text: '这张图是什么' }]
      },
      { role: 'model', parts: [{ text: '一张图' }] },
      { role: 'user', parts: [{ text: '再说说' }] }
    ])
    expect(p.config).toMatchObject({ systemInstruction: '你是一个耐心的老师' })
    expect(p.config).not.toHaveProperty('maxOutputTokens')
  })
})

describe('no system prompt', () => {
  it('is omitted from every protocol when empty', () => {
    const req = request({ system: '' })
    expect(toAnthropicParams(req, ASSUME_CURRENT_MODEL)).not.toHaveProperty('system')
    expect(toOpenAiChatParams(req).messages[0].role).toBe('user')
    expect(toOpenAiResponsesParams(req)).not.toHaveProperty('instructions')
    expect(toGeminiParams(req).config).not.toHaveProperty('systemInstruction')
  })
})

describe('classifyError', () => {
  it.each([
    [{ status: 401 }, 'auth'],
    [{ status: 403 }, 'auth'],
    [{ status: 429 }, 'rate_limit'],
    [Object.assign(new Error('prompt is too long: 1200000 tokens > 1000000 maximum'), { status: 400 }), 'context_length'],
    [Object.assign(new Error("This model's maximum context length is 128000 tokens"), { status: 400 }), 'context_length'],
    [Object.assign(new Error('invalid model'), { status: 400 }), 'other'],
    [new TypeError('fetch failed'), 'network']
  ])('%o → %s', (err, kind) => {
    expect(classifyError(err).kind).toBe(kind)
  })
})

// End to end through the real SDKs: a local server replays each protocol's documented SSE stream.
type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void
let handler: Handler
let baseUrl: string
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => handler(req, body, res))
})

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
})

function sse(res: ServerResponse, events: [name: string | null, data: unknown][]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [name, data] of events) {
    res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
  }
  res.end()
}

async function collect(protocol: ProviderProtocol, path: string, req: Partial<ChatRequest> = {}) {
  const events: StreamEvent[] = []
  for await (const e of streamChat({ protocol, baseUrl: baseUrl + path, apiKey: 'k' }, request(req))) {
    events.push(e)
  }
  return events
}

describe('streams through the SDKs', () => {
  it('anthropic', async () => {
    let sent: Record<string, unknown> = {}
    handler = (req, body, res) => {
      if (req.method === 'GET') {
        // Models API lookup for thinking support.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            type: 'model',
            id: 'm',
            display_name: 'M',
            created_at: '2026-01-01T00:00:00Z',
            capabilities: {
              effort: { supported: true },
              thinking: {
                supported: true,
                types: {
                  adaptive: { supported: true },
                  enabled: { supported: false },
                  disabled: { supported: false },
                  between_tools: { supported: true }
                }
              }
            }
          })
        )
        return
      }
      sent = JSON.parse(body)
      sse(res, [
        ['message_start', { type: 'message_start', message: { id: 'x', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 90, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看图' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '这是' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '一只猫' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 1 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } }],
        ['message_stop', { type: 'message_stop' }]
      ])
    }
    expect(await collect('anthropic', '', { thinking: 'off' })).toEqual([
      { type: 'thinking', delta: '先看图' },
      { type: 'text', delta: '这是' },
      { type: 'text', delta: '一只猫' },
      { type: 'done', usage: { input: 100, output: 42 }, stopReason: 'end_turn' }
    ])
    // The Models API said "disabled" is rejected but "between_tools" works.
    expect(sent.thinking).toEqual({ type: 'between_tools' })
  })

  it('openai chat, with a compatible provider streaming reasoning_content', async () => {
    handler = (_req, _body, res) =>
      sse(res, [
        [null, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '想一想' }, finish_reason: null }] }],
        [null, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: '答案' }, finish_reason: null }] }],
        [null, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
        [null, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } }],
        [null, '[DONE]']
      ])
    expect(await collect('openai_chat', '/v1')).toEqual([
      { type: 'thinking', delta: '想一想' },
      { type: 'text', delta: '答案' },
      { type: 'done', usage: { input: 30, output: 12 }, stopReason: 'stop' }
    ])
  })

  it('openai responses', async () => {
    const response = (status: string, extra = {}) => ({ id: 'r', object: 'response', created_at: 0, model: 'm', status, output: [], ...extra })
    handler = (_req, _body, res) =>
      sse(res, [
        ['response.created', { type: 'response.created', sequence_number: 0, response: response('in_progress') }],
        ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', sequence_number: 1, item_id: 'rs', output_index: 0, summary_index: 0, delta: '比较两者' }],
        ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 2, item_id: 'msg', output_index: 1, content_index: 0, delta: '结论', logprobs: [] }],
        ['response.incomplete', { type: 'response.incomplete', sequence_number: 3, response: response('incomplete', { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 40 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 80 }, total_tokens: 150 } }) }]
      ])
    expect(await collect('openai_responses', '/v1')).toEqual([
      { type: 'thinking', delta: '比较两者' },
      { type: 'text', delta: '结论' },
      { type: 'done', usage: { input: 50, output: 100 }, stopReason: 'max_output_tokens' }
    ])
  })

  it('gemini', async () => {
    let path = ''
    handler = (req, _body, res) => {
      path = req.url ?? ''
      sse(res, [
        [null, { candidates: [{ content: { role: 'model', parts: [{ text: '分析题目', thought: true }] } }] }],
        [null, { candidates: [{ content: { role: 'model', parts: [{ text: '答案是 42' }] } }] }],
        [null, { candidates: [{ content: { role: 'model', parts: [{ text: '。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 15, totalTokenCount: 40 } }]
      ])
    }
    expect(await collect('gemini', '', { model: 'gemini-3.8-flash' })).toEqual([
      { type: 'thinking', delta: '分析题目' },
      { type: 'text', delta: '答案是 42' },
      { type: 'text', delta: '。' },
      { type: 'done', usage: { input: 20, output: 20 }, stopReason: 'STOP' }
    ])
    expect(path).toContain('/models/gemini-3.8-flash:streamGenerateContent')
  })

  it('gemini: a blocked prompt is an error, not an empty answer', async () => {
    handler = (_req, _body, res) => sse(res, [[null, { promptFeedback: { blockReason: 'SAFETY' } }]])
    const events = await collect('gemini', '', { model: 'gemini-3.8-flash' })
    expect(events).toEqual([{ type: 'error', kind: 'other', message: expect.stringContaining('SAFETY') }])
  })

  it('reports a bad key as an auth error instead of throwing', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }))
    }
    const events = await collect('openai_chat', '/v1')
    expect(events).toEqual([{ type: 'error', kind: 'auth', message: expect.stringContaining('Incorrect API key') }])
  })

  it('ends quietly when the caller cancels mid-stream', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: '第一句' }, finish_reason: null }] })}\n\n`)
      // Never ends: only the abort can stop this stream.
    }
    const controller = new AbortController()
    const events: StreamEvent[] = []
    for await (const e of streamChat(
      { protocol: 'openai_chat', baseUrl: baseUrl + '/v1', apiKey: 'k' },
      request({ signal: controller.signal })
    )) {
      events.push(e)
      controller.abort()
    }
    expect(events).toEqual([{ type: 'text', delta: '第一句' }])
  })
})

// A stand-in for the web tools: reports a step and answers with the query it got.
const fakeTools: Tools = {
  specs: [
    {
      name: 'web_search',
      description: '搜索',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }
  ],
  async *run(call) {
    const query = (call.input as { query: string }).query
    yield { type: 'step', step: { type: 'search', query } }
    return `结果：${query}`
  }
}

// Serves the given responses in turn and keeps every request body.
function rounds(...responses: ((res: ServerResponse) => void)[]): Record<string, any>[] {
  const bodies: Record<string, any>[] = []
  handler = (req, body, res) => {
    if (req.method === 'GET') {
      res.writeHead(404).end()
      return
    }
    bodies.push(JSON.parse(body))
    responses[Math.min(bodies.length, responses.length) - 1](res)
  }
  return bodies
}

const anthropicToolUse = (res: ServerResponse) =>
  sse(res, [
    ['message_start', { type: 'message_start', message: { id: 'a', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '要查一下' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig1' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"特征值"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }]
  ])

describe('tool calls', () => {
  it('anthropic: runs the tool, sends the whole turn back with its signature, then answers', async () => {
    const bodies = rounds(anthropicToolUse, (res) =>
      sse(res, [
        ['message_start', { type: 'message_start', message: { id: 'b', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '答案 [1]' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }],
        ['message_stop', { type: 'message_stop' }]
      ])
    )
    expect(await collect('anthropic', '', { tools: fakeTools })).toEqual([
      { type: 'thinking', delta: '要查一下' },
      { type: 'step', step: { type: 'search', query: '特征值' } },
      { type: 'text', delta: '答案 [1]' },
      { type: 'done', usage: { input: 30, output: 12 }, stopReason: 'end_turn' }
    ])
    expect(bodies[0].tools).toEqual([{ name: 'web_search', description: '搜索', input_schema: fakeTools.specs[0].parameters }])
    expect(bodies[0]).not.toHaveProperty('tool_choice')
    expect(bodies[1].messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '要查一下', signature: 'sig1' },
          { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: '特征值' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '结果：特征值' }] }
    ])
  })

  it('stops offering tools after the round limit, so the model has to answer', async () => {
    const bodies = rounds(anthropicToolUse)
    const events = await collect('anthropic', '', { tools: fakeTools })
    expect(bodies).toHaveLength(MAX_TOOL_ROUNDS + 1)
    expect(bodies.slice(0, -1).every((b) => !('tool_choice' in b))).toBe(true)
    expect(bodies[MAX_TOOL_ROUNDS].tool_choice).toEqual({ type: 'none' })
    expect(events.filter((e) => e.type === 'step')).toHaveLength(MAX_TOOL_ROUNDS)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('openai chat: pieces the call together and sends reasoning_content back, also for earlier turns', async () => {
    const chunk = (delta: object, finish: string | null = null) => [null, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] }] as [null, unknown]
    const bodies = rounds(
      (res) =>
        sse(res, [
          chunk({ role: 'assistant', reasoning_content: '想' }),
          chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query"' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: ':"q"}' } }] }, 'tool_calls'),
          [null, '[DONE]']
        ]),
      (res) => sse(res, [chunk({ content: '答' }, 'stop'), [null, '[DONE]']])
    )
    const history = request().messages
    history[1] = { ...history[1], thinking: '旧思考' }
    const events = await collect('openai_chat', '/v1', { tools: fakeTools, messages: history })
    expect(events.map((e) => e.type)).toEqual(['thinking', 'step', 'text', 'done'])
    expect(bodies[0].messages[2]).toEqual({ role: 'assistant', content: '一张图', reasoning_content: '旧思考' })
    expect(bodies[0].tools[0]).toEqual({ type: 'function', function: { name: 'web_search', description: '搜索', parameters: fakeTools.specs[0].parameters } })
    expect(bodies[1].messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: null,
        reasoning_content: '想',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"q"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '结果：q' }
    ])
  })

  it('openai chat: without tools, earlier reasoning is not sent', () => {
    const history = request().messages
    history[1] = { ...history[1], thinking: '旧思考' }
    expect(toOpenAiChatParams(request({ messages: history })).messages[2]).toEqual({ role: 'assistant', content: '一张图' })
  })

  it('openai responses: sends the reasoning item back with the call output', async () => {
    const response = (output: unknown[]) => ({ id: 'r', object: 'response', created_at: 0, model: 'm', status: 'completed', output, usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } })
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' }
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}', status: 'completed' }
    const bodies = rounds(
      (res) => sse(res, [['response.completed', { type: 'response.completed', sequence_number: 0, response: response([reasoning, call]) }]]),
      (res) =>
        sse(res, [
          ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 0, item_id: 'msg', output_index: 0, content_index: 0, delta: '答', logprobs: [] }],
          ['response.completed', { type: 'response.completed', sequence_number: 1, response: response([]) }]
        ])
    )
    const events = await collect('openai_responses', '/v1', { tools: fakeTools })
    expect(events.map((e) => e.type)).toEqual(['step', 'text', 'done'])
    expect(events.at(-1)).toMatchObject({ usage: { input: 10, output: 4 } })
    expect(bodies[0]).toMatchObject({ include: ['reasoning.encrypted_content'], tools: [{ type: 'function', name: 'web_search', strict: false }] })
    expect(bodies[1].input.slice(-3)).toEqual([reasoning, call, { type: 'function_call_output', call_id: 'call_1', output: '结果：q' }])
  })

  it('gemini: keeps the signed part as it came and answers with the call id', async () => {
    const bodies = rounds(
      (res) =>
        sse(res, [
          [null, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'f1', name: 'web_search', args: { query: 'q' } }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }] }]
        ]),
      (res) => sse(res, [[null, { candidates: [{ content: { role: 'model', parts: [{ text: '答' }] }, finishReason: 'STOP' }] }]])
    )
    const events = await collect('gemini', '', { model: 'gemini-3.8-flash', tools: fakeTools })
    expect(events.map((e) => e.type)).toEqual(['step', 'text', 'done'])
    expect(bodies[0].tools[0].functionDeclarations[0]).toMatchObject({ name: 'web_search', parametersJsonSchema: fakeTools.specs[0].parameters })
    expect(bodies[0].toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } })
    expect(bodies[1].contents.slice(-2)).toEqual([
      { role: 'model', parts: [{ functionCall: { id: 'f1', name: 'web_search', args: { query: 'q' } }, thoughtSignature: 'sig' }] },
      { role: 'user', parts: [{ functionResponse: { id: 'f1', name: 'web_search', response: { result: '结果：q' } } }] }
    ])
  })
})

describe('tool results with page images', () => {
  const PAGE = Buffer.from('page-3')
  const pageTools: Tools = {
    specs: fakeTools.specs,
    async *run() {
      return { text: '第 3 页的文字', images: [{ label: '[a.pdf 第 3 页]', mime: 'image/jpeg', data: PAGE }] }
    }
  }
  const pageImage = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PAGE.toString('base64') } }
  const dataUrl = `data:image/jpeg;base64,${PAGE.toString('base64')}`
  const chatChunk = (delta: object, finish: string | null = null) =>
    [null, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] }] as [null, unknown]

  it('anthropic: the images go inside the tool result, each after its label', async () => {
    const bodies = rounds(anthropicToolUse, (res) =>
      sse(res, [
        ['message_start', { type: 'message_start', message: { id: 'b', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }]
      ])
    )
    await collect('anthropic', '', { tools: pageTools })
    expect(bodies[1].messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: '第 3 页的文字' }, { type: 'text', text: '[a.pdf 第 3 页]' }, pageImage]
        }
      ]
    })
  })

  it('openai chat: text in the tool message, the images in a user message right after', async () => {
    const bodies = rounds(
      (res) =>
        sse(res, [
          chatChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{}' } }] }, 'tool_calls'),
          [null, '[DONE]']
        ]),
      (res) => sse(res, [chatChunk({ content: '答' }, 'stop'), [null, '[DONE]']])
    )
    await collect('openai_chat', '/v1', { tools: pageTools })
    expect(bodies[1].messages.slice(-2)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '第 3 页的文字' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '（上面工具结果里的页面图片）' },
          { type: 'text', text: '[a.pdf 第 3 页]' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }
        ]
      }
    ])
  })

  it('openai responses and gemini: the same user message after the call output', async () => {
    const response = (output: unknown[]) => ({ id: 'r', object: 'response', created_at: 0, model: 'm', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{}', status: 'completed' }
    const responsesBodies = rounds(
      (res) => sse(res, [['response.completed', { type: 'response.completed', sequence_number: 0, response: response([call]) }]]),
      (res) => sse(res, [['response.completed', { type: 'response.completed', sequence_number: 0, response: response([]) }]])
    )
    await collect('openai_responses', '/v1', { tools: pageTools })
    expect(responsesBodies[1].input.slice(-2)).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: '第 3 页的文字' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '（上面工具结果里的页面图片）' },
          { type: 'input_text', text: '[a.pdf 第 3 页]' },
          { type: 'input_image', image_url: dataUrl, detail: 'auto' }
        ]
      }
    ])

    const geminiBodies = rounds(
      (res) => sse(res, [[null, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'f1', name: 'web_search', args: {} } }] }, finishReason: 'STOP' }] }]]),
      (res) => sse(res, [[null, { candidates: [{ content: { role: 'model', parts: [{ text: '答' }] }, finishReason: 'STOP' }] }]])
    )
    await collect('gemini', '', { model: 'gemini-3.8-flash', tools: pageTools })
    expect(geminiBodies[1].contents.slice(-2)).toEqual([
      { role: 'user', parts: [{ functionResponse: { id: 'f1', name: 'web_search', response: { result: '第 3 页的文字' } } }] },
      {
        role: 'user',
        parts: [
          { text: '（上面工具结果里的页面图片）' },
          { text: '[a.pdf 第 3 页]' },
          { inlineData: { mimeType: 'image/jpeg', data: PAGE.toString('base64') } }
        ]
      }
    ])
  })
})
