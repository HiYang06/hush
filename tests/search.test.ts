import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { appendMessage, saveReply } from '../src/main/db/repo/messages'
import { saveNote } from '../src/main/db/repo/notes'
import { createProject } from '../src/main/db/repo/projects'
import { addModel, createProvider } from '../src/main/db/repo/providers'
import { search } from '../src/main/db/repo/search'
import { createMainSession, createThreadSession } from '../src/main/db/repo/sessions'
import { plainText, searchTerms, snippet, sourceTermMatches, termMatches } from '../src/shared/search'

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
  const newSession = (title: string, projectId: string | null = null) =>
    createMainSession(db, { title, projectId, ...ids })
  const ask = (sessionId: string, content: string) =>
    appendMessage(db, sessionId, { role: 'user', content, attachments: [] })
  const reply = (sessionId: string, content: string) => {
    const m = appendMessage(db, sessionId, { role: 'assistant', ...ids })
    saveReply(db, m.id, {
      content,
      thinking: null,
      thinkingMs: null,
      status: 'done',
      error: null,
      errorKind: null,
      inputTokens: null,
      outputTokens: null, web: null
    })
    return m
  }
  return { db, ids, newSession, ask, reply }
}

describe('search helpers', () => {
  it('splits on whitespace and drops repeats', () => {
    expect(searchTerms('  特征值  矩阵 特征值 ')).toEqual(['特征值', '矩阵'])
    expect(searchTerms('   ')).toEqual([])
  })

  it('finds every hit ignoring case, merging overlaps', () => {
    expect(termMatches('Eigen eigenvalue', ['eigen'])).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 }
    ])
    expect(termMatches('abcd', ['abc', 'bcd'])).toEqual([{ from: 0, to: 4 }])
  })

  it('cuts a one-line snippet around the first hit', () => {
    const text = `${'前'.repeat(50)}\n\n特征值${'后'.repeat(50)}`
    const s = snippet(text, ['特征值'])
    expect(s).toBe(`…${'前'.repeat(29)} 特征值${'后'.repeat(30)}…`)
    expect(snippet('短短的特征值', ['特征值'])).toBe('短短的特征值')
  })

  it('reduces markdown to roughly what the reader sees', () => {
    const plain = (md: string) => snippet(plainText(md), ['特征值'])
    expect(plain('## 结论\n\n矩阵的**特征值**和 `trace`')).toBe('结论 矩阵的特征值和 trace')
    expect(plain('> 引用里的*特征值*\n> [原文](hush://message/abc#1-5)')).toBe('引用里的特征值 原文')
    expect(plain('- 第一项特征值\n1. 第二项\n```ts\nconst a_b = 2 * 3 * 4\n```')).toBe(
      '第一项特征值 第二项 const a_b = 2 * 3 * 4'
    )
  })

  it('finds hits in markdown source across emphasis markers', () => {
    const md = '矩阵的**特**征值，`特征`值，特征值'
    expect(sourceTermMatches(md, ['特征值']).map((m) => md.slice(m.from, m.to))).toEqual([
      '特**征值',
      '特征`值',
      '特征值'
    ])
    expect(termMatches(md, ['特征值'])).toHaveLength(1)
    expect(termMatches('a.c abc', ['a.c'])).toEqual([{ from: 0, to: 3 }])
  })
})

describe('search', () => {
  it('finds messages through FTS for terms of 3+ characters, newest first', () => {
    const { db, newSession, ask, reply } = setup()
    const s = newSession('线性代数')
    ask(s.id, '什么是特征值？')
    reply(s.id, '矩阵的特征值就是它把某个方向拉伸的倍数。')
    ask(s.id, '无关的问题')

    const r = search(db, '特征值')
    expect(r.terms).toEqual(['特征值'])
    expect(r.messages.map((m) => m.snippet)).toEqual(['矩阵的特征值就是它把某个方向拉伸的倍数。', '什么是特征值？'])
    expect(r.messages[0].sessionTitle).toBe('线性代数')
  })

  it('matches what the reader sees, not the markdown source', () => {
    const { db, newSession, ask, reply } = setup()
    const s = newSession('会话')
    ask(s.id, '问题')
    reply(s.id, '矩阵的**特征值**就是倍数，见 [链接](https://example.com/eigen)')
    expect(search(db, '特征值就是').messages.map((m) => m.snippet)).toEqual(['矩阵的特征值就是倍数，见 链接'])
    expect(search(db, '征值就').messages).toHaveLength(1)
    expect(search(db, 'eigen').messages).toHaveLength(0)
  })

  it('falls back to LIKE when a term is shorter than 3 characters', () => {
    const { db, newSession, ask } = setup()
    const s = newSession('会话')
    ask(s.id, '矩阵乘法')
    ask(s.id, '向量')
    expect(search(db, '矩阵').messages.map((m) => m.snippet)).toEqual(['矩阵乘法'])
  })

  it('requires every term, on both paths', () => {
    const { db, newSession, ask } = setup()
    const s = newSession('会话')
    ask(s.id, '特征值和特征向量')
    ask(s.id, '只有特征值')
    expect(search(db, '特征值 特征向量').messages).toHaveLength(1)
    expect(search(db, '特征值 向量').messages).toHaveLength(1)
  })

  it('treats LIKE wildcards and quotes as plain text', () => {
    const { db, newSession, ask } = setup()
    const s = newSession('会话')
    ask(s.id, '增长了 50%')
    ask(s.id, '增长了 50 倍')
    ask(s.id, 'say "hello" now')
    expect(search(db, '0%').messages).toHaveLength(1)
    expect(search(db, '"hello"').messages).toHaveLength(1)
  })

  it('labels a thread message with its main session title', () => {
    const { db, ids, newSession, ask, reply } = setup()
    const s = newSession('主对话')
    ask(s.id, '问题')
    const answer = reply(s.id, '回答')
    const thread = createThreadSession(db, {
      parentSessionId: s.id,
      anchorMessageId: answer.id,
      anchorQuote: '回答',
      anchorStart: 0,
      anchorEnd: 2,
      anchorPrefix: '',
      anchorSuffix: '',
      contextMode: 'fork',
      title: '追问标题',
      ...ids
    })
    ask(thread.id, '追问里的特征值')
    expect(search(db, '特征值').messages[0].sessionTitle).toBe('主对话')
  })

  it('matches main session titles only', () => {
    const { db, ids, newSession, reply } = setup()
    const s = newSession('特征值的几何意义')
    const answer = reply(s.id, '回答')
    createThreadSession(db, {
      parentSessionId: s.id,
      anchorMessageId: answer.id,
      anchorQuote: '回答',
      anchorStart: 0,
      anchorEnd: 2,
      anchorPrefix: '',
      anchorSuffix: '',
      contextMode: 'new',
      title: '特征值追问',
      ...ids
    })
    expect(search(db, '特征值').sessions.map((x) => x.title)).toEqual(['特征值的几何意义'])
  })

  it('finds notes and names who they belong to', () => {
    const { db, newSession } = setup()
    const project = createProject(db, '线代')
    const s = newSession('独立会话')
    saveNote(db, { scope: 'project', scopeId: project.id }, '特征值之和等于迹')
    saveNote(db, { scope: 'session', scopeId: s.id }, '特征值')
    saveNote(db, { scope: 'global', scopeId: 'global' }, '全局的特征值')

    const owners = Object.fromEntries(search(db, '特征值').notes.map((n) => [n.target.scope, n.ownerName]))
    expect(owners).toEqual({ project: '线代', session: '独立会话', global: null })
  })

  it('caps each group at 20', () => {
    const { db, newSession, ask } = setup()
    const s = newSession('会话')
    for (let i = 0; i < 25; i++) ask(s.id, `第 ${i} 个特征值`)
    expect(search(db, '特征值').messages).toHaveLength(20)
  })

  it('returns nothing for a blank query', () => {
    const { db } = setup()
    expect(search(db, '  ')).toEqual({ terms: [], sessions: [], messages: [], notes: [] })
  })
})
