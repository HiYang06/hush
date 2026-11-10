import { documentPages, TAG_NAMES } from '@shared/files'
import type { DocumentPage, FileRecord, StreamEvent } from '@shared/types'
import type { LoadedFile } from './context'
import type { ToolCall, ToolImage, ToolOutput, Tools, ToolSpec } from './types'

export const MAX_SEARCH_HITS = 8
export const MAX_READ_PAGES = 8
const SNIPPET_CONTEXT = 40

// The model's instructions live in the tool descriptions, like the web tools (D-052): the context only
// carries each document's page map (D-077).
export const DOCUMENT_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'search_document',
    description: [
      '在用户附上的 PDF 或 pptx 里按关键词检索，返回最相关的页（最多 8 页）、每页的标题、有没有图表公式，以及命中处前后的片段。',
      '用于找某个概念、定义、结论、公式或图表在哪几页。片段只是线索：回答前用 read_document_pages 读这些页。',
      '关键词用文档里可能出现的原词；中英文术语都可以试，没搜到就换同义词或更短的词。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件名，和上下文里「[文档：…]」写的一样' },
        query: { type: 'string', description: '关键词，几个词用空格隔开' }
      },
      required: ['file', 'query']
    }
  },
  {
    name: 'read_document_pages',
    description: [
      '读用户附上的 PDF 或 pptx 的连续几页，一次最多 8 页。返回这几页的文字；有图、表或公式的页附上整页图片，这时以图片为准。',
      '用户问到某页、某章（页码见目录和页面地图），或检索到相关页之后用它。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件名，和上下文里「[文档：…]」写的一样' },
        start_page: { type: 'integer', description: '第一页的页码，从 1 开始' },
        end_page: { type: 'integer', description: '最后一页的页码（包含）' }
      },
      required: ['file', 'start_page', 'end_page']
    }
  }
]

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu

// Words for Latin script; for CJK, which has no spaces, every two adjacent characters (a lone
// character stays one token). Needs no dictionary, and a two-character word always matches itself.
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const [run] of text.toLowerCase().matchAll(TOKEN)) {
    if (!CJK_RUN.test(run)) {
      tokens.push(run)
      continue
    }
    const chars = [...run]
    if (chars.length === 1) tokens.push(run)
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1])
  }
  return tokens
}

const K1 = 1.2
const B = 0.75

export type Hit = { page: DocumentPage; score: number; terms: string[] }

// Okapi BM25 over the pages of one document, title included. Built once per document per reply.
export function createPageIndex(pages: DocumentPage[]): (query: string) => Hit[] {
  const docs = pages.map((page) => {
    const tf = new Map<string, number>()
    const tokens = tokenize(`${page.title}\n${page.text}`)
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    return { page, tf, length: tokens.length }
  })
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1) || 1
  const idf = (t: string): number => {
    const n = df.get(t) ?? 0
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
  }

  return (query) => {
    // Rarest first, so the snippet shows the most telling term.
    const terms = [...new Set(tokenize(query))].sort((a, b) => idf(b) - idf(a))
    const hits: Hit[] = []
    for (const d of docs) {
      let score = 0
      const matched: string[] = []
      for (const t of terms) {
        const f = d.tf.get(t)
        if (!f) continue
        matched.push(t)
        score += (idf(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / avgLength))
      }
      if (score > 0) hits.push({ page: d.page, score, terms: matched })
    }
    return hits.sort((a, b) => b.score - a.score || a.page.n - b.page.n).slice(0, MAX_SEARCH_HITS)
  }
}

// The text around the first place the rarest matched term appears.
export function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  for (const term of terms) {
    const at = lower.indexOf(term)
    if (at < 0) continue
    const start = Math.max(0, at - SNIPPET_CONTEXT)
    const end = Math.min(text.length, at + term.length + SNIPPET_CONTEXT)
    const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
    return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
  }
  return ''
}

function tagText(page: DocumentPage): string {
  return page.tags.map((t) => TAG_NAMES[t]).join('、')
}

function pageHeader(page: DocumentPage): string {
  return [`## 第 ${page.n} 页`, page.title].filter(Boolean).join(' · ')
}

function integer(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null
}

// One instance per reply. documents: the PDFs and pptx this conversation reads by tool; files: every
// loaded file, which includes their page images.
export function createDocumentTools(
  documents: FileRecord[],
  files: Map<string, LoadedFile>,
  supportsVision: boolean
): Tools<string | ToolOutput> {
  const indexes = new Map<string, (query: string) => Hit[]>()

  // By exact name, then ignoring case; with a single document any name will do.
  function find(name: unknown): FileRecord | string {
    const wanted = typeof name === 'string' ? name.trim() : ''
    const found =
      documents.find((d) => d.name === wanted) ??
      documents.find((d) => d.name.toLowerCase() === wanted.toLowerCase()) ??
      (documents.length === 1 ? documents[0] : undefined)
    return found ?? `没有名为「${wanted}」的文档。可用的文档：${documents.map((d) => `「${d.name}」`).join('、')}。`
  }

  async function* runSearch(input: Record<string, unknown>): AsyncGenerator<StreamEvent, string> {
    const doc = find(input.file)
    if (typeof doc === 'string') return doc
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) return '缺少关键词 query。'
    yield { type: 'step', step: { type: 'doc_search', file: doc.name, query } }
    if (doc.isScanned) return `「${doc.name}」是扫描件，没有文字可以检索。用 read_document_pages 直接翻阅页面图片。`
    let search = indexes.get(doc.id)
    if (!search) {
      search = createPageIndex(documentPages(doc))
      indexes.set(doc.id, search)
    }
    const hits = search(query)
    if (hits.length === 0) return `在「${doc.name}」里没有检索到「${query}」。可以换个说法、同义词或更短的词再试。`
    const entries = hits.map(({ page, terms }) => {
      const head = [`第 ${page.n} 页`, page.title, tagText(page) && `含${tagText(page)}`].filter(Boolean).join(' · ')
      const text = snippet(page.text, terms)
      return text ? `${head}\n${text}` : head
    })
    return `在「${doc.name}」里检索「${query}」，最相关的页（片段只是线索，用 read_document_pages 读全文）：\n\n${entries.join('\n\n')}`
  }

  async function* runRead(input: Record<string, unknown>): AsyncGenerator<StreamEvent, string | ToolOutput> {
    const doc = find(input.file)
    if (typeof doc === 'string') return doc
    const pages = documentPages(doc)
    const from = integer(input.start_page)
    const to = integer(input.end_page) ?? from
    if (from === null || to === null) return '缺少页码 start_page、end_page。'
    const first = Math.max(1, Math.min(from, to))
    if (first > pages.length) return `「${doc.name}」一共只有 ${pages.length} 页。`
    const wantedLast = Math.min(pages.length, Math.max(from, to))
    const last = Math.min(wantedLast, first + MAX_READ_PAGES - 1)
    yield { type: 'step', step: { type: 'doc_read', file: doc.name, start: first, end: last } }

    const sections: string[] = []
    const images: ToolImage[] = []
    for (const page of pages.slice(first - 1, last)) {
      const lines = [pageHeader(page)]
      const seen = supportsVision && page.imageIds.length > 0
      if (seen) {
        const what = tagText(page)
        lines.push(
          doc.isScanned
            ? '（扫描页，内容见整页图片）'
            : `（这页有${what || '图'}，以整页图片为准；下面的文字是自动提取的，公式和表格可能错位）`
        )
        page.imageIds.forEach((id, i) => {
          const file = files.get(id)
          if (!file) throw new Error(`Page image ${id} was not loaded`)
          const which = page.imageIds.length > 1 ? ` 图 ${i + 1}` : ''
          images.push({ label: `[${doc.name} 第 ${page.n} 页${which}]`, mime: file.record.mime, data: file.data() })
        })
      } else if (page.tags.length > 0) {
        lines.push(`（这页有${tagText(page)}，当前模型看不到图片，只有自动提取的文字）`)
      }
      if (page.text) lines.push(page.text)
      sections.push(lines.join('\n'))
    }
    if (last < wantedLast) {
      sections.push(`（一次最多读 ${MAX_READ_PAGES} 页，这次读到第 ${last} 页；需要的话从第 ${last + 1} 页接着读）`)
    }
    const range = first === last ? `第 ${first} 页` : `第 ${first}–${last} 页`
    const text = `「${doc.name}」${range}（共 ${pages.length} 页）：\n\n${sections.join('\n\n')}`
    return images.length > 0 ? { text, images } : text
  }

  return {
    specs: DOCUMENT_TOOL_SPECS,
    async *run(call: ToolCall) {
      const input = (call.input ?? {}) as Record<string, unknown>
      if (call.name === 'search_document') return yield* runSearch(input)
      if (call.name === 'read_document_pages') return yield* runRead(input)
      return `没有名为 ${call.name} 的工具。`
    }
  }
}
