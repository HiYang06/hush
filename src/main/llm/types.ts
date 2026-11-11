import type { ProviderProtocol, StreamEvent, ThinkingLevel } from '@shared/types'

export type Connection = { protocol: ProviderProtocol; baseUrl: string; apiKey: string }

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: Buffer }

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: ContentPart[]
  // An earlier reply's thinking. Only sent where a provider demands it: DeepSeek with tools (protocols.md).
  thinking?: string
}

export type ToolCall = { id: string; name: string; input: unknown }

export type ToolSpec = {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] }
}

// A tool's result: text, plus images (document pages) that each adapter places as its protocol allows.
// label names an image in words, sent right before it, so the model can tell the pages apart.
export type ToolImage = { label: string; mime: string; data: Buffer }
export type ToolOutput = { text: string; images: ToolImage[] }

// Tools run in the main process. `run` streams progress events and returns what the model reads back.
export type Tools<Output extends string | ToolOutput = string | ToolOutput> = {
  specs: ToolSpec[]
  run: (call: ToolCall, signal: AbortSignal) => AsyncGenerator<StreamEvent, Output>
}

export type ChatRequest = {
  model: string
  system: string
  messages: ChatMessage[]
  // null: the model has no thinking capability, so send no thinking parameter at all.
  // 'off' only arrives for models that can turn thinking off (D-029).
  thinking: ThinkingLevel | null
  // null: unknown; each adapter falls back to its own default (D-034).
  maxOutputTokens: number | null
  tools?: Tools
  signal: AbortSignal
}

// Another main session of the same project, as the model refers to it. n is its rank among them by
// creation time, from 1, so a new session never renumbers the earlier ones.
export type ProjectSessionRef = { n: number; id: string; title: string; createdAt: number }
