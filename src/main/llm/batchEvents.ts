import type { StreamEvent } from '@shared/types'

type Delta = Extract<StreamEvent, { type: 'text' | 'thinking' }>

export function createEventBatcher(send: (messageId: string, event: StreamEvent) => void, interval = 30) {
  const replies = new Map<string, {
    type: Delta['type']
    lastSent: number
    pending: Delta | null
    timer: ReturnType<typeof setTimeout> | null
  }>()

  function flush(messageId: string): void {
    const reply = replies.get(messageId)
    if (!reply) return
    if (reply.timer !== null) clearTimeout(reply.timer)
    replies.delete(messageId)
    if (reply.pending) send(messageId, reply.pending)
  }

  return {
    emit(messageId: string, event: StreamEvent): void {
      if (event.type !== 'text' && event.type !== 'thinking') {
        flush(messageId)
        send(messageId, event)
        return
      }
      if (replies.get(messageId)?.type !== event.type) flush(messageId)
      let reply = replies.get(messageId)
      if (!reply) {
        reply = { type: event.type, lastSent: Date.now(), pending: null, timer: null }
        replies.set(messageId, reply)
        // Each phase starts immediately so the renderer can time thinking from event arrival.
        send(messageId, event)
        return
      }
      reply.pending = { type: event.type, delta: (reply.pending?.delta ?? '') + event.delta }
      if (reply.timer !== null) return
      const emitPending = (): void => {
        const pending = reply.pending!
        reply.pending = null
        reply.timer = null
        reply.lastSent = Date.now()
        send(messageId, pending)
      }
      const delay = Math.max(0, interval - (Date.now() - reply.lastSent))
      if (delay === 0) emitPending()
      else reply.timer = setTimeout(emitPending, delay)
    },
    flush,
    flushAll(): void {
      for (const messageId of replies.keys()) flush(messageId)
    }
  }
}
