import { describe, expect, it } from 'vitest'
import { lostClipLinks } from '@shared/noteClips'
import type { Message, StreamEvent, ThreadSession } from '@shared/types'
import { openDb } from '../src/main/db'
import { createMark } from '../src/main/db/repo/marks'
import { appendMessage, saveReply } from '../src/main/db/repo/messages'
import { getNoteContent, listRevisions, saveNote } from '../src/main/db/repo/notes'
import { addModel, createProvider } from '../src/main/db/repo/providers'
import { createMainSession, createThreadSession } from '../src/main/db/repo/sessions'
import {
  conversationTranscript,
  createOrganizer,
  ORGANIZE_SESSION_PROMPT,
  REWRITE_NOTE_PROMPT,
  sessionTranscript
} from '../src/main/llm/organize'
import type { ChatRequest } from '../src/main/llm/types'
import { appendAiDraft, replaceWithAiRewrite } from '../src/main/notes'

function msg(id: string, seq: number, role: 'user' | 'assistant', content: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    sessionId: 's',
    seq,
    role,
    content,
    thinking: null,
    thinkingMs: null,
    attachments: [],
    status: 'done',
    error: null,
    errorKind: null,
    providerId: null,
    modelId: null,
    inputTokens: null,
    outputTokens: null,
    web: null,
    createdAt: 0,
    ...extra
  }
}

const thread = (anchorMessageId: string, anchorQuote: string) =>
  ({ id: `t-${anchorMessageId}`, kind: 'thread', anchorMessageId, anchorQuote }) as ThreadSession

const EMPTY = { threads: [], marks: [], categories: [], fileNames: new Map(), note: '' }

describe('sessionTranscript', () => {
  it('puts each thread right after the reply it asks about', () => {
    const text = sessionTranscript({
      ...EMPTY,
      messages: [msg('a2', 2, 'assistant', '闭包是…'), msg('u1', 1, 'user', '什么是闭包'), msg('u3', 3, 'user', '还有呢')],
      threads: [{ thread: thread('a2', '闭包是'), messages: [msg('tu', 1, 'user', '没懂'), msg('ta', 2, 'assistant', '换个说法')] }]
    })
    expect(text).toBe(
      '<对话>\n我：什么是闭包\n\n回答：闭包是…\n\n〔追问，关于「闭包是」〕\n我：没懂\n\n回答：换个说法\n〔追问结束〕\n\n我：还有呢\n</对话>'
    )
  })

  it('skips failed and unfinished replies, and threads left with nothing', () => {
    const text = sessionTranscript({
      ...EMPTY,
      messages: [
        msg('u1', 1, 'user', '问'),
        msg('a2', 2, 'assistant', '半截', { status: 'error' }),
        msg('a3', 3, 'assistant', '', { status: 'stopped' })
      ],
      threads: [{ thread: thread('u1', 'x'), messages: [] }]
    })
    expect(text).toBe('<对话>\n我：问\n</对话>')
  })

  it('names attached files and expands brought-back results', () => {
    const text = sessionTranscript({
      ...EMPTY,
      fileNames: new Map([['f1', '讲义.pdf']]),
      messages: [
        msg('u1', 1, 'user', '看看这个', {
          attachments: [
            { type: 'file', fileId: 'f1' },
            { type: 'thread_result', threadId: 't', messageId: 'm', quote: '原句', text: '结论' }
          ]
        })
      ]
    })
    expect(text).toContain('我：[附件：讲义.pdf]\n[追问结论] 关于「原句」：结论\n看看这个')
  })

  it('lists marks with their category and comment, then the note as already written', () => {
    const mark = (quote: string, categoryId: string | null, comment: string | null) =>
      ({ quote, categoryId, comment }) as never
    const text = sessionTranscript({
      ...EMPTY,
      messages: [msg('u1', 1, 'user', '问')],
      marks: [mark('要点一', 'c1', '记住'), mark('要点二', null, null)],
      categories: [{ id: 'c1', name: '重点', color: '', sortOrder: 0 }],
      note: '## 已有\n'
    })
    expect(text).toContain('<用户标出的重点>\n- 【重点】「要点一」 批注：记住\n- 「要点二」\n</用户标出的重点>')
    expect(text).toContain('<现有笔记（这些已经写过，不要重复）>\n## 已有\n</现有笔记>')
  })
})

function setup() {
  const db = openDb(':memory:')
  const provider = createProvider(db, { name: 'P', protocol: 'anthropic', baseUrl: 'http://x', apiKeyEnc: null })
  const model = addModel(db, provider.id, {
    modelName: 'm',
    displayName: 'M',
    supportsVision: false,
    supportsThinking: true,
    thinkingCanDisable: false,
    supportsTools: true,
    contextWindow: null,
    maxOutputTokens: 4000
  })
  const ids = { providerId: provider.id, modelId: model.id }
  const main = createMainSession(db, { title: '闭包', projectId: null, ...ids })
  const target = { scope: 'session', scopeId: main.id } as const
  return { db, ids, main, target }
}

const done = (u: string): StreamEvent[] => [
  { type: 'text', delta: u },
  { type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }
]

describe('conversationTranscript', () => {
  it('holds the main conversation only, not its threads or marks', () => {
    const { db, ids, main } = setup()
    appendMessage(db, main.id, { role: 'user', content: '什么是闭包', attachments: [] })
    const reply = appendMessage(db, main.id, { role: 'assistant', ...ids })
    saveReply(db, reply.id, {
      content: '闭包是函数加环境',
      thinking: null,
      thinkingMs: null,
      status: 'done',
      error: null,
      errorKind: null,
      inputTokens: null,
      outputTokens: null,
      web: null
    })
    const t = createThreadSession(db, {
      parentSessionId: main.id,
      anchorMessageId: reply.id,
      anchorQuote: '环境',
      anchorStart: 5,
      anchorEnd: 7,
      anchorPrefix: '',
      anchorSuffix: '',
      contextMode: 'fork',
      title: '环境',
      ...ids
    })
    appendMessage(db, t.id, { role: 'user', content: '环境指什么', attachments: [] })
    createMark(db, { messageId: reply.id, quote: '函数', startOffset: 3, endOffset: 5, prefix: '', suffix: '', comment: null, categoryId: null })

    expect(conversationTranscript(db, main.id)).toBe('<对话>\n我：什么是闭包\n\n回答：闭包是函数加环境\n</对话>')
  })
})

describe('organizer', () => {
  it('sends the whole conversation with its threads and marks, and streams the draft back', async () => {
    const { db, ids, main, target } = setup()
    appendMessage(db, main.id, { role: 'user', content: '什么是闭包', attachments: [] })
    const reply = appendMessage(db, main.id, { role: 'assistant', ...ids })
    saveReply(db, reply.id, {
      content: '闭包是函数加环境',
      thinking: null,
      thinkingMs: null,
      status: 'done',
      error: null,
      errorKind: null,
      inputTokens: null,
      outputTokens: null, web: null
    })
    const t = createThreadSession(db, {
      parentSessionId: main.id,
      anchorMessageId: reply.id,
      anchorQuote: '环境',
      anchorStart: 5,
      anchorEnd: 7,
      anchorPrefix: '',
      anchorSuffix: '',
      contextMode: 'fork',
      title: '环境',
      ...ids
    })
    appendMessage(db, t.id, { role: 'user', content: '环境指什么', attachments: [] })
    createMark(db, {
      messageId: reply.id,
      quote: '函数',
      startOffset: 3,
      endOffset: 5,
      prefix: '',
      suffix: '',
      comment: null,
      categoryId: null
    })
    saveNote(db, target, '## 旧笔记')

    const requests: ChatRequest[] = []
    const events: StreamEvent[] = []
    const organizer = createOrganizer({
      db,
      connection: () => ({ protocol: 'anthropic', baseUrl: '', apiKey: '' }),
      emit: (_, e) => events.push(e),
      stream: async function* (_, req) {
        requests.push(req)
        yield* done('## 闭包')
      }
    })
    const started = organizer.start({ mode: 'session', sessionId: main.id, target, modelId: ids.modelId, thinking: 'off' })
    await organizer.idle()

    expect(started.base).toBe('## 旧笔记')
    const [req] = requests
    expect(req.system).toBe(ORGANIZE_SESSION_PROMPT)
    // This model can't turn thinking off, so "off" runs as "low" (D-029).
    expect(req).toMatchObject({ model: 'm', thinking: 'low', maxOutputTokens: 4000 })
    const text = (req.messages[0].content[0] as { text: string }).text
    expect(text).toContain('〔追问，关于「环境」〕\n我：环境指什么')
    expect(text).toContain('- 「函数」')
    expect(text).toContain('## 旧笔记')
    expect(events.map((e) => e.type)).toEqual(['text', 'done'])
    // Nothing is written until the draft is accepted.
    expect(listRevisions(db, target)).toHaveLength(0)
  })

  it('sends only the note for a rewrite, and stops when asked', async () => {
    const { db, ids, target } = setup()
    saveNote(db, target, '## A\n\n## A')
    const requests: ChatRequest[] = []
    const organizer = createOrganizer({
      db,
      connection: () => ({ protocol: 'anthropic', baseUrl: '', apiKey: '' }),
      emit: () => {},
      stream: async function* (_, req) {
        requests.push(req)
        await new Promise((resolve) => req.signal.addEventListener('abort', resolve))
      }
    })
    const { jobId } = organizer.start({ mode: 'rewrite', target, modelId: ids.modelId, thinking: 'medium' })
    organizer.stop(jobId)
    await organizer.idle()
    expect(requests[0].system).toBe(REWRITE_NOTE_PROMPT)
    expect(requests[0].messages[0].content).toEqual([{ type: 'text', text: '<笔记>\n## A\n\n## A\n</笔记>' }])
  })
})

describe('writing AI results', () => {
  it('appends a draft after a blank line and keeps a revision', () => {
    const { db, target } = setup()
    saveNote(db, target, '## 旧\n')
    expect(appendAiDraft(db, target, '\n## 新\n\n')).toBe('## 旧\n\n## 新\n')
    expect(listRevisions(db, target).map((r) => [r.reason, r.content])).toEqual([['ai_append', '## 旧\n']])
  })

  it('replaces the note only while it still reads as the base', () => {
    const { db, target } = setup()
    saveNote(db, target, '旧')
    expect(() => replaceWithAiRewrite(db, target, '更旧', '新')).toThrow()
    expect(getNoteContent(db, target)).toBe('旧')
    expect(replaceWithAiRewrite(db, target, '旧', '新')).toBe('新')
    expect(listRevisions(db, target).map((r) => r.reason)).toEqual(['ai_rewrite'])
  })

  it('counts the clip links a rewrite dropped, duplicates included', () => {
    const a = '> x\n>\n> —— [《会话》](hush://message/m1#0-3)'
    const b = '> y\n>\n> —— [《会话》](hush://message/m2#4-9)'
    expect(lostClipLinks(`${a}\n\n${b}`, `${b}\n\n${a}`)).toBe(0)
    expect(lostClipLinks(`${a}\n\n${a}\n\n${b}`, a)).toBe(2)
  })
})
