import {
  FunctionCallingConfigMode,
  ThinkingLevel as GeminiThinkingLevel,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
  type ThinkingConfig
} from '@google/genai'
import type { StreamEvent, ThinkingLevel } from '@shared/types'
import { geminiClient } from '../clients'
import type { ChatRequest, Connection, ContentPart, ToolCall } from '../types'
import { guard } from './errors'
import { runRounds, toolImagesMessage, type Round, type Usage } from './toolLoop'

const THINKING_BUDGET = { off: 0, low: 2_048, medium: 8_192, high: 24_576 } as const

const THINKING_LEVEL = {
  off: GeminiThinkingLevel.MINIMAL,
  low: GeminiThinkingLevel.LOW,
  medium: GeminiThinkingLevel.MEDIUM,
  high: GeminiThinkingLevel.HIGH
} as const

// Gemini 2.x only understands a token budget; 3.x and later take a level, and sending both is a 400.
// "off" on 3.x+ is MINIMAL, the lowest level; models without it should have "can turn off" unchecked.
export function thinkingConfig(model: string, level: ThinkingLevel): ThinkingConfig {
  const includeThoughts = level !== 'off'
  return /^gemini-2\./.test(model)
    ? { thinkingBudget: THINKING_BUDGET[level], includeThoughts }
    : { thinkingLevel: THINKING_LEVEL[level], includeThoughts }
}

function toPart(part: ContentPart): Part {
  switch (part.type) {
    case 'text':
      return { text: part.text }
    case 'image':
      return { inlineData: { mimeType: part.mime, data: part.data.toString('base64') } }
  }
}

export function toGeminiParams(req: ChatRequest): GenerateContentParameters {
  const contents: Content[] = req.messages.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: m.content.map(toPart)
  }))
  return {
    model: req.model,
    contents,
    config: {
      ...(req.system && { systemInstruction: req.system }),
      abortSignal: req.signal,
      ...(req.maxOutputTokens !== null && { maxOutputTokens: req.maxOutputTokens }),
      ...(req.thinking !== null && { thinkingConfig: thinkingConfig(req.model, req.thinking) }),
      ...(req.tools && {
        tools: [
          {
            functionDeclarations: req.tools.specs.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters
            }))
          }
        ]
      })
    }
  }
}

type GeminiRoundEnd = { usage: Usage; stopReason: string; reply: Content[]; calls: ToolCall[] }

export async function* fromGeminiChunks(
  chunks: AsyncIterable<GenerateContentResponse>
): AsyncGenerator<StreamEvent, GeminiRoundEnd | null> {
  let input = 0
  let output = 0
  let stopReason = 'unknown'
  // Kept exactly as they arrive: a part carrying a thoughtSignature must go back as is, never merged (protocols.md).
  const parts: Part[] = []
  for await (const chunk of chunks) {
    // The question itself was blocked: there will be no candidates, so this is an error, not an empty answer.
    const blocked = chunk.promptFeedback?.blockReason
    if (blocked) {
      yield { type: 'error', kind: 'other', message: `Gemini blocked the prompt (${blocked}).` }
      return null
    }
    const candidate = chunk.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      parts.push(part)
      if (!part.text) continue
      yield part.thought ? { type: 'thinking', delta: part.text } : { type: 'text', delta: part.text }
    }
    if (candidate?.finishReason) stopReason = candidate.finishReason
    const usage = chunk.usageMetadata
    if (usage) {
      input = usage.promptTokenCount ?? input
      // Thinking tokens are counted separately from the answer.
      output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
    }
  }
  const calls = parts.flatMap((p) =>
    p.functionCall ? [{ id: p.functionCall.id ?? '', name: p.functionCall.name ?? '', input: p.functionCall.args ?? {} }] : []
  )
  return { usage: { input, output }, stopReason, reply: [{ role: 'model', parts }], calls }
}

export function streamGemini(conn: Connection, req: ChatRequest): AsyncGenerator<StreamEvent> {
  async function* run(): AsyncGenerator<StreamEvent> {
    const params = toGeminiParams(req)
    const client = geminiClient(conn)
    const round: Round<Content> = async function* (history, toolsAllowed) {
      const stream = await client.models.generateContentStream({
        ...params,
        contents: history,
        config: {
          ...params.config,
          ...(params.config?.tools && {
            toolConfig: {
              functionCallingConfig: {
                mode: toolsAllowed ? FunctionCallingConfigMode.AUTO : FunctionCallingConfigMode.NONE
              }
            }
          })
        }
      })
      return yield* fromGeminiChunks(stream)
    }
    yield* runRounds(
      req.tools,
      params.contents as Content[],
      round,
      (calls, outputs) => {
        const results: Content = {
          role: 'user',
          parts: calls.map((c, i) => ({
            functionResponse: { ...(c.id && { id: c.id }), name: c.name, response: { result: outputs[i].text } }
          }))
        }
        const images = toolImagesMessage(outputs)
        return images ? [results, { role: 'user', parts: images.map(toPart) }] : [results]
      },
      req.signal
    )
  }
  return guard(run(), req.signal)
}
