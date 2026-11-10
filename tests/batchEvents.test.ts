import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamEvent } from '@shared/types'
import { createEventBatcher } from '../src/main/llm/batchEvents'

describe('chat event batching', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['text', 'thinking'] as const)('sends the first %s immediately and batches a sustained stream every 30ms', (type) => {
    const send = vi.fn()
    const batch = createEventBatcher(send)
    batch.emit('reply', { type, delta: '0' })
    expect(send.mock.calls).toEqual([['reply', { type, delta: '0' }]])
    for (let i = 1; i <= 90; i++) {
      vi.advanceTimersByTime(1)
      batch.emit('reply', { type, delta: String(i) })
    }
    expect(send).toHaveBeenCalledTimes(4)
    batch.flush('reply')
    expect(send.mock.calls.map(([, e]) => e.delta).join('')).toBe(
      Array.from({ length: 91 }, (_, i) => String(i)).join('')
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes both directions of a phase switch immediately, preserving thinking timing', () => {
    const events: { time: number; event: StreamEvent }[] = []
    vi.setSystemTime(0)
    const batch = createEventBatcher((_id, event) => events.push({ time: Date.now(), event }))
    batch.emit('r', { type: 'thinking', delta: 'a' })
    vi.advanceTimersByTime(5)
    batch.emit('r', { type: 'thinking', delta: 'b' })
    vi.advanceTimersByTime(5)
    batch.emit('r', { type: 'text', delta: 'c' })
    batch.emit('r', { type: 'text', delta: 'd' })
    vi.advanceTimersByTime(5)
    batch.emit('r', { type: 'thinking', delta: 'e' })
    expect(events).toEqual([
      { time: 0, event: { type: 'thinking', delta: 'a' } },
      { time: 10, event: { type: 'thinking', delta: 'b' } },
      { time: 10, event: { type: 'text', delta: 'c' } },
      { time: 15, event: { type: 'text', delta: 'd' } },
      { time: 15, event: { type: 'thinking', delta: 'e' } }
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  const boundaries: StreamEvent[] = [
    { type: 'step', step: { type: 'search', query: 'test' } },
    { type: 'sources', sources: [] },
    { type: 'done', usage: { input: 1, output: 2 }, stopReason: 'stop' },
    { type: 'error', kind: 'other', message: 'failed' }
  ]
  it.each(boundaries)('flushes pending text before $type and cancels its timer', (event) => {
    const send = vi.fn()
    const batch = createEventBatcher(send)
    batch.emit('r', { type: 'text', delta: 'a' })
    batch.emit('r', { type: 'text', delta: 'b' })
    batch.emit('r', event)
    expect(send.mock.calls).toEqual([
      ['r', { type: 'text', delta: 'a' }],
      ['r', { type: 'text', delta: 'b' }],
      ['r', event]
    ])
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('flushes a stopped reply without waiting for another event and leaves other replies running', () => {
    const send = vi.fn()
    const batch = createEventBatcher(send)
    batch.emit('main', { type: 'text', delta: 'a' })
    batch.emit('thread', { type: 'thinking', delta: 'b' })
    batch.emit('main', { type: 'text', delta: 'c' })
    batch.emit('thread', { type: 'thinking', delta: 'd' })
    batch.flush('main')
    batch.flush('main')
    expect(send.mock.calls.at(-1)).toEqual(['main', { type: 'text', delta: 'c' }])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(30)
    expect(send.mock.calls.at(-1)).toEqual(['thread', { type: 'thinking', delta: 'd' }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not replay buffered deltas after a live snapshot', () => {
    let displayed = ''
    const batch = createEventBatcher((_id, event) => {
      if (event.type === 'text') displayed += event.delta
    })
    batch.emit('r', { type: 'text', delta: 'a' })
    batch.emit('r', { type: 'text', delta: 'b' })
    batch.flushAll()
    displayed = 'ab'
    batch.emit('r', { type: 'text', delta: 'c' })
    vi.runAllTimers()
    expect(displayed).toBe('abc')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends sparse deltas without an extra interval of latency', () => {
    const send = vi.fn()
    const batch = createEventBatcher(send)
    batch.emit('r', { type: 'text', delta: 'a' })
    vi.advanceTimersByTime(100)
    batch.emit('r', { type: 'text', delta: 'b' })
    expect(send).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
