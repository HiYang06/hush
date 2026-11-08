import type { StreamEvent } from '@shared/types'

type ErrorEvent = Extract<StreamEvent, { type: 'error' }>

// No provider has a dedicated status for an over-long prompt; it arrives as a 400 with wording like
// "prompt is too long", "maximum context length" or "exceeds the maximum number of tokens".
const CONTEXT_LENGTH = /context.?(length|window)|too long|too many tokens|maximum.{0,40}tokens|token limit/i

// All three SDKs put the HTTP status on `status`; a request that never got a response has none.
export function classifyError(err: unknown): ErrorEvent {
  const message = err instanceof Error ? err.message : String(err)
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number') return { type: 'error', kind: 'network', message }
  if (status === 401 || status === 403) return { type: 'error', kind: 'auth', message }
  if (status === 429) return { type: 'error', kind: 'rate_limit', message }
  if ((status === 400 || status === 413) && CONTEXT_LENGTH.test(message)) {
    return { type: 'error', kind: 'context_length', message }
  }
  return { type: 'error', kind: 'other', message }
}

// Turns any failure into an error event, and goes silent once the caller cancels: it aborted on purpose
// and already knows. Some SDKs end an aborted stream normally instead of throwing, which would otherwise
// look like a finished answer.
export async function* guard(
  events: AsyncIterable<StreamEvent>,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  try {
    for await (const event of events) {
      if (signal.aborted) return
      yield event
    }
  } catch (err) {
    if (!signal.aborted) yield classifyError(err)
  }
}
