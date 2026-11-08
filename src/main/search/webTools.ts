import type { StreamEvent, WebSource } from '@shared/types'
import type { ToolCall, Tools, ToolSpec } from '../llm/types'
import {
  exaContents,
  exaSearch,
  tavilyExtract,
  tavilySearch,
  type Hit,
  type Page,
  type Recency,
  type SearchKeys
} from './services'

const MAX_HITS = 8
// About 5k–10k tokens: enough for an article, without one page swamping the context.
const PAGE_CHARS = 20_000
const SOURCE_SNIPPET_CHARS = 200
const RECENCIES: Recency[] = ['day', 'week', 'month', 'year']

// The model's instructions for searching live here rather than in the system prompt: there is exactly one
// prompt (D-019), and fixed tool text never disturbs the cache.
export const WEB_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'web_search',
    description: [
      '在网上搜索。用于：训练数据之后的新信息（新闻、版本、价格、最新研究）、具体的人或机构或产品的现状、需要核对出处的事实、用户要求查的内容。稳定的基础知识（数学、经典理论、常识）直接回答，不用搜。',
      '搜索词要具体、自足：结合对话把指代说清楚，不要直接搜"它""这个"。技术和学术类问题也用英文搜，资料通常更全。没搜到合适的就换个说法再搜，不要重复同样的词。',
      '结果只有片段。需要讲清细节、核对原话或数据时，用 read_page 读全文。',
      '回答时：用到的结论在句末标来源编号，如 [1] 或 [2][5]，编号用结果里给的；分清哪些来自搜索、哪些是你自己的知识；来源之间有矛盾时说出来；时效性强的内容注明资料日期。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        recency: {
          type: 'string',
          enum: RECENCIES,
          description: '只要最近一天、一周、一月或一年内的结果。只在问题明确关心时效时用。'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'read_page',
    description:
      '读一个网页的正文。用于搜索结果的片段不够、需要细节时，或用户在消息里给了链接时。读到的内容同样按编号引用。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整的 http(s) 网址' } },
      required: ['url']
    }
  }
]

// The same page reached by different links counts once: no fragment, no tracking parameters,
// no "www.", no trailing slash.
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) if (key.startsWith('utm_')) u.searchParams.delete(key)
    const host = u.host.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    return `${host}${path}${u.search}`
  } catch {
    return url
  }
}

// Each service's best results first, alternating, so neither one's ranking dominates.
export function mergeHits(lists: Hit[][]): Hit[] {
  const seen = new Set<string>()
  const merged: Hit[] = []
  for (let rank = 0; merged.length < MAX_HITS && lists.some((l) => rank < l.length); rank++) {
    for (const list of lists) {
      const hit = list[rank]
      if (!hit || merged.length >= MAX_HITS) continue
      const key = normalizeUrl(hit.url)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(hit)
    }
  }
  return merged
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

function firstSuccess<T>(attempts: (() => Promise<T>)[]): Promise<T> {
  return attempts.reduce<Promise<T>>(
    (prev, next) => prev.catch(() => next()),
    Promise.reject(new Error('No search service is set up.'))
  )
}

type Fetch = typeof fetch

// One instance per reply: sources are numbered within the reply, and a URL keeps its first number.
export function createWebTools(keys: SearchKeys, fetchFn: Fetch = fetch): Tools<string> {
  const sources = new Map<string, WebSource>()

  function register(url: string, title: string, date: string | null, text: string): { source: WebSource; isNew: boolean } {
    const key = normalizeUrl(url)
    const known = sources.get(key)
    if (known) return { source: known, isNew: false }
    const source: WebSource = {
      n: sources.size + 1,
      url,
      title,
      date,
      snippet: text.replace(/\s+/g, ' ').trim().slice(0, SOURCE_SNIPPET_CHARS)
    }
    sources.set(key, source)
    return { source, isNew: true }
  }

  async function search(query: string, recency: Recency | null, signal: AbortSignal): Promise<Hit[]> {
    const runs: Promise<Hit[]>[] = []
    if (keys.tavily) runs.push(tavilySearch(fetchFn, keys.tavily, query, recency, signal))
    if (keys.exa) runs.push(exaSearch(fetchFn, keys.exa, query, recency, signal))
    const settled = await Promise.allSettled(runs)
    const ok = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
    // One service failing still leaves the other's results; only when all fail is it an error.
    if (ok.length === 0) {
      throw new Error(settled.map((s) => (s.status === 'rejected' ? String(s.reason?.message ?? s.reason) : '')).join('; '))
    }
    return mergeHits(ok)
  }

  function read(url: string, signal: AbortSignal): Promise<Page> {
    const attempts: (() => Promise<Page>)[] = []
    if (keys.tavily) attempts.push(() => tavilyExtract(fetchFn, keys.tavily!, url, signal))
    if (keys.exa) attempts.push(() => exaContents(fetchFn, keys.exa!, url, signal, PAGE_CHARS))
    return firstSuccess(attempts)
  }

  async function* runSearch(input: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<StreamEvent, string> {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) return '缺少搜索词 query。'
    const recency = RECENCIES.includes(input.recency as Recency) ? (input.recency as Recency) : null
    yield { type: 'step', step: { type: 'search', query } }
    const hits = await search(query, recency, signal)
    if (hits.length === 0) return `搜索「${query}」没有结果。可以换个说法再搜。`
    const added: WebSource[] = []
    const entries = hits.map((hit) => {
      const { source, isNew } = register(hit.url, hit.title, hit.date, hit.text)
      if (isNew) added.push(source)
      return [`[${source.n}] ${hit.title}`, `网址：${hit.url}`, hit.date && `日期：${hit.date}`, hit.text]
        .filter(Boolean)
        .join('\n')
    })
    if (added.length > 0) yield { type: 'sources', sources: added }
    return `搜索「${query}」的结果（引用时在句末写编号，如 [1]）：\n\n${entries.join('\n\n')}`
  }

  async function* runRead(input: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<StreamEvent, string> {
    const url = typeof input.url === 'string' ? input.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) return '网址无效：需要完整的 http(s) 网址。'
    yield { type: 'step', step: { type: 'read', url } }
    const page = await read(url, signal)
    const known = sources.get(normalizeUrl(url))
    const { source, isNew } = register(url, known?.title ?? page.title ?? hostOf(url), null, page.text)
    if (isNew) yield { type: 'sources', sources: [source] }
    const cut = page.text.length > PAGE_CHARS
    return `[${source.n}] ${source.title}\n网址：${url}\n\n${page.text.slice(0, PAGE_CHARS)}${cut ? '\n\n（正文过长，后面的部分没有读到）' : ''}`
  }

  return {
    specs: WEB_TOOL_SPECS,
    async *run(call: ToolCall, signal: AbortSignal) {
      const input = (call.input ?? {}) as Record<string, unknown>
      try {
        if (call.name === 'web_search') return yield* runSearch(input, signal)
        if (call.name === 'read_page') return yield* runRead(input, signal)
        return `没有名为 ${call.name} 的工具。`
      } catch (err) {
        // A cancel must end the reply; anything else is told to the model, which can answer without it.
        if (signal.aborted) throw err
        const message = err instanceof Error ? err.message : String(err)
        return `${call.name === 'read_page' ? '读取网页' : '搜索'}失败：${message}`
      }
    }
  }
}
