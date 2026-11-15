import type { StreamEvent } from '@shared/types'
import type { ChatRequest, Connection } from '../types'
import { streamAnthropic } from './anthropic'
import { streamGemini } from './gemini'
import { streamOpenAiChat } from './openaiChat'
import { streamOpenAiResponses } from './openaiResponses'

// Never throws: failures arrive as an `error` event, and a cancel simply ends the stream.
export function streamChat(conn: Connection, req: ChatRequest): AsyncGenerator<StreamEvent> {
  switch (conn.protocol) {
    case 'anthropic':
      return streamAnthropic(conn, req)
    case 'openai_chat':
      return streamOpenAiChat(conn, req)
    case 'openai_responses':
      return streamOpenAiResponses(conn, req)
    case 'gemini':
      return streamGemini(conn, req)
  }
}

// How each protocol says the output hit its cap: Anthropic, OpenAI Chat, Gemini, OpenAI Responses.
const TRUNCATED = new Set(['max_tokens', 'length', 'MAX_TOKENS', 'max_output_tokens'])

export function isTruncated(stopReason: string): boolean {
  return TRUNCATED.has(stopReason)
}
