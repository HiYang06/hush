import type { Message, StreamEvent } from '@shared/types'
import { messageDate } from './context'
import { createIndex, MAX_SEARCH_HITS, snippet } from './documentTools'
import type { SearchHit } from './documentTools'
import { turn } from './organize'
import type { ProjectSessionRef, Tools, ToolSpec } from './types'

export const MAX_READ_ROUNDS = 5
export const MAX_READ_CHARS = 20_000

export const PROJECT_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'search_project_sessions',
    description: [
      '在这个 project 的其他主对话里按关键词检索，返回最相关的 8 轮问答、会话编号、标题、轮次、日期，以及命中处前后的片段。不检索追问。',
      '用于找以前讨论过的概念、结论或问题。片段只是线索：回答前用 read_session 读这些轮次。也能检索到会话列表没有列出的更早会话。',
      '关键词用对话里可能出现的原词；中英文术语都可以试，没搜到就换同义词或更短的词。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '关键词，几个词用空格隔开' } },
      required: ['query']
    }
  },
  {
    name: 'read_session',
    description: [
      '读这个 project 的其他主对话的连续几轮问答，一次最多 5 轮、20000 字。返回会话总轮数和这些轮次的提问、已完成或停止的回答；文件附件只写名字，不含追问。',
      '用户提到以前的某个会话，或检索到相关轮次之后用它。达到上限时按结果中的提示接着读；单独一轮就超长时会截断并说明。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'integer', description: '会话编号，和项目会话列表或检索结果里的一样' },
        start_round: { type: 'integer', description: '第一轮的轮次，从 1 开始' },
        end_round: { type: 'integer', description: '最后一轮的轮次（包含）' }
      },
      required: ['session', 'start_round', 'end_round']
    }
  }
]

type Round = { session: ProjectSessionRef; n: number; date: string; text: string }

function positiveInteger(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null
}

function roundHeader(round: Round): string {
  return `会话 ${round.session.n}《${round.session.title}》第 ${round.n} 轮（${round.date}）`
}

export function createProjectTools(
  sessions: ProjectSessionRef[],
  loadMessages: (sessionId: string) => Message[],
  fileName: (fileId: string) => string
): Tools<string> {
  const cached = new Map<string, Round[]>()
  let search: ((query: string) => SearchHit<Round>[]) | undefined

  function roundsOf(session: ProjectSessionRef): Round[] {
    const existing = cached.get(session.id)
    if (existing) return existing
    const rounds: Round[] = []
    const fileNames = new Map<string, string>()
    const messages = loadMessages(session.id).filter((m) => m.sessionId === session.id).sort((a, b) => a.seq - b.seq)
    for (const m of messages) {
      if (m.role === 'user') {
        for (const a of m.attachments) {
          if (a.type === 'file' && !fileNames.has(a.fileId)) fileNames.set(a.fileId, fileName(a.fileId))
        }
        rounds.push({ session, n: rounds.length + 1, date: messageDate(m.createdAt).split(' ')[0], text: turn(m, fileNames) })
      } else if ((m.status === 'done' || m.status === 'stopped') && m.content.trim() && rounds.length > 0) {
        rounds[rounds.length - 1].text += `\n\n${turn(m, fileNames)}`
      }
    }
    cached.set(session.id, rounds)
    return rounds
  }

  async function* runSearch(input: Record<string, unknown>): AsyncGenerator<StreamEvent, string> {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) return '缺少关键词 query。'
    yield { type: 'step', step: { type: 'session_search', query } }
    search ??= createIndex(sessions.flatMap(roundsOf), (round) => round.text)
    const hits = search(query).slice(0, MAX_SEARCH_HITS)
    if (hits.length === 0) return `在项目会话里没有检索到「${query}」。可以换个说法、同义词或更短的词再试。`
    const entries = hits.map(({ item, terms }) => `${roundHeader(item)}\n${snippet(item.text, terms)}`)
    return `在项目会话里检索「${query}」，最相关的轮次（片段只是线索，用 read_session 读全文）：\n\n${entries.join('\n\n')}`
  }

  async function* runRead(input: Record<string, unknown>): AsyncGenerator<StreamEvent, string> {
    const n = positiveInteger(input.session)
    if (n === null) return '缺少有效的会话编号 session，请填写从 1 开始的整数。'
    const session = sessions.find((s) => s.n === n)
    if (!session) return `没有编号为 ${n} 的项目会话。请使用项目会话列表或 search_project_sessions 检索结果里的编号。`
    const from = positiveInteger(input.start_round)
    const to = positiveInteger(input.end_round)
    if (from === null || to === null) return '缺少有效的轮次 start_round、end_round，请填写从 1 开始的整数。'
    const rounds = roundsOf(session)
    const first = Math.min(from, to)
    if (first > rounds.length) return `会话 ${n}《${session.title}》一共只有 ${rounds.length} 轮。`
    const wantedLast = Math.min(rounds.length, Math.max(from, to))
    const limit = Math.min(wantedLast, first + MAX_READ_ROUNDS - 1)
    const header = `会话 ${n}《${session.title}》（共 ${rounds.length} 轮）：\n\n`
    const sections: string[] = []
    const continuation = (last: number): string => last < wantedLast
      ? `\n\n（一次最多读 ${MAX_READ_ROUNDS} 轮、${MAX_READ_CHARS} 字，这次读到第 ${last} 轮；需要的话从第 ${last + 1} 轮接着读）`
      : ''
    let last = first - 1
    let truncated = ''
    for (const round of rounds.slice(first - 1, limit)) {
      const section = `## 第 ${round.n} 轮（${round.date}）\n${round.text}`
      const text = header + [...sections, section].join('\n\n') + continuation(round.n)
      if (text.length > MAX_READ_CHARS) {
        if (sections.length === 0) {
          last = round.n
          truncated = `\n\n（第 ${last} 轮单独超过 ${MAX_READ_CHARS} 字的读取上限，内容已截断，未展示这一轮的剩余内容）`
          const available = Math.max(0, MAX_READ_CHARS - header.length - truncated.length - continuation(last).length)
          sections.push(section.slice(0, available).replace(/[\uD800-\uDBFF]$/, ''))
        }
        break
      }
      sections.push(section)
      last = round.n
    }
    yield { type: 'step', step: { type: 'session_read', title: session.title, start: first, end: last } }
    return header + sections.join('\n\n') + truncated + continuation(last)
  }

  return {
    specs: PROJECT_TOOL_SPECS,
    async *run(call) {
      const input = (call.input ?? {}) as Record<string, unknown>
      if (call.name === 'search_project_sessions') return yield* runSearch(input)
      if (call.name === 'read_session') return yield* runRead(input)
      return `没有名为 ${call.name} 的工具。`
    }
  }
}
