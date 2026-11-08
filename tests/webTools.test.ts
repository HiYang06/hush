import { describe, expect, it } from 'vitest'
import type { StreamEvent } from '@shared/types'
import { cleanText, dayOf, type Hit } from '../src/main/search/services'
import { createWebTools, mergeHits, normalizeUrl } from '../src/main/search/webTools'

function hit(url: string, title = url): Hit {
  return { url, title, date: null, text: `关于 ${title} 的片段` }
}

describe('mergeHits', () => {
  it('alternates between services, drops the same page reached by another link, and keeps at most 8', () => {
    const tavily = [hit('https://a.com/x'), hit('https://b.com'), hit('https://c.com')]
    const exa = [hit('https://www.a.com/x/?utm_source=exa#top'), hit('https://d.com')]
    expect(mergeHits([tavily, exa]).map((h) => h.url)).toEqual([
      'https://a.com/x',
      'https://b.com',
      'https://d.com',
      'https://c.com'
    ])
    const many = Array.from({ length: 12 }, (_, i) => hit(`https://s${i}.com`))
    expect(mergeHits([many])).toHaveLength(8)
  })

  it('normalizes links but keeps meaningful query parameters', () => {
    expect(normalizeUrl('https://WWW.Example.com/a/?utm_medium=x&id=3#frag')).toBe('example.com/a?id=3')
  })
})

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> }

// Answers like the services do, keyed by host and path.
function fakeFetch(routes: Record<string, (body: Record<string, unknown>) => unknown | Error>) {
  const calls: Call[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body))
    calls.push({ url, body, headers: init?.headers as Record<string, string> })
    const route = routes[url]
    const result = route ? route(body) : new Error('no route')
    if (result instanceof Error) return new Response(result.message, { status: 401 })
    return new Response(JSON.stringify(result), { status: 200 })
  }) as typeof fetch
  return { fn, calls }
}

async function drain(gen: AsyncGenerator<StreamEvent, string>): Promise<{ events: StreamEvent[]; output: string }> {
  const events: StreamEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, output: next.value }
}

const signal = new AbortController().signal

describe('service text', () => {
  it('reads both services\' date formats as a day', () => {
    expect(dayOf('Tue, 06 Oct 2026 08:00:00 GMT')).toBe('2026-10-06')
    expect(dayOf('2026-10-01T00:00:00.000Z')).toBe('2026-10-01')
    expect(dayOf('not a date')).toBeNull()
    expect(dayOf(null)).toBeNull()
  })

  it('drops markdown images and runs of blank lines', () => {
    expect(cleanText('![logo](https://x/a.png)\n\n\n\n# 标题\n![](b.svg)正文')).toBe('# 标题\n正文')
  })
})

describe('createWebTools', () => {
  const tavilyResults = {
    results: [
      { url: 'https://a.com', title: 'A 站', content: '甲的内容', published_date: '2026-10-20T08:00:00Z' },
      { url: 'https://b.com', title: 'B 站', content: '乙的内容' }
    ]
  }

  it('searches every configured service, numbers the sources and reports them once', async () => {
    const { fn, calls } = fakeFetch({
      'https://api.tavily.com/search': () => tavilyResults,
      'https://api.exa.ai/search': () => ({
        results: [{ url: 'https://c.com', title: 'C 站', publishedDate: '2026-10-01', highlights: ['丙一', '丙二'] }]
      })
    })
    const tools = createWebTools({ tavily: 'tk', exa: 'ek' }, fn)

    const first = await drain(tools.run({ id: '1', name: 'web_search', input: { query: '特征值 应用', recency: 'month' } }, signal))
    expect(first.events).toEqual([
      { type: 'step', step: { type: 'search', query: '特征值 应用' } },
      {
        type: 'sources',
        sources: [
          { n: 1, url: 'https://a.com', title: 'A 站', date: '2026-10-20', snippet: '甲的内容' },
          { n: 2, url: 'https://c.com', title: 'C 站', date: '2026-10-01', snippet: '丙一 … 丙二' },
          { n: 3, url: 'https://b.com', title: 'B 站', date: null, snippet: '乙的内容' }
        ]
      }
    ])
    expect(first.output).toContain('[1] A 站\n网址：https://a.com\n日期：2026-10-20\n甲的内容')
    expect(calls[0].headers.authorization).toBe('Bearer tk')
    expect(calls[0].body).toMatchObject({ query: '特征值 应用', time_range: 'month', search_depth: 'advanced' })
    expect(calls[1].headers['x-api-key']).toBe('ek')
    expect(calls[1].body.startPublishedDate).toEqual(expect.any(String))

    // A page found again keeps its number and isn't reported as new.
    const second = await drain(tools.run({ id: '2', name: 'web_search', input: { query: '再搜' } }, signal))
    expect(second.events.filter((e) => e.type === 'sources')).toEqual([])
    expect(second.output).toContain('[1] A 站')
  })

  it('reads a page as a numbered source, reusing the number of a page it already found', async () => {
    const { fn } = fakeFetch({
      'https://api.tavily.com/search': () => tavilyResults,
      'https://api.tavily.com/extract': (body) => ({
        results: [{ url: (body.urls as string[])[0], raw_content: '正文'.repeat(20_000) }],
        failed_results: []
      })
    })
    const tools = createWebTools({ tavily: 'tk' }, fn)
    await drain(tools.run({ id: '1', name: 'web_search', input: { query: 'q' } }, signal))

    const known = await drain(tools.run({ id: '2', name: 'read_page', input: { url: 'https://b.com/' } }, signal))
    expect(known.events).toEqual([{ type: 'step', step: { type: 'read', url: 'https://b.com/' } }])
    expect(known.output.startsWith('[2] B 站\n网址：https://b.com/')).toBe(true)
    expect(known.output).toContain('后面的部分没有读到')

    const fresh = await drain(tools.run({ id: '3', name: 'read_page', input: { url: 'https://new.com/post' } }, signal))
    expect(fresh.events[1]).toMatchObject({ type: 'sources', sources: [{ n: 3, title: 'new.com' }] })
  })

  it('tells the model when a search fails instead of failing the reply, and uses the service that works', async () => {
    const { fn } = fakeFetch({
      'https://api.tavily.com/search': () => new Error('invalid key'),
      'https://api.exa.ai/search': () => ({ results: [{ url: 'https://c.com', title: 'C', highlights: ['丙'] }] })
    })
    const both = createWebTools({ tavily: 'bad', exa: 'ek' }, fn)
    expect((await drain(both.run({ id: '1', name: 'web_search', input: { query: 'q' } }, signal))).output).toContain('[1] C')

    const tavilyOnly = createWebTools({ tavily: 'bad' }, fn)
    const failed = await drain(tavilyOnly.run({ id: '1', name: 'web_search', input: { query: 'q' } }, signal))
    expect(failed.output).toMatch(/^搜索失败：api\.tavily\.com 401: invalid key/)

    const noQuery = await drain(tavilyOnly.run({ id: '2', name: 'web_search', input: {} }, signal))
    expect(noQuery).toEqual({ events: [], output: '缺少搜索词 query。' })
    expect((await drain(tavilyOnly.run({ id: '3', name: 'read_page', input: { url: 'file:///etc/passwd' } }, signal))).output).toMatch(/^网址无效/)
  })

  it('a cancel ends the run instead of becoming a message to the model', async () => {
    const controller = new AbortController()
    const fn = (async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }) as typeof fetch
    const tools = createWebTools({ tavily: 'tk' }, fn)
    await expect(drain(tools.run({ id: '1', name: 'web_search', input: { query: 'q' } }, controller.signal))).rejects.toThrow('aborted')
  })
})
