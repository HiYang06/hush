import type { SearchServiceId } from '@shared/types'

export type Recency = 'day' | 'week' | 'month' | 'year'

// One search result, whichever service found it.
export type Hit = { url: string; title: string; date: string | null; text: string }

export type Page = { url: string; title: string | null; text: string }

export type SearchKeys = Partial<Record<SearchServiceId, string>>

type Fetch = typeof fetch

// Per result; Tavily's `advanced` joins up to three relevant passages, Exa's highlights are capped the same.
const SNIPPET_CHARS = 1_500

// Tavily sends dates like "Tue, 06 Oct 2026 08:00:00 GMT", Exa sends ISO; both become 2026-10-06.
export function dayOf(date: string | null | undefined): string | null {
  if (!date) return null
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

// Markdown images are icons and avatars the model can't see; on a typical page they are a quarter of the text.
export function cleanText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function post(fetchFn: Fetch, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

type TavilySearch = { results: { url: string; title: string; content: string; published_date?: string | null }[] }

export async function tavilySearch(
  fetchFn: Fetch,
  key: string,
  query: string,
  recency: Recency | null,
  signal: AbortSignal
): Promise<Hit[]> {
  const data = (await post(
    fetchFn,
    'https://api.tavily.com/search',
    { authorization: `Bearer ${key}` },
    {
      query,
      search_depth: 'advanced',
      chunks_per_source: 3,
      max_results: 8,
      include_published_date: true,
      ...(recency && { time_range: recency })
    },
    signal
  )) as TavilySearch
  return data.results.map((r) => ({
    url: r.url,
    title: r.title,
    date: dayOf(r.published_date),
    text: cleanText(r.content).slice(0, SNIPPET_CHARS)
  }))
}

const RECENCY_DAYS: Record<Recency, number> = { day: 1, week: 7, month: 31, year: 366 }

type ExaSearch = { results: { url: string; title: string | null; publishedDate?: string | null; highlights?: string[] }[] }

export async function exaSearch(
  fetchFn: Fetch,
  key: string,
  query: string,
  recency: Recency | null,
  signal: AbortSignal,
  now = Date.now()
): Promise<Hit[]> {
  const data = (await post(
    fetchFn,
    'https://api.exa.ai/search',
    { 'x-api-key': key },
    {
      query,
      type: 'auto',
      numResults: 8,
      contents: { highlights: { maxCharacters: SNIPPET_CHARS } },
      ...(recency && {
        startPublishedDate: new Date(now - RECENCY_DAYS[recency] * 86_400_000).toISOString()
      })
    },
    signal
  )) as ExaSearch
  return data.results.map((r) => ({
    url: r.url,
    title: r.title || r.url,
    date: dayOf(r.publishedDate),
    text: cleanText((r.highlights ?? []).join(' … '))
  }))
}

type TavilyExtract = { results: { url: string; raw_content: string }[]; failed_results: { url: string; error: string }[] }

export async function tavilyExtract(fetchFn: Fetch, key: string, url: string, signal: AbortSignal): Promise<Page> {
  const data = (await post(
    fetchFn,
    'https://api.tavily.com/extract',
    { authorization: `Bearer ${key}` },
    { urls: [url], format: 'markdown' },
    signal
  )) as TavilyExtract
  // A page that can't be read is still a 200, listed under failed_results.
  const page = data.results[0]
  if (!page) throw new Error(data.failed_results[0]?.error ?? 'The page could not be read.')
  return { url: page.url, title: null, text: cleanText(page.raw_content) }
}

type ExaContents = { results: { url: string; title: string | null; text?: string }[] }

export async function exaContents(fetchFn: Fetch, key: string, url: string, signal: AbortSignal, maxChars: number): Promise<Page> {
  const data = (await post(
    fetchFn,
    'https://api.exa.ai/contents',
    { 'x-api-key': key },
    { urls: [url], text: { maxCharacters: maxChars } },
    signal
  )) as ExaContents
  const page = data.results[0]
  if (!page?.text) throw new Error('The page could not be read.')
  return { url: page.url, title: page.title, text: cleanText(page.text) }
}
