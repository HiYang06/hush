import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { PPTX_MIME } from '@shared/files'
import type { Attachment, FileRecord, Message, Session, StreamEvent, ThreadAnchor } from '@shared/types'
import { openDb } from '../src/main/db'
import { createMark, listMarks } from '../src/main/db/repo/marks'
import { getMessage, listConversationMessages, listMessages } from '../src/main/db/repo/messages'
import { search } from '../src/main/db/repo/search'
import { createProject, updateProject } from '../src/main/db/repo/projects'
import { addModel, createProvider, updateModel } from '../src/main/db/repo/providers'
import { deleteSession, getSession, listSessions, renameSession } from '../src/main/db/repo/sessions'
import { createFileStore } from '../src/main/files/store'
import { createChat, threadTitle } from '../src/main/llm/chat'
import { cleanTitle, TITLE_PROMPT, titleQuestion } from '../src/main/llm/title'
import { buildContext, pickSystemPrompt, type LoadedFile } from '../src/main/llm/context'
import type { ChatRequest, Tools } from '../src/main/llm/types'

const noDownload = async (): Promise<Buffer> => {
  throw new Error('not synced')
}

const MODEL = {
  modelName: 'm',
  supportsVision: false,
  supportsTools: false,
  supportsThinking: true,
  thinkingCanDisable: true,
  maxOutputTokens: null
}

function msg(seq: number, role: 'user' | 'assistant', content: string, extra: Partial<Message> = {}): Message {
  return {
    id: `m${seq}`,
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

const MAIN: Session = {
  id: 's',
  kind: 'main',
  projectId: null,
  parentSessionId: null,
  anchorMessageId: null,
  anchorQuote: null,
  anchorStart: null,
  anchorEnd: null,
  anchorPrefix: null,
  anchorSuffix: null,
  contextMode: null,
  title: '',
  providerId: null,
  modelId: null,
  createdAt: 0,
  updatedAt: 0
}

function thread(contextMode: 'fork' | 'new'): Session {
  return {
    ...MAIN,
    projectId: null,
    id: 't',
    kind: 'thread',
    parentSessionId: 's',
    anchorMessageId: 'm2',
    anchorQuote: '特征值',
    anchorStart: 0,
    anchorEnd: 3,
    anchorPrefix: '',
    anchorSuffix: '',
    contextMode
  }
}

const DATE_LINE = /^\[\d{4}-\d{2}-\d{2} 周.\](\n\n)?/

// The date line on user messages has its own test; the others compare the rest.
function undated<T extends Pick<ReturnType<typeof buildContext>, 'messages'>>(req: T): T {
  return {
    ...req,
    messages: req.messages.map((m) => ({
      ...m,
      content: m.content.flatMap((p, i) => {
        if (i > 0 || p.type !== 'text') return [p]
        const text = p.text.replace(DATE_LINE, '')
        return text ? [{ ...p, text }] : []
      })
    }))
  }
}

const build = (input: Parameters<typeof buildContext>[0]): ReturnType<typeof buildContext> =>
  undated(buildContext(input))

function texts(req: Pick<ReturnType<typeof buildContext>, 'messages'>): [string, string][] {
  return req.messages.map((m) => [m.role, m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')])
}

describe('buildContext', () => {
  const base = {
    parentMessages: [],
    projectPrompt: null,
    globalPrompt: '',
    model: MODEL,
    thinking: 'medium' as const,
    files: new Map()
  }

  it('picks exactly one prompt: project, then global, else none', () => {
    expect(pickSystemPrompt('项目提示词', '全局')).toBe('项目提示词')
    expect(pickSystemPrompt('  ', '全局')).toBe('全局')
    expect(pickSystemPrompt(null, '')).toBe('')
  })

  it('sends messages in order, skipping failed and unfinished replies and merging the user turns left behind', () => {
    const req = build({
      ...base,
      session: MAIN,
      messages: [
        msg(5, 'assistant', '', { status: 'streaming' }),
        msg(1, 'user', '问题一'),
        msg(2, 'assistant', '半截回答', { status: 'error' }),
        msg(3, 'user', '问题二'),
        msg(4, 'user', '问题三')
      ]
    })
    expect(texts(req)).toEqual([['user', '问题一\n\n问题二\n\n问题三']])
  })

  it('keeps a stopped reply; earlier thinking stays out of the text and only rides along for the adapters', () => {
    const req = build({
      ...base,
      session: MAIN,
      messages: [msg(1, 'user', '问'), msg(2, 'assistant', '答到一半', { status: 'stopped', thinking: '想法' }), msg(3, 'user', '继续')]
    })
    expect(texts(req)).toEqual([
      ['user', '问'],
      ['assistant', '答到一半'],
      ['user', '继续']
    ])
    expect(req.messages[1].thinking).toBe('想法')
  })

  it('an earlier reply that went online carries the list of sources it cited, not the pages', () => {
    const source = (n: number) => ({ n, url: `https://s${n}.com`, title: `来源${n}`, date: null, snippet: '片段' })
    const req = build({
      ...base,
      session: MAIN,
      messages: [
        msg(1, 'user', '最新进展？'),
        msg(2, 'assistant', '有两点 [1]。另外 [3][1]。', {
          web: { steps: [{ type: 'search', query: 'q' }], sources: [source(1), source(2), source(3)] }
        }),
        msg(3, 'user', '展开第一点')
      ]
    })
    expect(texts(req)[1][1]).toBe('有两点 [1]。另外 [3][1]。\n\n来源：\n[1] 来源1 https://s1.com\n[3] 来源3 https://s3.com')
  })

  it('expands brought-back results, note and session references before the typed text', () => {
    const req = build({
      ...base,
      session: MAIN,
      messages: [
        msg(1, 'user', '那它有什么用？', {
          attachments: [
            { type: 'thread_result', threadId: 't', messageId: 'x', quote: '特征值', text: '缩放比例' },
            { type: 'note_ref', noteId: 'n', sectionTitle: '定义', label: '《线代》/ 定义', text: 'Av = λv' },
            { type: 'session_ref', sessionId: 's2', label: '《矩阵入门》', text: '<对话>\n我：什么是矩阵\n</对话>' }
          ]
        })
      ]
    })
    expect(texts(req)[0][1]).toBe(
      '[追问结论] 关于「特征值」：缩放比例\n\n[笔记引用：《线代》/ 定义]\nAv = λv\n\n[会话引用：《矩阵入门》]\n<对话>\n我：什么是矩阵\n</对话>\n\n那它有什么用？'
    )
  })

  it('expands a mark quiz into the quiz instructions and numbered questions, with comments only where written', () => {
    const req = build({
      ...base,
      session: MAIN,
      messages: [
        msg(1, 'user', '只考第二条', {
          attachments: [
            {
              type: 'mark_quiz',
              sessionId: 's2',
              label: '《线代入门》',
              marks: [
                { quote: '特征值', comment: '为什么是缩放比例？' },
                { quote: 'Av = λv', comment: null }
              ]
            }
          ]
        })
      ]
    })
    const sent = texts(req)[0][1]
    expect(sent).toContain('[考考我：《线代入门》]\n')
    expect(sent).toContain('一次只出一道题')
    expect(sent.endsWith('1. 原文：「特征值」\n我的批注：为什么是缩放比例？\n\n2. 原文：「Av = λv」\n\n只考第二条')).toBe(true)
  })

  it('fork thread: main conversation up to the anchor, then the thread with its prefix on the first question', () => {
    const parent = [msg(1, 'user', '什么是矩阵'), msg(2, 'assistant', '……特征值……'), msg(3, 'user', '后面的问题'), msg(4, 'assistant', '后面的回答')]
    const req = build({
      ...base,
      session: thread('fork'),
      parentMessages: parent,
      messages: [
        msg(1, 'user', '为什么？', { id: 't1' }),
        msg(2, 'assistant', '因为', { id: 't2' }),
        msg(3, 'user', '还有呢', { id: 't3' })
      ]
    })
    expect(texts(req)).toEqual([
      ['user', '什么是矩阵'],
      ['assistant', '……特征值……'],
      ['user', '我在读你上面的回答时，对这段不太理解：「特征值」\n\n为什么？'],
      ['assistant', '因为'],
      ['user', '还有呢']
    ])
  })

  it('new thread: only the thread, with the "about this passage" prefix', () => {
    const req = build({
      ...base,
      session: thread('new'),
      parentMessages: [msg(1, 'user', '什么是矩阵'), msg(2, 'assistant', '……特征值……')],
      messages: [msg(1, 'user', '展开讲讲', { id: 't1' })]
    })
    expect(texts(req)).toEqual([['user', '关于这段话：「特征值」\n\n展开讲讲']])
  })

  it('dates a user message only when its day differs from the previous one', () => {
    const day = (d: number, h: number): number => new Date(2026, 9, d, h).getTime()
    const req = buildContext({
      ...base,
      session: MAIN,
      messages: [
        msg(1, 'user', '早上问', { createdAt: day(25, 9) }),
        msg(2, 'assistant', '答'),
        msg(3, 'user', '晚上又问', { createdAt: day(25, 21) }),
        msg(4, 'assistant', '答'),
        msg(5, 'user', '隔天再问', { createdAt: day(27, 8) })
      ]
    })
    expect(texts(req)).toEqual([
      ['user', '[2026-10-25 周日]\n\n早上问'],
      ['assistant', '答'],
      ['user', '晚上又问'],
      ['assistant', '答'],
      ['user', '[2026-10-27 周二]\n\n隔天再问']
    ])
  })

  it('thinking: null without the capability, "off" becomes "low" when the model cannot turn it off', () => {
    const messages = [msg(1, 'user', '问')]
    expect(build({ ...base, session: MAIN, messages, model: { ...MODEL, supportsThinking: false } }).thinking).toBeNull()
    expect(
      build({ ...base, session: MAIN, messages, thinking: 'off', model: { ...MODEL, thinkingCanDisable: false } }).thinking
    ).toBe('low')
  })
})

function file(id: string, name: string, mime: string, extra: Partial<FileRecord> = {}): LoadedFile {
  return {
    record: { id, sha256: id, name, mime, size: 1, path: id, extracted: null, isScanned: null, createdAt: 0, ...extra },
    data: Buffer.from(id)
  }
}

function filesOf(...list: LoadedFile[]): Map<string, LoadedFile> {
  return new Map(list.map((f) => [f.record.id, f]))
}

function withFiles(...ids: string[]): Partial<Message> {
  return { attachments: ids.map((fileId) => ({ type: 'file', fileId })) }
}

describe('buildContext with files', () => {
  const base = {
    session: MAIN,
    parentMessages: [],
    projectPrompt: null,
    globalPrompt: '',
    thinking: 'medium' as const
  }
  const vision = { ...MODEL, supportsVision: true }

  it('sends an image (its downscaled copy when there is one) before the question', () => {
    const files = filesOf(
      file('big', 'big.png', 'image/png', { extracted: [{ type: 'image', fileId: 'small' }] }),
      file('small', 'big.jpg', 'image/jpeg')
    )
    const req = build({ ...base, model: vision, files, messages: [msg(1, 'user', '这是什么', withFiles('big'))] })
    expect(req.messages[0].content).toEqual([
      { type: 'image', mime: 'image/jpeg', data: Buffer.from('small') },
      { type: 'text', text: '这是什么' }
    ])
  })

  it('replaces earlier images with their name for a model that cannot see', () => {
    const files = filesOf(file('img', 'a.png', 'image/png'))
    const req = build({
      ...base,
      model: MODEL,
      files,
      messages: [msg(1, 'user', '看图', withFiles('img')), msg(2, 'assistant', '好'), msg(3, 'user', '再问')]
    })
    expect(texts(req)).toEqual([
      ['user', '[图片：a.png]\n\n看图'],
      ['assistant', '好'],
      ['user', '再问']
    ])
  })

  it('sends a PDF as its text, with the images of its figure pages for a model that can see', () => {
    const paper = file('t', 't.pdf', 'application/pdf', {
      isScanned: false,
      extracted: [
        { type: 'text', text: '## 第 1 页\n摘要' },
        { type: 'text', text: '## 第 2 页\nFigure 1. 架构' },
        { type: 'image', fileId: 'p2' }
      ]
    })
    const scanned = file('s', 's.pdf', 'application/pdf', {
      isScanned: true,
      extracted: [{ type: 'image', fileId: 'p1' }]
    })
    const files = filesOf(paper, scanned, file('p2', 't-2.jpg', 'image/jpeg'), file('p1', 's-1.jpg', 'image/jpeg'))
    const messages = [msg(1, 'user', '读', withFiles('t', 's'))]

    const seeing = build({ ...base, model: vision, files, messages })
    expect(seeing.messages[0].content).toEqual([
      { type: 'text', text: '[文件：t.pdf]\n\n## 第 1 页\n摘要\n\n## 第 2 页\nFigure 1. 架构' },
      { type: 'image', mime: 'image/jpeg', data: Buffer.from('p2') },
      { type: 'text', text: '[文件：s.pdf]' },
      { type: 'image', mime: 'image/jpeg', data: Buffer.from('p1') },
      { type: 'text', text: '读' }
    ])

    const textOnly = build({ ...base, model: MODEL, files, messages: [msg(1, 'user', '读', withFiles('t'))] })
    expect(texts(textOnly)).toEqual([['user', '[文件：t.pdf]\n\n## 第 1 页\n摘要\n\n## 第 2 页\nFigure 1. 架构\n\n读']])
  })

  it('drops the slide images of a pptx for a model that cannot see', () => {
    const deck = file('d', 'd.pptx', PPTX_MIME, {
      extracted: [
        { type: 'text', text: '## 第 1 页\n标题' },
        { type: 'image', fileId: 'e1' }
      ]
    })
    const files = filesOf(deck, file('e1', 'image1.png', 'image/png'))
    const req = build({ ...base, model: MODEL, files, messages: [msg(1, 'user', '总结', withFiles('d'))] })
    expect(texts(req)).toEqual([['user', '[文件：d.pptx]\n\n## 第 1 页\n标题\n\n总结']])
  })
})

// A fake adapter: replays the given events, honouring cancellation like the real ones do.
// Title calls are answered with `title` and kept apart from the conversation's requests.
function fakeStream(events: StreamEvent[], delayMs = 0, title: StreamEvent[] = TITLE_REPLY) {
  const requests: ChatRequest[] = []
  const titleRequests: ChatRequest[] = []
  const stream = async function* (_conn: unknown, req: ChatRequest): AsyncGenerator<StreamEvent> {
    if (req.system === TITLE_PROMPT) {
      titleRequests.push(req)
      yield* title
      return
    }
    requests.push(req)
    for (const e of events) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      if (req.signal.aborted) return
      yield e
    }
  }
  return { stream, requests, titleRequests }
}

const TITLE_REPLY: StreamEvent[] = [
  { type: 'text', delta: '数学 | 理解特征值' },
  { type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }
]

const DONE_EVENTS: StreamEvent[] = [
  { type: 'text', delta: '答' },
  { type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }
]

const ANCHOR: ThreadAnchor = {
  parentSessionId: '',
  anchorMessageId: '',
  anchorQuote: '答',
  anchorStart: 0,
  anchorEnd: 1,
  anchorPrefix: '',
  anchorSuffix: '',
  contextMode: 'fork'
}

function setup(
  events: StreamEvent[],
  delayMs = 0,
  webTools: () => Tools | null = () => null,
  title: StreamEvent[] = TITLE_REPLY
) {
  const db = openDb(':memory:')
  const provider = createProvider(db, { name: 'P', protocol: 'anthropic', baseUrl: 'http://x', apiKeyEnc: null })
  const model = addModel(db, provider.id, {
    modelName: 'claude-test',
    displayName: 'Claude',
    supportsVision: false,
    supportsThinking: true,
    thinkingCanDisable: true,
    supportsTools: true,
    contextWindow: null,
    maxOutputTokens: 8_000
  })
  const files = createFileStore(db, mkdtempSync(join(tmpdir(), 'hush-')), noDownload)
  const emitted: [string, StreamEvent][] = []
  const fake = fakeStream(events, delayMs, title)
  const updated: Session[] = []
  const chat = createChat({
    db,
    connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
    emit: (id, e) => emitted.push([id, e]),
    sessionUpdated: (session) => updated.push(session),
    readFile: files.read,
    ensureFile: async () => {},
    webTools,
    stream: fake.stream
  })
  const regenerate = (replyId: string, text: string | null = null) =>
    chat.regenerate({ replyId, text, modelId: model.id, thinking: 'high', webSearch: false })
  const send = (
    text: string,
    sessionId: string | null = null,
    attachments: Attachment[] = [],
    newThread: ThreadAnchor | null = null
  ) => chat.send({ sessionId, projectId: null, newThread, text, attachments, modelId: model.id, thinking: 'high', webSearch: false })
  return { db, chat, send, regenerate, emitted, requests: fake.requests, titleRequests: fake.titleRequests, updated, model, files }
}

describe('chat', () => {
  it('creates a session, streams the reply to the window and saves the final result', async () => {
    const { db, chat, send, emitted, requests } = setup([
      { type: 'thinking', delta: '想' },
      { type: 'text', delta: '答' },
      { type: 'text', delta: '案' },
      { type: 'done', usage: { input: 10, output: 20 }, stopReason: 'end_turn' }
    ])
    const { session, userMessage, assistantMessage } = send('什么是特征值，为什么它在矩阵分解中很重要')
    expect(session.title).toBe('什么是特征值，为什么它在矩阵分')
    expect(assistantMessage.status).toBe('streaming')
    await chat.idle()

    expect(requests[0]).toMatchObject({
      model: 'claude-test',
      system: '',
      thinking: 'high',
      maxOutputTokens: 8_000
    })
    expect(undated(requests[0]).messages).toEqual([{ role: 'user', content: [{ type: 'text', text: userMessage.content }] }])
    expect(emitted.map(([id, e]) => [id, e.type])).toEqual([
      [assistantMessage.id, 'thinking'],
      [assistantMessage.id, 'text'],
      [assistantMessage.id, 'text'],
      [assistantMessage.id, 'done']
    ])
    expect(getMessage(db, assistantMessage.id)).toMatchObject({
      content: '答案',
      thinking: '想',
      status: 'done',
      inputTokens: 10,
      outputTokens: 20
    })
    expect(getMessage(db, assistantMessage.id).thinkingMs).toBeGreaterThanOrEqual(0)
  })

  it('lists a reply still streaming as it is now, not as last saved', async () => {
    const { db, model } = setup(DONE_EVENTS)
    let finish = (): void => {}
    const finished = new Promise<void>((r) => (finish = r))
    let halfway = (): void => {}
    const reachedHalfway = new Promise<void>((r) => (halfway = r))
    const chat = createChat({
      db,
      connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
      emit: () => {},
      sessionUpdated: () => {},
      readFile: () => Buffer.alloc(0),
      ensureFile: async () => {},
      webTools: () => null,
      stream: async function* (_conn, req) {
        if (req.system === TITLE_PROMPT) return yield* TITLE_REPLY
        yield { type: 'text', delta: '答' }
        yield { type: 'text', delta: '案' }
        halfway()
        await finished
        yield { type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }
      }
    })
    const { session, assistantMessage } = chat.send({
      sessionId: null, projectId: null, newThread: null, text: '问', attachments: [], modelId: model.id, thinking: 'off', webSearch: false
    })
    await reachedHalfway
    // Saved at most every 0.5s, so the database still has the reply as it started.
    expect(getMessage(db, assistantMessage.id).content).toBe('')
    const live = chat.withLiveReplies(listConversationMessages(db, session.id))
    expect(live.find((m) => m.id === assistantMessage.id)).toMatchObject({ content: '答案', status: 'streaming' })

    finish()
    await chat.idle()
    const done = chat.withLiveReplies(listConversationMessages(db, session.id))
    expect(done.find((m) => m.id === assistantMessage.id)).toMatchObject({ content: '答案', status: 'done' })
  })

  it('titles a new session after its first reply, unless the user renamed it meanwhile', async () => {
    const done: StreamEvent[] = [{ type: 'text', delta: '答' }, { type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }]
    const { db, chat, send, titleRequests, updated } = setup(done)
    const { session } = send('什么是特征值')
    await chat.idle()
    expect(titleRequests[0]).toMatchObject({ thinking: 'off' })
    expect(updated.map((s) => s.title)).toEqual(['数学 | 理解特征值'])
    expect(listSessions(db).find((s) => s.id === session.id)?.title).toBe('数学 | 理解特征值')

    send('再问', session.id)
    await chat.idle()
    expect(titleRequests).toHaveLength(1)

    const renamed = setup(done, 20)
    const second = renamed.send('问')
    renameSession(renamed.db, second.session.id, '我自己起的')
    await renamed.chat.idle()
    expect(renamed.updated).toEqual([])
    expect(getSession(renamed.db, second.session.id).title).toBe('我自己起的')
  })

  it('keeps the placeholder title when the reply or the title call fails', async () => {
    const failed = setup([{ type: 'error', kind: 'network', message: 'x' }])
    failed.send('问')
    await failed.chat.idle()
    expect(failed.titleRequests).toEqual([])

    const titleFails = setup(
      [{ type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }],
      0,
      () => null,
      [{ type: 'error', kind: 'rate_limit', message: '429' }]
    )
    const { session } = titleFails.send('什么是特征值')
    await titleFails.chat.idle()
    expect(getSession(titleFails.db, session.id).title).toBe('什么是特征值')
  })

  it('cleans up titles that drift from the format', () => {
    expect(cleanTitle('「网络｜询问ACL概念」。\n这是因为…')).toBe('网络 | 询问ACL概念')
    expect(cleanTitle('标题：日常|问候')).toBe('日常 | 问候')
    expect(cleanTitle('   ')).toBeNull()
  })

  it('rejects a line without the bar: the model answered instead of titling', () => {
    expect(cleanTitle('这段内容是一次英语句子润色咨询，主要讲：\n1. …')).toBeNull()
    expect(cleanTitle('| 只有概括')).toBeNull()
  })

  it('names the attachments ahead of the question, without their contents', () => {
    const attachments: Attachment[] = [
      { type: 'session_ref', sessionId: 's', label: '《英语 | 修改英文表达》', text: '<对话>很长</对话>' },
      { type: 'note_ref', noteId: 'n', sectionTitle: null, label: '《线代》', text: 'Av = λv' },
      { type: 'file', fileId: 'f' }
    ]
    expect(titleQuestion('这里面讲了什么', attachments, () => '讲义.pdf')).toBe(
      '[会话引用：《英语 | 修改英文表达》]\n[笔记引用：《线代》]\n[附件：讲义.pdf]\n这里面讲了什么'
    )
  })

  it('sends a mark quiz with no typed text, in the same project, and titles it by name only', async () => {
    const { chat, db, model, requests, titleRequests } = setup(DONE_EVENTS)
    const project = createProject(db, '线代')
    const quiz: Attachment = {
      type: 'mark_quiz',
      sessionId: 'source',
      label: '《线代入门》',
      marks: [{ quote: '特征值', comment: '为什么？' }]
    }
    const { session, userMessage } = chat.send({
      sessionId: null,
      projectId: project.id,
      newThread: null,
      text: '',
      attachments: [quiz],
      modelId: model.id,
      thinking: 'high',
      webSearch: false
    })
    await chat.idle()
    expect(session).toMatchObject({ projectId: project.id })
    expect(userMessage.attachments).toEqual([quiz])
    expect(requests[0].messages[0].content[0]).toMatchObject({ text: expect.stringContaining('原文：「特征值」') })
    const [part] = titleRequests[0].messages[0].content
    expect(part).toMatchObject({ text: expect.stringContaining('<提问>\n[考考我：《线代入门》]\n</提问>') })
    expect(part).not.toMatchObject({ text: expect.stringContaining('特征值') })
  })

  it('sends the attachment names with the question when titling', async () => {
    const { chat, send, titleRequests } = setup(DONE_EVENTS)
    send('这里面讲了什么', null, [{ type: 'session_ref', sessionId: 's', label: '《英语 | 修改英文表达》', text: '<对话>…</对话>' }])
    await chat.idle()
    const [part] = titleRequests[0].messages[0].content
    expect(part).toMatchObject({ text: expect.stringContaining('<提问>\n[会话引用：《英语 | 修改英文表达》]\n这里面讲了什么\n</提问>') })
  })

  it('continues an existing session with its earlier turns', async () => {
    const { chat, send, requests } = setup([{ type: 'text', delta: '好' }, { type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }])
    const first = send('第一问')
    await chat.idle()
    send('第二问', first.session.id)
    await chat.idle()
    expect(requests[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('records an error with the text that arrived before it', async () => {
    const { db, chat, send } = setup([
      { type: 'text', delta: '写到一半' },
      { type: 'error', kind: 'rate_limit', message: '429 Too Many Requests' }
    ])
    const { assistantMessage } = send('问')
    await chat.idle()
    expect(getMessage(db, assistantMessage.id)).toMatchObject({
      content: '写到一半',
      status: 'error',
      error: '429 Too Many Requests'
    })
  })

  it('stop keeps what arrived and marks the reply stopped', async () => {
    const { db, chat, send } = setup(
      [
        { type: 'text', delta: '第一段' },
        { type: 'text', delta: '第二段' },
        { type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }
      ],
      30
    )
    const { assistantMessage } = send('问')
    await new Promise((r) => setTimeout(r, 45))
    chat.stop(assistantMessage.id)
    await chat.idle()
    expect(getMessage(db, assistantMessage.id)).toMatchObject({ content: '第一段', status: 'stopped' })
  })

  it('writes partial text to the database while streaming', async () => {
    const { db, chat, send } = setup(
      [
        { type: 'text', delta: 'a' },
        ...Array.from({ length: 6 }, () => ({ type: 'text' as const, delta: 'b' })),
        { type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }
      ],
      110
    )
    const { assistantMessage } = send('问')
    await new Promise((r) => setTimeout(r, 700))
    const midway = getMessage(db, assistantMessage.id)
    expect(midway.status).toBe('streaming')
    expect(midway.content.length).toBeGreaterThan(0)
    await chat.idle()
  })

  it('writes nothing when the provider connection cannot be built', () => {
    const db = openDb(':memory:')
    const provider = createProvider(db, { name: 'P', protocol: 'anthropic', baseUrl: 'http://x', apiKeyEnc: null })
    const model = addModel(db, provider.id, {
      modelName: 'm',
      displayName: 'm',
      supportsVision: false,
      supportsThinking: false,
      thinkingCanDisable: true,
      supportsTools: true,
      contextWindow: null,
      maxOutputTokens: null
    })
    const chat = createChat({
      db,
      connection: () => {
        throw new Error('keychain unavailable')
      },
      emit: () => {},
      sessionUpdated: () => {},
      readFile: () => Buffer.alloc(0),
      ensureFile: async () => {},
      webTools: () => null
    })
    expect(() => chat.send({ sessionId: null, projectId: null, newThread: null, text: '问', attachments: [], modelId: model.id, thinking: 'off', webSearch: false })).toThrow(
      'keychain unavailable'
    )
    expect(listSessions(db)).toEqual([])
  })

  it('offers the web tools only when the switch is on and the model takes tools, and saves what it did online', async () => {
    const tools: Tools = { specs: [], run: async function* () { return '' } }
    const sources = [{ n: 1, url: 'https://a.com', title: 'A', date: null, snippet: '片段' }]
    const { db, chat, model, requests } = setup(
      [
        { type: 'step', step: { type: 'search', query: '特征值' } },
        { type: 'sources', sources },
        { type: 'text', delta: '答 [1]' },
        { type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }
      ],
      0,
      () => tools
    )
    const send = (webSearch: boolean) =>
      chat.send({ sessionId: null, projectId: null, newThread: null, text: '问', attachments: [], modelId: model.id, thinking: 'high', webSearch })

    const online = send(true)
    send(false)
    await chat.idle()
    expect(requests[0].tools).toBe(tools)
    expect(requests[1].tools).toBeUndefined()
    expect(getMessage(db, online.assistantMessage.id).web).toEqual({ steps: [{ type: 'search', query: '特征值' }], sources })

    updateModel(db, model.id, { supportsTools: false })
    send(true)
    await chat.idle()
    expect(requests[2].tools).toBeUndefined()
  })

  it('gives a model that takes tools the page map of an attached PDF and the tools to read it, without web search', async () => {
    const { chat, send, requests, files, db, model } = setup(DONE_EVENTS)
    const page = { type: 'page' as const, n: 1, title: '特征值', text: '特征值的定义', tags: [], imageIds: [] }
    const pdf = files.add({ name: 'la.pdf', mime: 'application/pdf', data: new Uint8Array([1]), extracted: [page], isScanned: false })
    const first = send('讲讲', null, [{ type: 'file', fileId: pdf.id }])
    await chat.idle()
    expect(texts(undated(requests[0]))[0][1]).toMatch(/^\[文档：la\.pdf，共 1 页。[\s\S]*第 1 页 · 特征值 · 6 字\n\n讲讲$/)
    expect(requests[0].tools?.specs.map((s) => s.name)).toEqual(['search_document', 'read_document_pages'])
    const read = requests[0].tools!.run({ id: '1', name: 'read_document_pages', input: { file: 'la.pdf', start_page: 1, end_page: 1 } }, new AbortController().signal)
    let next = await read.next()
    while (!next.done) next = await read.next()
    expect(next.value).toContain('特征值的定义')

    // A model without tools gets the document's text itself, in later turns too.
    updateModel(db, model.id, { supportsTools: false })
    send('再讲', first.session.id)
    await chat.idle()
    expect(requests[1].tools).toBeUndefined()
    expect(texts(undated(requests[1]))[0][1]).toBe('[文件：la.pdf]\n\n## 第 1 页\n特征值\n特征值的定义\n\n讲讲')
  })

  it('reads attached files from disk and sends them', async () => {
    const { chat, send, requests, files, db } = setup([{ type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }])
    db.prepare('UPDATE models SET supports_vision = 1').run()
    const image = files.add({ name: 'a.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]), extracted: null, isScanned: null })
    send('这是什么', null, [{ type: 'file', fileId: image.id }])
    await chat.idle()
    expect(undated(requests[0]).messages[0].content[0]).toEqual({ type: 'image', mime: 'image/png', data: Buffer.from([1, 2, 3]) })
  })

  it('refuses an attachment that is not in the database before writing anything', () => {
    const { db, send } = setup([])
    expect(() => send('问', null, [{ type: 'file', fileId: 'missing' }])).toThrow()
    expect(listSessions(db)).toEqual([])
  })

  it('starts a new session inside a project and answers with that project prompt', async () => {
    const { db, chat, model, requests } = setup([{ type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }])
    const project = createProject(db, '线性代数')
    updateProject(db, project.id, { systemPrompt: '你是线性代数助教' })
    const { session } = chat.send({ sessionId: null, projectId: project.id, newThread: null, text: '问', attachments: [], modelId: model.id, thinking: 'off', webSearch: false })
    await chat.idle()
    expect(session.projectId).toBe(project.id)
    expect(requests[0].system).toBe('你是线性代数助教')
  })

  it('starts a fork thread on its first message, with the main conversation up to the anchor and the prefix', async () => {
    const { db, chat, send, requests } = setup([
      { type: 'text', delta: '答' },
      { type: 'done', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }
    ])
    const main = send('什么是 SVD')
    await chat.idle()
    const { session: thread } = send('为什么是正交的', null, [], {
      parentSessionId: main.session.id,
      anchorMessageId: main.assistantMessage.id,
      anchorQuote: '答',
      anchorStart: 0,
      anchorEnd: 1,
      anchorPrefix: '',
      anchorSuffix: '',
      contextMode: 'fork'
    })
    await chat.idle()

    expect(thread).toMatchObject({ kind: 'thread', parentSessionId: main.session.id, contextMode: 'fork', title: '答' })
    expect(texts(undated(requests[1]))).toEqual([
      ['user', '什么是 SVD'],
      ['assistant', '答'],
      ['user', '我在读你上面的回答时，对这段不太理解：「答」\n\n为什么是正交的']
    ])
    // The window loads a conversation in one go: the main session and its threads.
    expect(listConversationMessages(db, main.session.id).map((m) => m.sessionId)).toEqual(
      expect.arrayContaining([main.session.id, thread.id])
    )
    expect(listConversationMessages(db, main.session.id)).toHaveLength(4)

    deleteSession(db, thread.id)
    expect(listConversationMessages(db, main.session.id)).toHaveLength(2)
  })

  it('a new thread ignores files attached in the main session; a fork thread only takes those up to its anchor', async () => {
    const { db, model, files } = setup(DONE_EVENTS)
    const beforeAnchor = files.add({ name: 'before.txt', mime: 'text/plain', data: Buffer.from('before'), extracted: null, isScanned: null })
    const afterAnchor = files.add({ name: 'after.txt', mime: 'text/plain', data: Buffer.from('after'), extracted: null, isScanned: null })

    const ensured: string[] = []
    const read: string[] = []
    const chat = createChat({
      db,
      connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
      emit: () => {},
      sessionUpdated: () => {},
      readFile: (f) => {
        read.push(f.id)
        return files.read(f)
      },
      ensureFile: async (f) => {
        ensured.push(f.id)
      },
      webTools: () => null,
      stream: fakeStream(DONE_EVENTS).stream
    })
    const sendInput = (
      text: string,
      sessionId: string | null = null,
      attachments: Attachment[] = [],
      newThread: ThreadAnchor | null = null
    ) => ({
      sessionId,
      projectId: null,
      newThread,
      text,
      attachments,
      modelId: model.id,
      thinking: 'high' as const,
      webSearch: false
    })

    const round1 = chat.send(sendInput('第一问', null, [{ type: 'file', fileId: beforeAnchor.id }]))
    await chat.idle()
    chat.send(sendInput('第二问', round1.session.id, [{ type: 'file', fileId: afterAnchor.id }]))
    await chat.idle()

    // New thread: neither fetches nor reads any file from the main session (initial send, follow-up, regenerate).
    ensured.length = 0
    read.length = 0
    const newThreadInput = sendInput('独立追问', null, [], {
      ...ANCHOR,
      parentSessionId: round1.session.id,
      anchorMessageId: round1.assistantMessage.id,
      contextMode: 'new'
    })
    await chat.fetchFiles(newThreadInput)
    const newThread = chat.send(newThreadInput)
    await chat.idle()
    expect(ensured).toEqual([])
    expect(read).toEqual([])

    const followUpInput = sendInput('继续追问', newThread.session.id)
    await chat.fetchFiles(followUpInput)
    const followUp = chat.send(followUpInput)
    await chat.idle()
    expect(ensured).toEqual([])
    expect(read).toEqual([])

    const regenInput = { replyId: followUp.assistantMessage.id, text: null, modelId: model.id, thinking: 'high' as const, webSearch: false }
    await chat.fetchFiles(regenInput)
    chat.regenerate(regenInput)
    await chat.idle()
    expect(ensured).toEqual([])
    expect(read).toEqual([])

    // Fork thread anchored on round 1: fetches and reads beforeAnchor, but not afterAnchor from round 2.
    const forkInput = sendInput('带上下文追问', null, [], {
      ...ANCHOR,
      parentSessionId: round1.session.id,
      anchorMessageId: round1.assistantMessage.id,
      contextMode: 'fork'
    })
    await chat.fetchFiles(forkInput)
    chat.send(forkInput)
    await chat.idle()
    expect(ensured).toEqual([beforeAnchor.id])
    expect(read).toEqual([beforeAnchor.id])
  })

  it('regenerate replaces the last reply; marks and threads on it go with it', async () => {
    const { db, chat, send, regenerate, requests } = setup(DONE_EVENTS)
    const first = send('第一问')
    await chat.idle()
    const { userMessage, assistantMessage } = send('第二问', first.session.id)
    await chat.idle()
    createMark(db, { messageId: assistantMessage.id, quote: '答', startOffset: 0, endOffset: 1, prefix: '', suffix: '', comment: null, categoryId: null })
    const thread = send('追问', null, [], { ...ANCHOR, parentSessionId: first.session.id, anchorMessageId: assistantMessage.id })
    await chat.idle()

    const result = regenerate(assistantMessage.id)
    await chat.idle()

    expect(result.removedIds).toEqual([assistantMessage.id])
    expect(result.userMessage.id).toBe(userMessage.id)
    expect(listMessages(db, first.session.id).map((m) => [m.id, m.status])).toEqual([
      [first.userMessage.id, 'done'],
      [first.assistantMessage.id, 'done'],
      [userMessage.id, 'done'],
      [result.assistantMessage.id, 'done']
    ])
    expect(listMarks(db, first.session.id)).toEqual([])
    expect(listSessions(db).some((s) => s.id === thread.session.id)).toBe(false)
    expect(texts(undated(requests.at(-1)!))).toEqual(texts(undated(requests[1])))
  })

  it('edit replaces the last question, keeping its attachments, and the old text leaves the search index', async () => {
    const { db, chat, send, regenerate, files } = setup(DONE_EVENTS)
    const record = files.add({ name: 'a.txt', mime: 'text/plain', data: Buffer.from('x'), extracted: null, isScanned: null })
    const first = send('第一问')
    await chat.idle()
    const { userMessage, assistantMessage } = send('写错了的提问', first.session.id, [{ type: 'file', fileId: record.id }])
    await chat.idle()

    const result = regenerate(assistantMessage.id, '改过的提问')
    await chat.idle()

    expect(result.removedIds).toEqual([userMessage.id, assistantMessage.id])
    expect(result.userMessage).toMatchObject({ content: '改过的提问', attachments: [{ type: 'file', fileId: record.id }] })
    expect(listMessages(db, first.session.id).map((m) => m.content)).toEqual(['第一问', '答', '改过的提问', '答'])
    expect(search(db, '写错了').messages).toEqual([])
    expect(search(db, '改过的').messages).toHaveLength(1)
  })

  it('refuses anything but the last reply of a session, before writing', async () => {
    const { db, chat, send, regenerate } = setup(DONE_EVENTS)
    const first = send('第一问')
    await chat.idle()
    send('第二问', first.session.id)
    await chat.idle()
    const before = listMessages(db, first.session.id)

    expect(() => regenerate(first.assistantMessage.id)).toThrow()
    expect(() => regenerate(first.userMessage.id)).toThrow()
    expect(listMessages(db, first.session.id)).toEqual(before)
  })

  it('retrying a failed first round keeps the error kind until then, and titles the session', async () => {
    const failed = setup([{ type: 'error', kind: 'auth', message: '401 invalid key' }])
    const { session, assistantMessage } = failed.send('什么是特征值')
    await failed.chat.idle()
    expect(getMessage(failed.db, assistantMessage.id)).toMatchObject({ status: 'error', errorKind: 'auth' })

    const fixed = fakeStream(DONE_EVENTS)
    const updated: Session[] = []
    const chat = createChat({
      db: failed.db,
      connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
      emit: () => {},
      sessionUpdated: (s) => updated.push(s),
      readFile: failed.files.read,
      ensureFile: async () => {},
      webTools: () => null,
      stream: fixed.stream
    })
    const retried = chat.regenerate({ replyId: assistantMessage.id, text: null, modelId: failed.model.id, thinking: 'high', webSearch: false })
    await chat.idle()
    expect(getMessage(failed.db, retried.assistantMessage.id)).toMatchObject({ status: 'done', error: null, errorKind: null })
    expect(updated.map((s) => s.title)).toEqual(['数学 | 理解特征值'])
    expect(getSession(failed.db, session.id).title).toBe('数学 | 理解特征值')
  })

  it('marks replies left streaming by a previous run as stopped', () => {
    const { db, send } = setup([], 10_000)
    const { session } = send('问')
    createChat({
      db,
      connection: () => ({ protocol: 'anthropic', baseUrl: '', apiKey: '' }),
      emit: () => {},
      sessionUpdated: () => {},
      readFile: () => Buffer.alloc(0),
      ensureFile: async () => {},
      webTools: () => null
    })
    expect(listMessages(db, session.id).map((m) => m.status)).toEqual(['done', 'stopped'])
  })
})

describe('threadTitle', () => {
  it('uses the passage, cut to 30 characters', () => {
    expect(threadTitle('  特征值\n分解  ')).toBe('特征值 分解')
    expect(threadTitle('一'.repeat(31))).toBe(`${'一'.repeat(30)}…`)
    expect(threadTitle('一'.repeat(30))).toBe('一'.repeat(30))
  })
})
