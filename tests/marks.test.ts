import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { createMark, deleteMark, listMarks, updateMark } from '../src/main/db/repo/marks'
import { appendMessage } from '../src/main/db/repo/messages'
import { addModel, createProvider } from '../src/main/db/repo/providers'
import { createMainSession, createThreadSession } from '../src/main/db/repo/sessions'

function setup() {
  const db = openDb(':memory:')
  const provider = createProvider(db, { name: 'P', protocol: 'anthropic', baseUrl: 'http://x', apiKeyEnc: null })
  const model = addModel(db, provider.id, {
    modelName: 'm',
    displayName: 'M',
    supportsVision: false,
    supportsThinking: false,
    thinkingCanDisable: true,
    supportsTools: true,
    contextWindow: null,
    maxOutputTokens: null
  })
  const ids = { providerId: provider.id, modelId: model.id }
  const main = createMainSession(db, { title: '会话', projectId: null, ...ids })
  const reply = (sessionId: string) => appendMessage(db, sessionId, { role: 'assistant', ...ids })
  const markAt = (messageId: string, start: number, end: number) =>
    createMark(db, {
      messageId,
      quote: 'x'.repeat(end - start),
      startOffset: start,
      endOffset: end,
      prefix: '',
      suffix: '',
      comment: null,
      categoryId: 'cat-knowledge'
    })
  return { db, ids, main, reply, markAt }
}

describe('mark repo', () => {
  it('files a mark made in a thread under the main session', () => {
    const { db, ids, main, reply, markAt } = setup()
    const anchor = reply(main.id)
    const thread = createThreadSession(db, {
      parentSessionId: main.id,
      anchorMessageId: anchor.id,
      anchorQuote: '原句',
      anchorStart: 0,
      anchorEnd: 2,
      anchorPrefix: '',
      anchorSuffix: '',
      contextMode: 'fork',
      title: '原句',
      ...ids
    })
    markAt(anchor.id, 0, 4)
    const inThread = markAt(reply(thread.id).id, 0, 4)
    expect(inThread.sessionId).toBe(main.id)
    expect(listMarks(db, main.id)).toHaveLength(2)
  })

  it('refuses a mark that overlaps another in the same message, not one that only touches it', () => {
    const { main, reply, markAt } = setup()
    const message = reply(main.id)
    markAt(message.id, 10, 20)
    expect(() => markAt(message.id, 15, 25)).toThrow(/overlaps/)
    expect(() => markAt(message.id, 5, 30)).toThrow(/overlaps/)
    expect(() => markAt(message.id, 20, 30)).not.toThrow()
    expect(() => markAt(reply(main.id).id, 10, 20)).not.toThrow()
  })

  it('updates the comment and category, and deletes', () => {
    const { db, main, reply, markAt } = setup()
    const mark = markAt(reply(main.id).id, 0, 4)
    expect(updateMark(db, mark.id, { comment: '批注', categoryId: 'cat-question' })).toMatchObject({
      comment: '批注',
      categoryId: 'cat-question'
    })
    deleteMark(db, mark.id)
    expect(listMarks(db, main.id)).toEqual([])
  })
})
