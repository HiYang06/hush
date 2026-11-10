import { describe, expect, it } from 'vitest'
import type { Message } from '@shared/types'
import { createRoundSummaries } from '../../src/renderer/src/components/chat/RoundRail'

function message(id: string, role: Message['role'], content: string): Message {
  return {
    id, role, content, sessionId: 's', seq: 0, thinking: null, thinkingMs: null,
    attachments: [], status: 'done', error: null, errorKind: null, providerId: null,
    modelId: null, inputTokens: null, outputTokens: null, web: null, createdAt: 0
  }
}

describe('round rail summaries', () => {
  it('reuses earlier rounds while the last answer preview and tick grow', () => {
    const summarize = createRoundSummaries()
    const messages = [
      message('q1', 'user', 'first question'), message('a1', 'assistant', 'first answer'),
      message('q2', 'user', 'second question'), message('a2', 'assistant', 'short')
    ]
    const before = summarize(messages)
    const after = summarize([...messages.slice(0, -1), { ...messages[3], content: 'a longer **answer**' }])
    expect(after[0]).toBe(before[0])
    expect(after[1].answer).toBe('a longer answer')
    expect(after[1].length).toBeGreaterThan(before[1].length)
  })

  it('updates the tick after the preview has reached its limit', () => {
    const summarize = createRoundSummaries()
    const question = message('q', 'user', '')
    const answer = message('a', 'assistant', 'x'.repeat(500))
    const [before] = summarize([question, answer])
    const [after] = summarize([question, { ...answer, content: 'x'.repeat(1000) }])
    expect(after.question).toBe('（附件）')
    expect(after.answer).toBe(before.answer)
    expect(after.length).toBeGreaterThan(before.length)
  })

  it('handles appended rounds, regeneration and replacement of a question with the same id', () => {
    const summarize = createRoundSummaries()
    const question = message('q', 'user', 'old question')
    const answer = message('a', 'assistant', 'old answer')
    const [old] = summarize([question, answer])
    const appended = summarize([question, answer, message('next', 'user', 'next')])
    expect(appended[0]).toBe(old)
    expect(appended[1].answer).toBe('')
    const [regenerated] = summarize([question, message('new-a', 'assistant', 'new answer')])
    expect(regenerated.answer).toBe('new answer')
    const [edited] = summarize([{ ...question, content: 'edited question' }])
    expect(edited.question).toBe('edited question')
    expect(edited.answer).toBe('')
    expect(summarize([])).toEqual([])
  })

  it('does not expose a thinking block cut off by the preview limit', () => {
    const summarize = createRoundSummaries()
    const question = message('q', 'user', 'question')
    expect(summarize([question, message('a', 'assistant', '<thinking>' + 'private '.repeat(100) + '</thinking>answer')])[0].answer).toBe('')
    expect(summarize([question, message('a', 'assistant', '<thinking>brief</thinking>**answer**')])[0].answer).toBe('answer')
  })
})
