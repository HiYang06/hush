import { describe, expect, it } from 'vitest'
import type { DocumentPage, FileRecord, StreamEvent } from '@shared/types'
import type { LoadedFile } from '../src/main/llm/context'
import { createDocumentTools, createPageIndex, snippet, tokenize } from '../src/main/llm/documentTools'
import type { ToolOutput } from '../src/main/llm/types'

function page(n: number, title: string, text: string, extra: Partial<DocumentPage> = {}): DocumentPage {
  return { n, title, text, tags: [], imageIds: [], ...extra }
}

function doc(name: string, pages: DocumentPage[], isScanned = false): FileRecord {
  return {
    id: name,
    sha256: name,
    name,
    mime: 'application/pdf',
    size: 1,
    path: name,
    extracted: pages.map((p) => ({ type: 'page' as const, ...p })),
    isScanned,
    createdAt: 0
  }
}

async function run(gen: AsyncGenerator<StreamEvent, string | ToolOutput>) {
  const events: StreamEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, output: next.value }
}

const signal = new AbortController().signal

describe('tokenize', () => {
  it('splits Latin into words and CJK into overlapping pairs', () => {
    expect(tokenize('Self-Attention 机制')).toEqual(['self', 'attention', '机制'])
    expect(tokenize('特征值分解')).toEqual(['特征', '征值', '值分', '分解'])
    expect(tokenize('秩')).toEqual(['秩'])
  })
})

describe('page index', () => {
  const pages = [
    page(1, '引言', '本课介绍矩阵。'),
    page(2, '特征值', '特征值和特征向量的定义。特征值满足 Av = λv。'),
    page(3, '应用', '主成分分析用到协方差矩阵的特征值。')
  ]

  it('ranks the page that is about the term above one that mentions it', () => {
    const search = createPageIndex(pages)
    expect(search('特征值').map((h) => h.page.n)).toEqual([2, 3])
    expect(search('傅里叶')).toEqual([])
  })

  it('cuts a snippet around the first match, marking the cuts', () => {
    const text = `${'甲'.repeat(60)}特征值${'乙'.repeat(60)}`
    expect(snippet(text, ['特征'])).toBe(`…${'甲'.repeat(40)}特征${'值' + '乙'.repeat(39)}…`)
  })
})

describe('document tools', () => {
  const pages = Array.from({ length: 12 }, (_, i) =>
    page(i + 1, `第${i + 1}节`, `内容${i + 1}`, i === 2 ? { tags: ['math'], imageIds: ['img3'] } : {})
  )
  const lecture = doc('lecture.pdf', pages)
  const files = new Map<string, LoadedFile>([
    [
      'img3',
      { record: { ...lecture, id: 'img3', name: 'lecture-3.jpg', mime: 'image/jpeg', extracted: null }, data: () => Buffer.from('p3') }
    ]
  ])

  it('searches by file name and reports the step', async () => {
    const tools = createDocumentTools([lecture], files, true)
    const { events, output } = await run(tools.run({ id: '1', name: 'search_document', input: { file: 'lecture.pdf', query: '内容3' } }, signal))
    expect(events).toEqual([{ type: 'step', step: { type: 'doc_search', file: 'lecture.pdf', query: '内容3' } }])
    expect(output).toContain('第 3 页 · 第3节 · 含公式')
  })

  it('reads at most 8 pages, with the page image for a model that can see', async () => {
    const tools = createDocumentTools([lecture], files, true)
    const { events, output } = await run(
      tools.run({ id: '1', name: 'read_document_pages', input: { file: 'LECTURE.PDF', start_page: 2, end_page: 20 } }, signal)
    )
    expect(events).toEqual([{ type: 'step', step: { type: 'doc_read', file: 'lecture.pdf', start: 2, end: 9 } }])
    const { text, images } = output as ToolOutput
    expect(text).toMatch(/^「lecture\.pdf」第 2–9 页（共 12 页）/)
    expect(text).toContain('## 第 3 页 · 第3节\n（这页有公式，以整页图片为准')
    expect(text).toContain('从第 10 页接着读')
    expect(images).toEqual([{ label: '[lecture.pdf 第 3 页]', mime: 'image/jpeg', data: Buffer.from('p3') }])
  })

  it('without vision, says the page has a formula it cannot see and sends text only', async () => {
    const tools = createDocumentTools([lecture], files, false)
    const { output } = await run(tools.run({ id: '1', name: 'read_document_pages', input: { file: 'lecture.pdf', start_page: 3, end_page: 3 } }, signal))
    expect(output).toBe('「lecture.pdf」第 3 页（共 12 页）：\n\n## 第 3 页 · 第3节\n（这页有公式，当前模型看不到图片，只有自动提取的文字）\n内容3')
  })

  it('tells the model what went wrong instead of failing', async () => {
    const other = doc('other.pdf', [page(1, '', '')])
    const tools = createDocumentTools([lecture, other], files, true)
    const missing = await run(tools.run({ id: '1', name: 'search_document', input: { file: 'x.pdf', query: 'a' } }, signal))
    expect(missing.output).toBe('没有名为「x.pdf」的文档。可用的文档：「lecture.pdf」、「other.pdf」。')
    const beyond = await run(tools.run({ id: '1', name: 'read_document_pages', input: { file: 'other.pdf', start_page: 5, end_page: 6 } }, signal))
    expect(beyond.output).toBe('「other.pdf」一共只有 1 页。')
    const scanned = createDocumentTools([doc('scan.pdf', [page(1, '', '')], true)], files, true)
    const search = await run(scanned.run({ id: '1', name: 'search_document', input: { file: 'scan.pdf', query: 'a' } }, signal))
    expect(search.output).toContain('是扫描件')
  })
})
