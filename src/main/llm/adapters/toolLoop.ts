import type { StreamEvent } from '@shared/types'
import type { ContentPart, ToolCall, ToolOutput, Tools } from '../types'

export type Usage = { input: number; output: number }

// One request to the provider. `N` is the protocol's own message type: within one reply each provider
// wants its previous output sent back verbatim (signatures, reasoning items), so history stays native.
export type RoundEnd<N> = { calls: ToolCall[]; reply: N[]; usage: Usage; stopReason: string }

// Yields thinking and text; returns null after yielding an error.
export type Round<N> = (history: N[], toolsAllowed: boolean) => AsyncGenerator<StreamEvent, RoundEnd<N> | null>

// After this many rounds with tools the model must answer with what it has.
export const MAX_TOOL_ROUNDS = 6

// Request → run the tools it asks for → send the results back → request again, until it answers.
// Usage is summed over the rounds, since each one is billed.
export async function* runRounds<N>(
  tools: Tools | undefined,
  history: N[],
  round: Round<N>,
  toolResults: (calls: ToolCall[], outputs: ToolOutput[]) => N[],
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const usage: Usage = { input: 0, output: 0 }
  let wroteText = false
  for (let i = 0; ; i++) {
    const allowed = tools !== undefined && i < MAX_TOOL_ROUNDS
    const rounds = round(history, allowed)
    let breakBefore = wroteText
    let next = await rounds.next()
    while (!next.done) {
      const event = next.value
      if (event.type === 'text') {
        // What the model said before a search and its answer after it are separate paragraphs.
        if (breakBefore) yield { type: 'text', delta: '\n\n' }
        breakBefore = false
        wroteText = true
      }
      yield event
      next = await rounds.next()
    }
    const end = next.value
    if (!end) return
    usage.input += end.usage.input
    usage.output += end.usage.output
    if (!tools || !allowed || end.calls.length === 0) {
      yield { type: 'done', usage, stopReason: end.stopReason }
      return
    }
    const outputs: ToolOutput[] = []
    for (const call of end.calls) {
      const output = yield* tools.run(call, signal)
      outputs.push(typeof output === 'string' ? { text: output, images: [] } : output)
    }
    history = [...history, ...end.reply, ...toolResults(end.calls, outputs)]
  }
}

// Each image after its label, in the order the tools returned them.
export function labelledImages(outputs: ToolOutput[]): ContentPart[] {
  return outputs.flatMap((o) =>
    o.images.flatMap((img): ContentPart[] => [
      { type: 'text', text: img.label },
      { type: 'image', mime: img.mime, data: img.data }
    ])
  )
}

// OpenAI Chat, Responses and Gemini: a tool result is text only on many compatible providers, which
// answer 400 to anything else, so the images follow in a user message of their own (D-077).
export function toolImagesMessage(outputs: ToolOutput[]): ContentPart[] | null {
  const images = labelledImages(outputs)
  if (images.length === 0) return null
  return [{ type: 'text', text: '（上面工具结果里的页面图片）' }, ...images]
}
