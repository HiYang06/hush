import { mkdtempSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { PPTX_MIME } from '@shared/files'
import type { Attachment, CompactState, FileRecord, Message, Session, StreamEvent, ThreadAnchor, ThreadSession } from '@shared/types'
import { openDb } from '../src/main/db'
import { createMark, listMarks } from '../src/main/db/repo/marks'
import { appendMessage, getMessage, listConversationMessages, listMessages, saveReply } from '../src/main/db/repo/messages'
import { search } from '../src/main/db/repo/search'
import { createProject, updateProject } from '../src/main/db/repo/projects'
import { addModel, createProvider, deleteModel, updateModel } from '../src/main/db/repo/providers'
import { createMainSession, deleteSession, getSession, listSessions, renameSession } from '../src/main/db/repo/sessions'
import { createFileStore } from '../src/main/files/store'
import { createChat, threadTitle } from '../src/main/llm/chat'
import { COMPACT_PROMPT, estimateRequest, SUMMARY_MAX_OUTPUT } from '../src/main/llm/compact'
import { cleanTitle, TITLE_PROMPT, titleQuestion } from '../src/main/llm/title'
import { buildContext, MAX_LISTED_SESSIONS, pickSystemPrompt, projectSessionList, type LoadedFile } from '../src/main/llm/context'
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
    outputTokens: null, contextTokens: null,
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
  updatedAt: 0, compactSummary: null, compactThroughId: null, compactedAt: null
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
    parentSession: null,
    projectPrompt: null,
    projectSessions: [],
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

  it('appends the project list after the selected prompt, including when there is no prompt', () => {
    const projectSessions = [{ n: 1, id: 'other', title: '特征值', createdAt: new Date(2026, 10, 3, 23, 30).getTime() }]
    const input = { ...base, session: MAIN, messages: [], projectSessions }
    const list = projectSessionList(projectSessions)
    expect(list).toContain('1. 特征值（2026-11-03）')
    expect(build(input).system).toBe(list)
    expect(build({ ...input, globalPrompt: '全局' }).system).toBe(`全局\n\n${list}`)
    expect(build({ ...input, globalPrompt: '全局', projectPrompt: '项目' }).system).toBe(`项目\n\n${list}`)
    expect(build({ ...input, projectSessions: [], projectPrompt: '项目' }).system).toBe('项目')
    expect(projectSessionList([])).toBe('')
  })

  it('lists the most recent 50 sessions without renumbering them or mutating the input', () => {
    const sessions = Array.from({ length: MAX_LISTED_SESSIONS + 2 }, (_, i) => ({
      n: i + 1, id: `s${i + 1}`, title: `会话${i + 1}`, createdAt: new Date(2026, 10, 3).getTime()
    })).reverse()
    const before = [...sessions]
    const list = projectSessionList(sessions)
    expect(list).toContain('（更早的 2 个会话没有列出，可以检索到）')
    expect(list).not.toMatch(/^1\.|^2\./m)
    expect(list.split('\n').slice(2).map((line) => Number(line.split('.')[0]))).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 3)
    )
    expect(sessions).toEqual(before)
    expect(projectSessionList(sessions.slice(2))).not.toContain('没有列出')
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
      parentSession: MAIN,
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
      parentSession: MAIN,
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
    data: () => Buffer.from(id)
  }
}

function filesOf(...list: LoadedFile[]): Map<string, LoadedFile> {
  return new Map(list.map((f) => [f.record.id, f]))
}

function withFiles(...ids: string[]): Partial<Message> {
  return { attachments: ids.map((fileId) => ({ type: 'file', fileId })) }
}

describe('buildContext with compaction', () => {
  const base = {
    parentMessages: [],
    parentSession: null,
    projectPrompt: null,
    projectSessions: [],
    globalPrompt: '',
    model: MODEL,
    thinking: 'medium' as const,
    files: new Map<string, LoadedFile>()
  }
  const compacted = (session: Session, throughId: string, summary = '摘要'): Session => ({
    ...session,
    compactSummary: summary,
    compactThroughId: throughId,
    compactedAt: 1
  })
  // The first kept question carries its date after the summary; these tests compare the rest.
  const dateless = (req: ReturnType<typeof buildContext>): [string, string][] =>
    texts(req).map(([role, t]) => [role, t.replace(/\[\d{4}-\d{2}-\d{2} 周.\]\n\n/g, '')])
  const four = [msg(1, 'user', '一'), msg(2, 'assistant', '二'), msg(3, 'user', '三'), msg(4, 'assistant', '四')]

  it('sends the summary in place of the messages up to the boundary, then the rest as they are', () => {
    const req = build({ ...base, session: compacted(MAIN, 'm2'), messages: [...four, msg(5, 'user', '五')] })
    expect(dateless(req)).toEqual([
      ['user', '[前面对话的摘要]\n摘要\n\n三'],
      ['assistant', '四'],
      ['user', '五']
    ])
  })

  it('dates the first kept question, since the dated one may have been compacted', () => {
    const req = buildContext({ ...base, session: compacted(MAIN, 'm2'), messages: four })
    expect(texts(req)[0][1]).toMatch(/^\[前面对话的摘要\]\n摘要\n\n\[\d{4}-\d{2}-\d{2} 周.\]\n\n三$/)
  })

  it('keeps the files the compacted messages attached: a PDF as its page map, others as they were sent', () => {
    const page = { type: 'page' as const, n: 1, title: '特征值', text: '特征值的定义', tags: [], imageIds: [] }
    const files = filesOf(
      file('pdf', 'la.pdf', 'application/pdf', { isScanned: false, extracted: [page] }),
      file('txt', 'a.txt', 'text/plain', { extracted: [{ type: 'text', text: '文本内容' }] })
    )
    const messages = [
      msg(1, 'user', '一', withFiles('pdf', 'txt')),
      msg(2, 'assistant', '二'),
      msg(3, 'user', '再看', withFiles('pdf')),
      msg(4, 'assistant', '好'),
      msg(5, 'user', '三')
    ]
    const req = build({ ...base, model: { ...MODEL, supportsTools: true }, files, session: compacted(MAIN, 'm4'), messages })
    const first = dateless(req)[0][1]
    expect(first).toMatch(/^\[前面对话的摘要\]\n摘要\n\n\[前面对话里附过的文件\]\n\n\[文档：la\.pdf，共 1 页。/)
    expect(first).toContain('[文件：a.txt]\n文本内容')
    expect(first).not.toContain('特征值的定义')
    expect(first.match(/\[文档：la\.pdf/g)).toHaveLength(1)
    expect(first.endsWith('\n\n三')).toBe(true)
    expect(first).not.toContain('再看')
  })

  it('sends the whole conversation when the boundary message is gone', () => {
    const req = build({ ...base, session: compacted(MAIN, 'gone'), messages: four })
    expect(dateless(req).map(([, t]) => t)).toEqual(['一', '二', '三', '四'])
  })

  it('builds up to `through` only, for a compaction request', () => {
    const req = build({ ...base, session: compacted(MAIN, 'm2'), messages: [...four, msg(5, 'user', '五')], through: 'm4' })
    expect(dateless(req)).toEqual([
      ['user', '[前面对话的摘要]\n摘要\n\n三'],
      ['assistant', '四']
    ])
  })

  it('fork thread: starts from the main session\'s summary when its boundary is at or before the anchor', () => {
    const parent = [...four, msg(5, 'user', '五'), msg(6, 'assistant', '六')]
    const fork = { ...(thread('fork') as ThreadSession), anchorMessageId: 'm4' }
    const own = [msg(1, 'user', '为什么？', { id: 't1' })]
    const at = (throughId: string): [string, string][] =>
      dateless(build({ ...base, session: fork, parentMessages: parent, parentSession: compacted(MAIN, throughId), messages: own }))
    expect(at('m2')).toEqual([
      ['user', '[前面对话的摘要]\n摘要\n\n三'],
      ['assistant', '四'],
      ['user', '我在读你上面的回答时，对这段不太理解：「特征值」\n\n为什么？']
    ])
    expect(at('m4')[0]).toEqual(['user', '[前面对话的摘要]\n摘要\n\n我在读你上面的回答时，对这段不太理解：「特征值」\n\n为什么？'])
    // A boundary after the anchor summarizes replies the thread never saw.
    expect(at('m6').map(([, t]) => t).slice(0, 4)).toEqual(['一', '二', '三', '四'])
  })

  it('fork thread: its own compaction wins over the main session\'s', () => {
    const fork = compacted({ ...(thread('fork') as ThreadSession), anchorMessageId: 'm4' }, 't2', '追问的摘要')
    const req = build({
      ...base,
      session: fork,
      parentMessages: four,
      parentSession: compacted(MAIN, 'm2'),
      messages: [msg(1, 'user', '问', { id: 't1' }), msg(2, 'assistant', '答', { id: 't2' }), msg(3, 'user', '再问', { id: 't3' })]
    })
    expect(dateless(req)).toEqual([['user', '[前面对话的摘要]\n追问的摘要\n\n再问']])
  })
})

describe('buildContext with files', () => {
  const base = {
    session: MAIN,
    parentMessages: [],
    parentSession: null,
    projectPrompt: null,
    projectSessions: [],
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
  { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }
]

const DONE_EVENTS: StreamEvent[] = [
  { type: 'text', delta: '答' },
  { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }
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
    compactState: () => {},
    connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
    emit: (id, e) => emitted.push([id, e]),
    sessionUpdated: (session) => updated.push(session),
    readFile: (file) => files.read(file),
    checkFile: files.check,
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
      { type: 'done', usage: { input: 10, output: 20, context: 10 }, stopReason: 'end_turn' }
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
      outputTokens: 20, contextTokens: 10
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
      compactState: () => {},
      connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
      emit: () => {},
      sessionUpdated: () => {},
      checkFile: () => {},
      readFile: () => Buffer.alloc(0),
      ensureFile: async () => {},
      webTools: () => null,
      stream: async function* (_conn, req) {
        if (req.system === TITLE_PROMPT) return yield* TITLE_REPLY
        yield { type: 'text', delta: '答' }
        yield { type: 'text', delta: '案' }
        halfway()
        await finished
        yield { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }
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
    const done: StreamEvent[] = [{ type: 'text', delta: '答' }, { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }]
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
      [{ type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }],
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
    const { chat, send, requests } = setup([{ type: 'text', delta: '好' }, { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }])
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
        { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }
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
        { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }
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
      compactState: () => {},
      connection: () => {
        throw new Error('keychain unavailable')
      },
      emit: () => {},
      sessionUpdated: () => {},
      checkFile: () => {},
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
        { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }
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

  it('a PDF attached in the compacted part can still be read through the tools', async () => {
    const { chat, send, requests, files } = setup(DONE_EVENTS)
    const page = { type: 'page' as const, n: 1, title: '特征值', text: '特征值的定义', tags: [], imageIds: [] }
    const pdf = files.add({ name: 'la.pdf', mime: 'application/pdf', data: new Uint8Array([1]), extracted: [page], isScanned: false })
    const { session } = send('讲讲', null, [{ type: 'file', fileId: pdf.id }])
    await chat.idle()
    // Two rounds of about 12k tokens each: only the newest stays word for word, so the PDF's round is compacted.
    send('b'.repeat(48_000), session.id)
    await chat.idle()
    send('c'.repeat(48_000), session.id)
    await chat.idle()
    expect(await chat.compact(session.id)).toMatchObject({ ok: true })

    send('第 1 页讲了什么', session.id)
    await chat.idle()
    const last = requests.at(-1)!
    const sent = JSON.stringify(last.messages)
    expect(sent).toContain('[前面对话的摘要]')
    expect(sent).not.toContain('讲讲')
    expect(sent).toContain('la.pdf')
    expect(last.tools?.specs.map((s) => s.name)).toEqual(['search_document', 'read_document_pages'])
    const read = last.tools!.run({ id: '1', name: 'read_document_pages', input: { file: 'la.pdf', start_page: 1, end_page: 1 } }, new AbortController().signal)
    let next = await read.next()
    while (!next.done) next = await read.next()
    expect(next.value).toContain('特征值的定义')
  })

  it('reads only requested document pages and caches their bytes within one reply', async () => {
    const { chat, send, requests, files, db, model } = setup(DONE_EVENTS)
    updateModel(db, model.id, { supportsVision: true })
    const pages = [1, 2, 3].map((n) => {
      const image = files.add({ name: `${n}.jpg`, mime: 'image/jpeg', data: Buffer.from(`page${n}`), extracted: null, isScanned: null })
      return { type: 'page' as const, n, title: '', text: `内容${n}`, tags: ['figure' as const], imageIds: [image.id] }
    })
    const pdf = files.add({ name: 'pages.pdf', mime: 'application/pdf', data: Buffer.from('pdf'), extracted: pages, isScanned: false })
    const read = vi.spyOn(files, 'read')
    send('讲讲', null, [{ type: 'file', fileId: pdf.id }])
    await chat.idle()
    expect(read).not.toHaveBeenCalled()
    const tools = requests[0].tools!
    const signal = new AbortController().signal
    for (let i = 0; i < 2; i++) {
      const run = tools.run({ id: String(i), name: 'read_document_pages', input: { file: pdf.name, start_page: 2, end_page: 2 } }, signal)
      let next = await run.next()
      while (!next.done) next = await run.next()
      expect(next.value).toMatchObject({ images: [{ data: Buffer.from('page2') }] })
    }
    expect(read.mock.calls.map(([f]) => f.id)).toEqual([pages[1].imageIds[0]])
  })

  it('rejects a missing derived page before sending or replacing a reply', async () => {
    const { chat, send, regenerate, files, db } = setup(DONE_EVENTS)
    const image = files.add({ name: 'page.jpg', mime: 'image/jpeg', data: Buffer.from('page'), extracted: null, isScanned: null })
    const pdf = files.add({ name: 'pages.pdf', mime: 'application/pdf', data: Buffer.from('pdf'), extracted: [
      { type: 'page', n: 1, title: '', text: '内容', tags: [], imageIds: [image.id] }
    ], isScanned: false })
    const first = send('讲讲', null, [{ type: 'file', fileId: pdf.id }])
    await chat.idle()
    const before = listMessages(db, first.session.id)
    renameSync(files.pathOf(image), `${files.pathOf(image)}.missing`)
    expect(() => regenerate(first.assistantMessage.id)).toThrow()
    expect(() => send('继续', first.session.id)).toThrow()
    expect(listMessages(db, first.session.id)).toEqual(before)
    expect(() => send('新对话', null, [{ type: 'file', fileId: pdf.id }])).toThrow()
    expect(listSessions(db)).toHaveLength(1)
  })

  it('reads attached files from disk and sends them', async () => {
    const { chat, send, requests, files, db } = setup([{ type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }])
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
    const { db, chat, model, requests } = setup([{ type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }])
    const project = createProject(db, '线性代数')
    updateProject(db, project.id, { systemPrompt: '你是线性代数助教' })
    const { session } = chat.send({ sessionId: null, projectId: project.id, newThread: null, text: '问', attachments: [], modelId: model.id, thinking: 'off', webSearch: false })
    await chat.idle()
    expect(session.projectId).toBe(project.id)
    expect(requests[0].system).toBe('你是线性代数助教')
  })

  it.each([
    { scenario: 'enabled without web search', inProject: true, enabled: true, supportsTools: true, other: 'same', webSearch: false, active: true },
    { scenario: 'enabled with web search', inProject: true, enabled: true, supportsTools: true, other: 'same', webSearch: true, active: true },
    { scenario: 'disabled for the project', inProject: true, enabled: false, supportsTools: true, other: 'same', webSearch: false, active: false },
    { scenario: 'standalone session', inProject: false, enabled: true, supportsTools: true, other: 'same', webSearch: false, active: false },
    { scenario: 'no other sessions', inProject: true, enabled: true, supportsTools: true, other: 'none', webSearch: false, active: false },
    { scenario: 'only an empty session', inProject: true, enabled: true, supportsTools: true, other: 'empty', webSearch: false, active: false },
    { scenario: 'only another project has history', inProject: true, enabled: true, supportsTools: true, other: 'different', webSearch: false, active: false },
    { scenario: 'model without tools', inProject: true, enabled: true, supportsTools: false, other: 'same', webSearch: true, active: false }
  ])('offers the project list and tools together: $scenario', async ({ inProject, enabled, supportsTools, other, webSearch, active }) => {
    const { db, chat, model, requests } = setup(DONE_EVENTS)
    const project = createProject(db, '线代')
    updateProject(db, project.id, { memoryEnabled: enabled, systemPrompt: '助教' })
    updateModel(db, model.id, { supportsTools })
    if (other !== 'none') {
      const previous = createMainSession(db, {
        title: '特征值分解', projectId: other === 'different' ? createProject(db, '其他').id : project.id,
        providerId: model.providerId, modelId: model.id
      })
      if (other !== 'empty') appendMessage(db, previous.id, { role: 'user', content: '矩阵如何分解', attachments: [] })
    }
    chat.send({ sessionId: null, projectId: inProject ? project.id : null, newThread: null, text: '继续', attachments: [], modelId: model.id, thinking: 'off', webSearch })
    await chat.idle()
    expect(requests[0].system.includes('[项目会话]')).toBe(active)
    if (active) {
      expect(requests[0].system).toContain('助教\n\n[项目会话]')
      expect(requests[0].system).toContain('1. 特征值分解（')
      expect(requests[0].tools?.specs.map((s) => s.name)).toEqual(['search_project_sessions', 'read_session'])
    } else {
      expect(requests[0].system).toBe(inProject ? '助教' : '')
      expect(requests[0].tools).toBeUndefined()
    }
  })

  it.each(['fork', 'new'] as const)('inherits project memory in a %s thread and excludes its parent main session', async (contextMode) => {
    const { db, chat, model, send, requests, regenerate } = setup(DONE_EVENTS)
    const project = createProject(db, '线代')
    const main = chat.send({ sessionId: null, projectId: project.id, newThread: null, text: '当前问题', attachments: [], modelId: model.id, thinking: 'off', webSearch: false })
    await chat.idle()
    renameSession(db, main.session.id, '当前主对话')
    const previous = createMainSession(db, { title: '历史主对话', projectId: project.id, providerId: model.providerId, modelId: model.id })
    appendMessage(db, previous.id, { role: 'user', content: '历史问题', attachments: [] })
    const thread = send('追问', null, [], { ...ANCHOR, parentSessionId: main.session.id, anchorMessageId: main.assistantMessage.id, contextMode })
    await chat.idle()
    expect(requests[1].system).toContain('1. 历史主对话（')
    expect(requests[1].system).not.toContain('当前主对话')
    expect(requests[1].tools?.specs.map((s) => s.name)).toContain('read_session')
    updateProject(db, project.id, { memoryEnabled: false })
    regenerate(thread.assistantMessage.id)
    await chat.idle()
    expect(requests[2].system).not.toContain('[项目会话]')
    expect(requests[2].tools).toBeUndefined()
  })

  it('lets an adapter search and read another session alongside document and web tools, keeping results out of stored history', async () => {
    const { db, model, files } = setup(DONE_EVENTS)
    const project = createProject(db, '线代')
    const previous = createMainSession(db, { title: '特征值分解', projectId: project.id, providerId: model.providerId, modelId: model.id })
    const attachment = files.add({ name: '历史讲义.txt', mime: 'text/plain', data: Buffer.from('不应读取附件正文'), extracted: null, isScanned: null })
    appendMessage(db, previous.id, { role: 'user', content: '什么是特征值', attachments: [{ type: 'file', fileId: attachment.id }] })
    const answer = appendMessage(db, previous.id, { role: 'assistant', providerId: model.providerId, modelId: model.id })
    saveReply(db, answer.id, {
      content: '特征值满足 Av = λv', thinking: null, thinkingMs: null, status: 'done', error: null,
      errorKind: null, inputTokens: null, outputTokens: null, contextTokens: null, web: null
    })
    const pdf = files.add({ name: '当前讲义.pdf', mime: 'application/pdf', data: Buffer.from('pdf'), extracted: [
      { type: 'page', n: 1, title: '复习', text: '矩阵', tags: [], imageIds: [] }
    ], isScanned: false })
    const results: string[] = []
    const readFile = vi.fn(files.read)
    const chat = createChat({
      db,
      compactState: () => {},
      connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
      emit: () => {}, sessionUpdated: () => {}, checkFile: files.check, readFile,
      ensureFile: async () => {},
      webTools: () => ({ specs: [{ name: 'search_web', description: '', parameters: { type: 'object', properties: {}, required: [] } }], run: async function* () { return '网页' } }),
      stream: async function* (_conn, req) {
        if (req.system === TITLE_PROMPT) { yield* TITLE_REPLY; return }
        expect(req.tools?.specs.map((s) => s.name)).toEqual([
          'search_document', 'read_document_pages', 'search_project_sessions', 'read_session', 'search_web'
        ])
        expect(JSON.stringify(req.messages)).not.toContain('Av = λv')
        for (const call of [
          { id: 'search', name: 'search_project_sessions', input: { query: '特征值' } },
          { id: 'read', name: 'read_session', input: { session: 1, start_round: 1, end_round: 1 } }
        ]) {
          const result = yield* req.tools!.run(call, req.signal)
          expect(typeof result).toBe('string')
          results.push(result as string)
        }
        yield { type: 'text', delta: '记得了' }
        yield { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }
      }
    })
    const sent = chat.send({ sessionId: null, projectId: project.id, newThread: null, text: '之前聊过什么', attachments: [{ type: 'file', fileId: pdf.id }], modelId: model.id, thinking: 'off', webSearch: true })
    await chat.idle()
    expect(results).toHaveLength(2)
    expect(results[0]).toContain('特征值')
    expect(results[1]).toContain('Av = λv')
    expect(results[1]).toContain('历史讲义.txt')
    expect(results[1]).not.toContain('不应读取附件正文')
    expect(readFile).not.toHaveBeenCalled()
    expect(listMessages(db, sent.session.id).map((m) => m.content)).toEqual(['之前聊过什么', '记得了'])
    expect(getMessage(db, sent.assistantMessage.id).web?.steps).toEqual([
      { type: 'session_search', query: '特征值' },
      { type: 'session_read', title: '特征值分解', start: 1, end: 1 }
    ])
  })

  it('starts a fork thread on its first message, with the main conversation up to the anchor and the prefix', async () => {
    const { db, chat, send, requests } = setup([
      { type: 'text', delta: '答' },
      { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }
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

    const checked: string[] = []
    const ensured: string[] = []
    const read: string[] = []
    const chat = createChat({
      db,
      compactState: () => {},
      connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
      emit: () => {},
      sessionUpdated: () => {},
      checkFile: (f) => {
        checked.push(f.id)
        files.check(f)
      },
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
    checked.length = 0
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

    // Fork thread checks only the inherited attachment; extracted text needs no bytes.
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
    expect(checked).toEqual([beforeAnchor.id])
    expect(read).toEqual([])
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
      compactState: () => {},
      connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
      emit: () => {},
      sessionUpdated: (s) => updated.push(s),
      checkFile: failed.files.check,
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
      compactState: () => {},
      connection: () => ({ protocol: 'anthropic', baseUrl: '', apiKey: '' }),
      emit: () => {},
      sessionUpdated: () => {},
      checkFile: () => {},
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

describe('compact', () => {
  const COMPACT = (req: ChatRequest): boolean => {
    const last = req.messages.at(-1)?.content.at(-1)
    return last?.type === 'text' && last.text === COMPACT_PROMPT
  }
  // n characters of Latin text estimate to n / 4 tokens.
  const sized = (tokens: number): string => 'a'.repeat(tokens * 4)
  const firstText = (req: ChatRequest): string => req.messages[0].content.map((p) => (p.type === 'text' ? p.text : '')).join('')

  // reply: the context the provider reports for a normal reply. summaries: what each compaction answers, in turn;
  // a compaction waits while `hold` is set.
  function setup(contextWindow: number | null, reply = { context: 1, text: '答' }) {
    const db = openDb(':memory:')
    const provider = createProvider(db, { name: 'P', protocol: 'anthropic', baseUrl: 'http://x', apiKeyEnc: null })
    const model = addModel(db, provider.id, {
      modelName: 'm', displayName: 'M', supportsVision: false, supportsThinking: false, thinkingCanDisable: true,
      supportsTools: false, contextWindow, maxOutputTokens: 8000
    })
    const session = createMainSession(db, { title: '会话', projectId: null, providerId: provider.id, modelId: model.id })
    const requests: ChatRequest[] = []
    const compactions: ChatRequest[] = []
    const states: (CompactState | null)[] = []
    // replyHold: a normal reply waits for it before it ends. replyError: a normal reply fails as too long.
    // stopReason: what a compaction ends with.
    const control = {
      hold: null as Promise<void> | null, fail: false, reply, replyHold: null as Promise<void> | null,
      replyError: false, stopReason: 'end_turn'
    }
    const chat = createChat({
      db,
      compactState: (_id, state) => states.push(state),
      connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
      emit: () => {}, sessionUpdated: () => {}, checkFile: () => {}, readFile: () => Buffer.alloc(0),
      ensureFile: async () => {}, webTools: () => null,
      stream: async function* (_conn, req) {
        if (COMPACT(req)) {
          compactions.push(req)
          if (control.hold) await control.hold
          if (control.fail) {
            yield { type: 'error', kind: 'other', message: '服务商出错' }
            return
          }
          yield { type: 'text', delta: `摘要${compactions.length}` }
          yield { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: control.stopReason }
          return
        }
        requests.push(req)
        if (control.replyError) {
          yield { type: 'error', kind: 'context_length', message: 'prompt is too long' }
          return
        }
        yield { type: 'text', delta: control.reply.text }
        if (control.replyHold) await control.replyHold
        yield { type: 'done', usage: { input: 1, output: 1, context: control.reply.context }, stopReason: 'end_turn' }
      }
    })
    // Rounds already in the session, written directly: question and answer of the given estimated sizes.
    const seed = (...rounds: [number, number][]): void => {
      for (const [q, a] of rounds) {
        appendMessage(db, session.id, { role: 'user', content: sized(q), attachments: [] })
        const reply = appendMessage(db, session.id, { role: 'assistant', providerId: provider.id, modelId: model.id })
        saveReply(db, reply.id, {
          content: sized(a), thinking: null, thinkingMs: null, status: 'done', error: null, errorKind: null,
          inputTokens: null, outputTokens: null, contextTokens: null, web: null
        })
      }
    }
    const send = async (text: string, attachments: Attachment[] = []): Promise<void> => {
      chat.send({ sessionId: session.id, projectId: null, newThread: null, text, attachments, modelId: model.id, thinking: 'off', webSearch: false })
      await new Promise((r) => setTimeout(r, 0))
    }
    const files = createFileStore(db, mkdtempSync(join(tmpdir(), 'hush-')), noDownload)
    return { db, chat, session, model, requests, compactions, states, control, seed, send, files }
  }

  it('runs in the background: rounds sent meanwhile follow the summary once it lands', async () => {
    const { chat, session, requests, compactions, control, seed, send } = setup(100_000)
    seed([15_000, 15_000], [15_000, 15_000], [100, 100])
    let release!: () => void
    control.hold = new Promise((r) => (release = r))
    const job = chat.compact(session.id)
    await send('压缩时问的第一个')
    await send('压缩时问的第二个')
    expect(compactions).toHaveLength(1)
    release()
    expect(await job).toMatchObject({ ok: true })
    await chat.idle()

    await send('压缩之后')
    await chat.idle()
    const after = requests.at(-1)!
    expect(firstText(after).startsWith('[前面对话的摘要]\n摘要1')).toBe(true)
    const all = JSON.stringify(after.messages)
    expect(all).toContain('压缩时问的第一个')
    expect(all).toContain('压缩时问的第二个')
    expect(all).toContain('压缩之后')
    // The kept round (100 + 100 tokens) is still there, word for word.
    expect(all).toContain(sized(100))
    expect(all).not.toContain(sized(15_000))
  })

  it('starts by itself when a reply ends at 85% or more, once at a time', async () => {
    const { chat, compactions, control, seed, send } = setup(100_000, { context: 90_000, text: '答' })
    seed([15_000, 15_000], [15_000, 15_000], [100, 100])
    let release!: () => void
    control.hold = new Promise((r) => (release = r))
    await send('问')
    await new Promise((r) => setTimeout(r, 10))
    expect(compactions).toHaveLength(1)
    await send('再问')
    await new Promise((r) => setTimeout(r, 10))
    expect(compactions).toHaveLength(1)
    release()
    await chat.idle()
    expect(compactions).toHaveLength(1)
  })

  it('does not start below 85%, when compacting would free under 10% of the window, or with no window', async () => {
    const below = setup(100_000, { context: 80_000, text: '答' })
    below.seed([15_000, 15_000], [15_000, 15_000], [100, 100])
    await below.send('问')
    await below.chat.idle()
    expect(below.compactions).toHaveLength(0)

    // The context is mostly something compacting keeps (attachments): the old text is only 5% of the window.
    const attachments = setup(100_000, { context: 95_000, text: '答' })
    attachments.seed([2500, 2500], [100, 100])
    await attachments.send('问')
    await attachments.chat.idle()
    expect(attachments.compactions).toHaveLength(0)

    const unknown = setup(null, { context: 95_000, text: '答' })
    unknown.seed([15_000, 15_000], [15_000, 15_000], [100, 100])
    await unknown.send('问')
    await unknown.chat.idle()
    expect(unknown.compactions).toHaveLength(0)
  })

  it('compacting again hands the model the previous summary to fold in', async () => {
    const { chat, session, compactions, seed } = setup(1_000_000)
    seed([15_000, 15_000], [100, 100])
    expect(await chat.compact(session.id)).toMatchObject({ ok: true })
    seed([15_000, 15_000], [100, 100])
    expect(await chat.compact(session.id)).toMatchObject({ ok: true })
    expect(compactions).toHaveLength(2)
    expect(firstText(compactions[1]).startsWith('[前面对话的摘要]\n摘要1')).toBe(true)
    // Only the second batch's question and answer; the first is in the summary.
    expect(JSON.stringify(compactions[1].messages).split(sized(15_000)).length - 1).toBe(2)
  })

  it('summarizes in several requests when one cannot hold everything, each within the window', async () => {
    const window = 50_000
    const { chat, session, compactions, seed } = setup(window)
    seed([15_000, 15_000], [15_000, 15_000], [15_000, 15_000], [100, 100])
    expect(await chat.compact(session.id)).toMatchObject({ ok: true })
    expect(compactions).toHaveLength(2)
    for (const req of compactions) expect(estimateRequest(req)).toBeLessThanOrEqual(window - SUMMARY_MAX_OUTPUT)
  })

  it('leaves the session as it was when the summary fails, and reports the error', async () => {
    const { db, chat, session, states, control, seed } = setup(100_000)
    seed([15_000, 15_000], [100, 100])
    control.fail = true
    expect(await chat.compact(session.id)).toEqual({ ok: false, error: '服务商出错' })
    expect(getSession(db, session.id)).toMatchObject({ compactSummary: null, compactThroughId: null, compactedAt: null })
    expect(states).toEqual([{ status: 'running' }, { status: 'error', error: '服务商出错' }])
  })

  it('a round with an attachment sent while it runs doesn\'t turn a finished compaction into a failure', async () => {
    const { chat, session, states, control, seed, send, files } = setup(100_000)
    seed([15_000, 15_000], [100, 100])
    const doc = files.add({ name: 'a.txt', mime: 'text/plain', data: Buffer.from('文'), extracted: [{ type: 'text', text: '文' }], isScanned: false })
    let release!: () => void
    control.hold = new Promise((r) => (release = r))
    const job = chat.compact(session.id)
    // Once the compaction has loaded the conversation and is waiting for the summary.
    await new Promise((r) => setTimeout(r, 10))
    await send('附了文件', [{ type: 'file', fileId: doc.id }])
    await new Promise((r) => setTimeout(r, 10))
    release()
    expect(await job).toMatchObject({ ok: true })
    expect(states.at(-1)).toBeNull()
  })

  it('a reply sent before a compaction landed and ending after it doesn\'t start another one', async () => {
    const { chat, session, compactions, control, seed, send } = setup(100_000, { context: 90_000, text: '答' })
    seed([30_000, 30_000], [5000, 5000])
    let releaseCompaction!: () => void
    let releaseReply!: () => void
    control.hold = new Promise((r) => (releaseCompaction = r))
    control.replyHold = new Promise((r) => (releaseReply = r))
    const job = chat.compact(session.id)
    await new Promise((r) => setTimeout(r, 10))
    // It was sent the long context, so its count is large; after the compaction the next request is ~25% full.
    await send('b'.repeat(4 * 15_000))
    releaseCompaction()
    expect(await job).toMatchObject({ ok: true })
    releaseReply()
    await chat.idle()
    expect(compactions).toHaveLength(1)
  })

  it('doesn\'t keep a summary cut off at the output cap', async () => {
    const { db, chat, session, states, control, seed } = setup(100_000)
    seed([15_000, 15_000], [100, 100])
    control.stopReason = 'max_tokens'
    const result = await chat.compact(session.id)
    expect(result.ok).toBe(false)
    expect(getSession(db, session.id)).toMatchObject({ compactSummary: null, compactThroughId: null })
    expect(states.at(-1)?.status).toBe('error')
    // The model's own cap is the summary's, so raising it in settings wouldn't help.
    expect(result).toMatchObject({ error: expect.not.stringContaining('调大') })
  })

  it('a summary cut off at a model\'s own smaller cap points to raising it', async () => {
    const { db, chat, session, model, control, seed } = setup(100_000)
    updateModel(db, model.id, { maxOutputTokens: 2000 })
    seed([15_000, 15_000], [100, 100])
    control.stopReason = 'max_tokens'
    expect(await chat.compact(session.id)).toMatchObject({ ok: false, error: expect.stringContaining('调大这个模型的最大输出') })
  })

  it('a cut ending on a question whose reply failed still alternates roles', async () => {
    const { db, chat, session, model, compactions, seed } = setup(100_000)
    seed([30_000, 30_000])
    appendMessage(db, session.id, { role: 'user', content: '没答上的问题', attachments: [] })
    const failed = appendMessage(db, session.id, { role: 'assistant', providerId: model.providerId, modelId: model.id })
    saveReply(db, failed.id, {
      content: '', thinking: null, thinkingMs: null, status: 'error', error: '出错', errorKind: 'other',
      inputTokens: null, outputTokens: null, contextTokens: null, web: null
    })
    seed([25_000, 100])
    expect(await chat.compact(session.id)).toMatchObject({ ok: true })
    const roles = compactions[0].messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(compactions[0].messages.at(-1))).toContain('没答上的问题')
  })

  it('压缩后重试: joins a compaction already running, then the regenerated reply goes with the summary', async () => {
    const { db, chat, session, model, requests, control, seed, send } = setup(100_000)
    seed([15_000, 15_000], [100, 100])
    control.replyError = true
    await send('太长了')
    await chat.idle()
    const failed = listMessages(db, session.id).at(-1)!
    expect(failed.errorKind).toBe('context_length')
    control.replyError = false
    let release!: () => void
    control.hold = new Promise((r) => (release = r))
    const running = chat.compact(session.id)
    expect(chat.compact(session.id)).toBe(running)
    release()
    expect(await running).toMatchObject({ ok: true })
    const { assistantMessage } = chat.regenerate({ replyId: failed.id, text: null, modelId: model.id, thinking: 'off', webSearch: false })
    await chat.idle()
    expect(firstText(requests.at(-1)!).startsWith('[前面对话的摘要]\n摘要1')).toBe(true)
    expect(getMessage(db, assistantMessage.id)).toMatchObject({ status: 'done', content: '答' })
  })

  it('counts nothing as compressible when the oldest round alone can\'t fit in a compaction request', async () => {
    const { chat, session, model, states, seed, send } = setup(40_000, { context: 36_000, text: '答' })
    seed([17_000, 17_000], [100, 100])
    expect(chat.contextUsage(session.id, model.id)).toMatchObject({ compressible: 0, nothingReason: 'too_large' })
    await send('问')
    await chat.idle()
    expect(states).toEqual([])
    expect(await chat.compact(session.id)).toEqual({ ok: false, error: 'nothing' })
  })

  it('a compaction that brought the context under the trigger reports success even if the model is deleted next', async () => {
    const { db, chat, session, model, control, seed } = setup(100_000)
    seed([30_000, 30_000], [5000, 5000])
    let release!: () => void
    control.hold = new Promise((r) => (release = r))
    const job = chat.compact(session.id)
    await new Promise((r) => setTimeout(r, 10))
    deleteModel(db, model.id)
    release()
    expect(await job).toMatchObject({ ok: true })
    expect(getSession(db, session.id).compactSummary).toBe('摘要1')
  })

  it('a session deleted while its reply ends is left alone', async () => {
    const { db, chat, session, control, seed, send } = setup(100_000, { context: 90_000, text: '答' })
    seed([30_000, 30_000])
    let release!: () => void
    control.replyHold = new Promise((r) => (release = r))
    await send('问')
    deleteSession(db, session.id)
    release()
    await expect(chat.idle()).resolves.toBeUndefined()
  })

  it('says there is nothing to compact when only the recent rounds exist', async () => {
    const { chat, session, compactions, seed } = setup(100_000)
    seed([100, 100])
    expect(await chat.compact(session.id)).toEqual({ ok: false, error: 'nothing' })
    expect(compactions).toHaveLength(0)
  })

  it('counts nothing as compressible once the session\'s model is deleted, as compact refuses then', async () => {
    const { db, chat, session, model, seed } = setup(100_000)
    seed([30_000, 30_000], [5000, 5000])
    const other = addModel(db, model.providerId, {
      modelName: 'other', displayName: 'Other', supportsVision: false, supportsThinking: false, thinkingCanDisable: true,
      supportsTools: false, contextWindow: 100_000, maxOutputTokens: 8000
    })
    deleteModel(db, model.id)
    expect(chat.contextUsage(session.id, other.id)).toMatchObject({ compressible: 0, nothingReason: 'model_deleted' })
    expect(await chat.compact(session.id)).toEqual({ ok: false, error: '这个会话用的模型已被删除' })
  })

  it('plans compressible with the session model so the meter agrees with compact when composer picks another model', async () => {
    const small = setup(40_000)
    small.seed([17_000, 17_000], [100, 100])
    const bigModel = addModel(small.db, small.model.providerId, {
      modelName: 'big', displayName: 'Big', supportsVision: false, supportsThinking: false, thinkingCanDisable: true,
      supportsTools: false, contextWindow: 200_000, maxOutputTokens: 8000
    })
    expect(small.chat.contextUsage(small.session.id, bigModel.id)).toMatchObject({ compressible: 0, nothingReason: 'too_large' })
    expect(await small.chat.compact(small.session.id)).toEqual({ ok: false, error: 'nothing' })

    const big = setup(200_000)
    big.seed([17_000, 17_000], [100, 100])
    const smallModel = addModel(big.db, big.model.providerId, {
      modelName: 'small', displayName: 'Small', supportsVision: false, supportsThinking: false, thinkingCanDisable: true,
      supportsTools: false, contextWindow: 40_000, maxOutputTokens: 8000
    })
    expect(big.chat.contextUsage(big.session.id, smallModel.id)).toMatchObject({ compressible: 34_000, nothingReason: null })
    expect(await big.chat.compact(big.session.id)).toMatchObject({ ok: true })
  })

  it('keeps a summary saved by pass 1 and still reports why pass 2 failed', async () => {
    const { db, session, states, seed } = setup(50_000)
    seed([15_000, 15_000], [15_000, 15_000], [15_000, 15_000], [100, 100])
    let n = 0
    const chat2 = createChat({
      db,
      compactState: (_id, state) => states.push(state),
      connection: () => ({ protocol: 'anthropic', baseUrl: 'http://x', apiKey: 'k' }),
      emit: () => {}, sessionUpdated: () => {}, checkFile: () => {}, readFile: () => Buffer.alloc(0),
      ensureFile: async () => {}, webTools: () => null,
      stream: async function* () {
        n++
        if (n === 2) {
          yield { type: 'error', kind: 'other', message: '服务商出错' }
          return
        }
        yield { type: 'text', delta: `摘要${n}` }
        yield { type: 'done', usage: { input: 1, output: 1, context: 1 }, stopReason: 'end_turn' }
      }
    })
    const result = await chat2.compact(session.id)
    expect(result).toMatchObject({ ok: true, session: { compactSummary: '摘要1' }, error: '服务商出错' })
    expect(getSession(db, session.id).compactSummary).toBe('摘要1')
    expect(states).toEqual([{ status: 'running' }, { status: 'error', error: '服务商出错' }])
  })
})
