import { describe, expect, it, vi } from 'vitest'
import type { Message, StreamEvent } from '@shared/types'
import { createProjectTools, MAX_READ_CHARS, MAX_READ_ROUNDS } from '../src/main/llm/projectTools'
import type { ProjectSessionRef, Tools } from '../src/main/llm/types'

const date = new Date(2026, 10, 3, 23, 30).getTime()
const session: ProjectSessionRef = { n: 3, id: 's', title: '线代 | 特征值分解', createdAt: date - 86400000 }
const other: ProjectSessionRef = { n: 4, id: 'other', title: '线代 | 相似对角化', createdAt: date }

function msg(seq: number, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return {
    id: `m${seq}`, sessionId: 's', seq, role, content, thinking: null, thinkingMs: null,
    attachments: [], status: 'done', error: null, errorKind: null, providerId: null,
    modelId: null, inputTokens: null, outputTokens: null, web: null, createdAt: date,
    ...extra
  }
}

function conversation(count: number, content = '内容'): Message[] {
  return Array.from({ length: count }, (_, i) => [
    msg(i * 2 + 1, 'user', `问题${i + 1}`),
    msg(i * 2 + 2, 'assistant', `${content}${i + 1}`)
  ]).flat()
}

async function run(tools: Tools<string>, name: string, input: unknown) {
  const gen = tools.run({ id: 'call', name, input }, new AbortController().signal)
  const events: StreamEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, output: next.value }
}

const read = (tools: Tools<string>, start = 1, end = start, n = session.n) =>
  run(tools, 'read_session', { session: n, start_round: start, end_round: end })
const search = (tools: Tools<string>, query: string) => run(tools, 'search_project_sessions', { query })

describe('project session rounds', () => {
  it('sorts by sequence and keeps each question with all usable answers before the next question', async () => {
    const messages = [
      msg(0, 'assistant', 'orphan'),
      msg(1, 'user', '第一问'),
      msg(2, 'assistant', '完整回答'),
      msg(3, 'assistant', '停止回答', { status: 'stopped' }),
      msg(4, 'assistant', '失败回答', { status: 'error' }),
      msg(5, 'assistant', '正在回答', { status: 'streaming' }),
      msg(6, 'assistant', '  ', { status: 'stopped' }),
      msg(7, 'user', '第二问'),
      msg(8, 'user', '第三问'),
      msg(9, 'assistant', '第三答')
    ].reverse()
    const tools = createProjectTools([session], () => messages, () => '文件')
    const { output, events } = await read(tools, 1, 2)
    expect(output).toBe(
      '会话 3《线代 | 特征值分解》（共 3 轮）：\n\n' +
      '## 第 1 轮（2026-11-03）\n我：第一问\n\n回答：完整回答\n\n回答：停止回答\n\n' +
      '## 第 2 轮（2026-11-03）\n我：第二问'
    )
    expect(events).toEqual([{ type: 'step', step: { type: 'session_read', title: session.title, start: 1, end: 2 } }])
    expect((await read(tools, 3)).output).toContain('我：第三问\n\n回答：第三答')
    expect(messages[0].seq).toBe(9)
    for (const query of ['orphan', '失败回答', '正在回答']) {
      // These terms share Chinese tokens with usable answers, so check the returned text as well.
      expect((await search(tools, query)).output).not.toContain(`回答：${query}`)
    }
  })

  it('excludes thread messages even when the loader returns them alongside the main session', async () => {
    const tools = createProjectTools([session], () => [
      ...conversation(1),
      msg(1, 'user', 'threadonly', { sessionId: 'thread' }),
      msg(2, 'assistant', 'threadanswer', { sessionId: 'thread' })
    ], () => '文件')
    const result = await read(tools)
    expect(result.output).toContain('共 1 轮')
    expect(result.output).not.toContain('thread')
    expect((await search(tools, 'threadonly')).output).toContain('没有检索到')
  })

  it('formats file names and references like organizing a session, including attachment-only questions', async () => {
    const fileName = vi.fn(() => '矩阵讲义.pdf')
    const tools = createProjectTools([session], () => [
      msg(1, 'user', '', { attachments: [
        { type: 'file', fileId: 'pdf' },
        { type: 'thread_result', threadId: 't', messageId: 'm', quote: '原句', text: '带回结论' },
        { type: 'note_ref', noteId: 'note', sectionTitle: null, label: '《笔记》', text: '笔记引用内容' },
        { type: 'session_ref', sessionId: 'ref', label: '《旧会话》', text: '会话引用内容' }
      ] }),
      msg(2, 'assistant', '看到了'),
      msg(3, 'user', '再次提问', { attachments: [{ type: 'file', fileId: 'pdf' }] })
    ], fileName)
    const { output } = await read(tools, 1, 2)
    expect(output).toContain('我：[附件：矩阵讲义.pdf]\n[追问结论] 关于「原句」：带回结论')
    expect(output).toContain('[笔记引用：《笔记》]\n笔记引用内容')
    expect(output).toContain('[会话引用：《旧会话》]\n会话引用内容')
    expect(fileName).toHaveBeenCalledExactlyOnceWith('pdf')
    expect((await search(tools, '矩阵讲义')).output).toContain('第 1 轮')
  })
})

describe('project session search', () => {
  it('ranks rounds across sessions, searches both questions and answers, and reports the trimmed query', async () => {
    const tools = createProjectTools([session, other], (id) => id === session.id ? [
      msg(1, 'user', '特征值是什么'), msg(2, 'assistant', '特征值和特征向量，特征值满足 Av = λv。'),
      msg(3, 'user', '还有呢'), msg(4, 'assistant', '这里讨论 Fourier transform。')
    ] : [
      msg(1, 'user', '矩阵的各种应用', { sessionId: other.id }),
      msg(2, 'assistant', `特征值 ${'其他内容 '.repeat(50)}`, { sessionId: other.id })
    ], () => '文件')
    const { output, events } = await search(tools, '  特征值  ')
    expect(events).toEqual([{ type: 'step', step: { type: 'session_search', query: '特征值' } }])
    expect(output.indexOf('会话 3《线代 | 特征值分解》第 1 轮（2026-11-03）')).toBeLessThan(output.indexOf('会话 4《'))
    expect(output).toContain('片段只是线索，用 read_session 读全文')
    expect((await search(tools, 'FOURIER')).output).toContain('第 2 轮（2026-11-03）')
    expect((await search(tools, '还有呢')).output).toContain('第 2 轮')
  })

  it('returns only eight relevant rounds and can search and read sessions older than the listed fifty', async () => {
    const refs = Array.from({ length: 51 }, (_, i) => ({ ...session, n: i + 1, id: `s${i + 1}` }))
    const tools = createProjectTools(refs, (id) => [
      msg(1, 'user', 'sharedterm', { sessionId: id }),
      msg(2, 'assistant', id === 's1' ? 'oldestonly' : 'neweronly', { sessionId: id })
    ], () => '文件')
    const { output } = await search(tools, 'sharedterm')
    expect(output.match(/会话 \d+《/g)).toHaveLength(8)
    const oldest = await search(tools, 'oldestonly')
    expect(oldest.output).toContain('会话 1《')
    expect((await read(tools, 1, 1, 1)).output).toContain('回答：oldestonly')
  })

  it('loads on demand, reuses rounds for reads and searches, and refreshes for a new reply', async () => {
    const loadMessages = vi.fn((id: string) => [msg(1, 'user', 'originalterm', { sessionId: id })])
    const tools = createProjectTools([session, other], loadMessages, () => '文件')
    expect(loadMessages).not.toHaveBeenCalled()
    await read(tools)
    expect(loadMessages).toHaveBeenCalledExactlyOnceWith(session.id)
    await search(tools, 'originalterm')
    await search(tools, 'originalterm')
    await read(tools, 1, 1, other.n)
    expect(loadMessages).toHaveBeenCalledTimes(2)
    loadMessages.mockImplementation((id) => [msg(1, 'user', 'updatedterm', { sessionId: id })])
    expect((await search(tools, 'updatedterm')).output).toContain('没有检索到')
    const fresh = createProjectTools([session, other], loadMessages, () => '文件')
    expect((await search(fresh, 'updatedterm')).output).toContain('会话 3《')
  })

  it('returns a bounded snippet around a match in a long round', async () => {
    const tools = createProjectTools([session], () => [
      msg(1, 'user', `${'甲'.repeat(1000)} needle ${'乙'.repeat(1000)}`)
    ], () => '文件')
    const { output } = await search(tools, 'needle')
    expect(output).toContain(`…${'甲'.repeat(39)} needle ${'乙'.repeat(39)}…`)
    expect(output.length).toBeLessThan(300)
  })

  it('does not treat a title alone as a matching round', async () => {
    const tools = createProjectTools([session], () => conversation(1), () => '文件')
    expect((await search(tools, '特征值')).output).toContain('没有检索到「特征值」')
  })
})

describe('project session read limits', () => {
  it('reads at most five rounds and resumes at the next round, clamping to the session end', async () => {
    const tools = createProjectTools([session], () => conversation(9), () => '文件')
    const first = await read(tools, 2, 100)
    expect(first.output).toContain('共 9 轮')
    expect(first.output.match(/## 第 \d+ 轮/g)).toHaveLength(MAX_READ_ROUNDS)
    expect(first.output).toContain('这次读到第 6 轮')
    expect(first.output).toContain('从第 7 轮接着读')
    expect(first.events).toEqual([{ type: 'step', step: { type: 'session_read', title: session.title, start: 2, end: 6 } }])
    const rest = await read(tools, 7, 100)
    expect(rest.output).toContain('## 第 9 轮')
    expect(rest.output).not.toContain('接着读')
    expect(rest.events).toEqual([{ type: 'step', step: { type: 'session_read', title: session.title, start: 7, end: 9 } }])
  })

  it('normalizes a reversed range and accepts numeric strings', async () => {
    const tools = createProjectTools([session], () => conversation(4), () => '文件')
    const result = await run(tools, 'read_session', { session: '3', start_round: '4', end_round: '2' })
    expect(result.output).toContain('## 第 2 轮')
    expect(result.output).toContain('## 第 4 轮')
    expect(result.output).not.toContain('## 第 1 轮')
  })

  it('stops at a complete round before the character limit and allows reading the deferred round', async () => {
    const tools = createProjectTools([session], () => [
      msg(1, 'user', '第一问'), msg(2, 'assistant', '甲'.repeat(11000)),
      msg(3, 'user', '第二问'), msg(4, 'assistant', '乙'.repeat(11000))
    ], () => '文件')
    const first = await read(tools, 1, 2)
    expect(first.output.length).toBeLessThanOrEqual(MAX_READ_CHARS)
    expect(first.output).toContain('甲'.repeat(11000))
    expect(first.output).not.toContain('第二问')
    expect(first.output).toContain('从第 2 轮接着读')
    expect(first.events).toEqual([{ type: 'step', step: { type: 'session_read', title: session.title, start: 1, end: 1 } }])
    const second = await read(tools, 2)
    expect(second.output).toContain('乙'.repeat(11000))
    expect(second.output).not.toContain('截断')
  })

  it.each([false, true])('truncates an oversized single round and distinguishes its omitted content from following rounds (more=%s)', async (more) => {
    const messages = [msg(1, 'user', '超长问题'), msg(2, 'assistant', `${'😀'.repeat(MAX_READ_CHARS)}尾部标记`)]
    if (more) messages.push(msg(3, 'user', '下一问'))
    const tools = createProjectTools([session], () => messages, () => '文件')
    const { output, events } = await read(tools, 1, more ? 2 : 1)
    expect(output.length).toBeLessThanOrEqual(MAX_READ_CHARS)
    expect(output).toContain('第 1 轮单独超过')
    expect(output).toContain('内容已截断，未展示这一轮的剩余内容')
    expect(output).not.toContain('尾部标记')
    expect(() => encodeURIComponent(output)).not.toThrow()
    expect(output.includes('从第 2 轮接着读')).toBe(more)
    expect(events).toEqual([{ type: 'step', step: { type: 'session_read', title: session.title, start: 1, end: 1 } }])
  })

  it('keeps content at the exact character boundary and truncates only when it exceeds the limit', async () => {
    const makeTools = (text: string) => createProjectTools([session], () => [msg(1, 'user', text)], () => '文件')
    const overhead = (await read(makeTools(''))).output.length
    const text = '甲'.repeat(MAX_READ_CHARS - overhead)
    const exact = await read(makeTools(text))
    expect(exact.output.length).toBe(MAX_READ_CHARS)
    expect(exact.output).not.toContain('截断')
    const over = await read(makeTools(text + '乙'))
    expect(over.output.length).toBeLessThanOrEqual(MAX_READ_CHARS)
    expect(over.output).toContain('截断')
  })
})

describe('project tool errors', () => {
  it.each([undefined, null, {}, { query: '' }, { query: '  ' }, { query: 4 }])('rejects a missing query without loading messages (%j)', async (input) => {
    const load = vi.fn(() => conversation(1))
    const result = await run(createProjectTools([session], load, () => '文件'), 'search_project_sessions', input)
    expect(result).toEqual({ events: [], output: '缺少关键词 query。' })
    expect(load).not.toHaveBeenCalled()
  })

  it.each([
    {}, { session: '' }, { session: null }, { session: true }, { session: 0 }, { session: 1.5 },
    { session: 3 }, { session: 3, start_round: 1 }, { session: 3, start_round: 0, end_round: 1 },
    { session: 3, start_round: 1, end_round: -1 }, { session: 3, start_round: NaN, end_round: 1 },
    { session: 3, start_round: 1, end_round: Infinity }, { session: 3, start_round: 1.5, end_round: 2 }
  ])('rejects missing or invalid read parameters without loading messages (%j)', async (input) => {
    const load = vi.fn(() => conversation(1))
    const result = await run(createProjectTools([session], load, () => '文件'), 'read_session', input)
    expect(result.output).toContain('缺少有效的')
    expect(result.events).toEqual([])
    expect(load).not.toHaveBeenCalled()
  })

  it('resolves by the supplied number rather than array position and rejects IDs outside the supplied sessions', async () => {
    const load = vi.fn(() => conversation(1))
    const tools = createProjectTools([session], load, () => '文件')
    const missing = await read(tools, 1, 1, 1)
    expect(missing.output).toContain('没有编号为 1 的项目会话')
    expect(missing.events).toEqual([])
    expect(load).not.toHaveBeenCalled()
    const beyond = await read(tools, 2)
    expect(beyond.output).toContain('一共只有 1 轮')
    expect(beyond.events).toEqual([])
  })

  it('handles empty sessions and empty search results and rejects unknown tools', async () => {
    const tools = createProjectTools([session], () => [], () => '文件')
    expect((await read(tools)).output).toContain('一共只有 0 轮')
    expect((await search(tools, 'missing')).output).toContain('没有检索到「missing」')
    const empty = createProjectTools([], () => { throw new Error('unexpected load') }, () => '文件')
    expect((await search(empty, 'missing')).output).toContain('同义词或更短的词')
    expect((await run(tools, 'unknown', null)).output).toBe('没有名为 unknown 的工具。')
  })
})
