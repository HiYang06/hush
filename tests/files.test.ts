import { existsSync, mkdtempSync, readdirSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { countImages, detectMime, planFile, PPTX_MIME, sentFileIds } from '@shared/files'
import type { DocumentPage, ExtractedPart, FileRecord, Message } from '@shared/types'
import { openDb } from '../src/main/db'
import { getFile } from '../src/main/db/repo/files'
import { createFileStore, type Download } from '../src/main/files/store'

function store(download: Download = async () => Buffer.alloc(0)) {
  const db = openDb(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'hush-'))
  return { db, dir, files: createFileStore(db, dir, download) }
}

describe('file store', () => {
  it('downloads a file that is only metadata here, once however many ask, and leaves no partial file', async () => {
    let calls = 0
    const { db, dir, files } = store(async () => {
      calls++
      return Buffer.from('来自另一台设备')
    })
    const record = files.add({ name: 'a.txt', mime: 'text/plain', data: new TextEncoder().encode('来自另一台设备'), extracted: null, isScanned: null })
    await files.ensure(record)
    expect(calls).toBe(0)

    unlinkSync(join(dir, record.path))
    await Promise.all([files.ensure(record), files.ensure(getFile(db, record.id))])
    expect(calls).toBe(1)
    expect(files.read(record).toString()).toBe('来自另一台设备')
    expect(readdirSync(dir)).toEqual([record.path])
  })

  it('passes on why a download failed, and tries again next time', async () => {
    let fail = true
    const { dir, files } = store(async () => {
      if (fail) throw new Error('这个附件还没下载到这台设备，联网后再试')
      return Buffer.from('x')
    })
    const record = files.add({ name: 'a.txt', mime: 'text/plain', data: new TextEncoder().encode('x'), extracted: null, isScanned: null })
    unlinkSync(join(dir, record.path))
    await expect(files.ensure(record)).rejects.toThrow('联网后再试')
    fail = false
    await files.ensure(record)
    expect(files.read(record).toString()).toBe('x')
  })

  it('stores identical content once, named by its sha256 with the extension kept', () => {
    const { dir, files } = store()
    const data = new TextEncoder().encode('# 笔记')
    const first = files.add({ name: '笔记.md', mime: 'text/plain', data, extracted: [{ type: 'text', text: '# 笔记' }], isScanned: null })
    const again = files.add({ name: '另一个名字.md', mime: 'text/plain', data, extracted: [{ type: 'text', text: '# 笔记' }], isScanned: null })

    expect(again).toEqual(first)
    expect(first.path).toBe(`${first.sha256}.md`)
    expect(existsSync(join(dir, first.path))).toBe(true)
    expect(files.read(first).toString()).toBe('# 笔记')
  })

  it('takes the new extraction when the same file is added again', () => {
    const { db, files } = store()
    const data = new Uint8Array([1, 2, 3])
    const old = files.add({ name: 'a.pdf', mime: 'application/pdf', data, extracted: [{ type: 'text', text: '正文' }], isScanned: false })
    const extracted = [{ type: 'text' as const, text: '## 第 1 页\n正文' }, { type: 'image' as const, fileId: 'p1' }]
    const again = files.add({ name: 'b.pdf', mime: 'application/pdf', data, extracted, isScanned: false })

    expect(again.id).toBe(old.id)
    expect(again.name).toBe('a.pdf')
    expect(getFile(db, old.id).extracted).toEqual(extracted)
  })

  it('keeps is_scanned as a boolean', () => {
    const { files } = store()
    const pdf = files.add({ name: 'a.pdf', mime: 'application/pdf', data: new Uint8Array([1]), extracted: [], isScanned: true })
    expect(pdf.isScanned).toBe(true)
  })
})

describe('detectMime', () => {
  it('decides by extension, since browsers leave code files untyped', () => {
    expect(detectMime('a.JPG', '')).toBe('image/jpeg')
    expect(detectMime('main.py', '')).toBe('text/plain')
    expect(detectMime('slides.pptx', '')).toBe(PPTX_MIME)
    expect(detectMime('notes', 'text/plain')).toBe('text/plain')
    expect(detectMime('book.epub', 'application/epub+zip')).toBeNull()
  })
})

describe('planFile', () => {
  const record = (extra: Partial<FileRecord>): FileRecord => ({
    id: 'f',
    sha256: 'f',
    name: 'f',
    mime: 'image/png',
    size: 1,
    path: 'f',
    extracted: null,
    isScanned: null,
    createdAt: 0,
    ...extra
  })
  const none = { supportsVision: false, supportsTools: false }

  it('blocks an image, and a scanned PDF, the model cannot take', () => {
    expect(planFile(record({}), none).blocked).toBe('当前模型不能看图')
    expect(planFile(record({ mime: 'application/pdf', isScanned: true }), none).blocked).not.toBeNull()
    expect(planFile(record({ mime: 'application/pdf', isScanned: false }), none).blocked).toBeNull()
  })

  it('counts the images a message would send', () => {
    const deck = record({ mime: PPTX_MIME, extracted: [{ type: 'image', fileId: 'a' }, { type: 'image', fileId: 'b' }] })
    const vision = { supportsVision: true, supportsTools: false }
    expect(countImages([planFile(deck, vision), planFile(record({}), vision)])).toBe(3)
    expect(countImages([planFile(deck, none)])).toBe(0)
  })

  const pages = (count: number, extra: (n: number) => Partial<DocumentPage> = () => ({})): ExtractedPart[] =>
    Array.from({ length: count }, (_, i) => ({ type: 'page', n: i + 1, title: '', text: '', tags: [], imageIds: [], ...extra(i + 1) }))

  it('gives a model with tools only the outline and page map of a document, never its text or images', () => {
    const paper = record({
      name: 'paper.pdf',
      mime: 'application/pdf',
      isScanned: false,
      extracted: [
        {
          type: 'outline',
          entries: [
            { title: '1 Introduction', page: 1, depth: 0 },
            { title: '1.1 Motivation', page: 2, depth: 1 },
            { title: '2 Method', page: 4, depth: 0 }
          ]
        },
        ...pages(5, (n) => (n === 3 ? { title: 'Attention', text: '注意力 机制', tags: ['figure', 'math'], imageIds: ['p3'] } : {}))
      ]
    })
    const plan = planFile(paper, { supportsVision: true, supportsTools: true })
    expect(plan).toEqual({
      blocked: null,
      parts: [
        {
          type: 'text',
          text: [
            '[文档：paper.pdf，共 5 页。这里只有目录和页面地图，没有正文]',
            '涉及文档内容时，先用 search_document 检索，或用 read_document_pages 翻阅对应的页，依据读到的内容回答，并注明页码。',
            '',
            '目录：',
            '- 1 Introduction（第 1–3 页）',
            '  - 1.1 Motivation（第 2–3 页）',
            '- 2 Method（第 4–5 页）',
            '',
            '页面：',
            '第 1 页 · 0 字',
            '第 2 页 · 0 字',
            '第 3 页 · Attention · 5 字 · 图、公式',
            '第 4 页 · 0 字',
            '第 5 页 · 0 字'
          ].join('\n')
        }
      ]
    })
    expect(countImages([plan])).toBe(0)
  })

  it('sends a document whole to a model without tools, with the first 20 page images', () => {
    const deck = record({ name: 'd.pptx', mime: PPTX_MIME, extracted: pages(25, (n) => ({ text: `第${n}页`, imageIds: [`i${n}`] })) })
    const plan = planFile(deck, { supportsVision: true, supportsTools: false })
    expect(countImages([plan])).toBe(20)
    expect(plan.parts.at(-1)).toEqual({ type: 'text', text: '（第 21、22、23、24、25 页的图片没有附上）' })
    expect(plan.parts.slice(0, 3)).toEqual([
      { type: 'text', text: '[文件：d.pptx]' },
      { type: 'text', text: '## 第 1 页\n第1页' },
      { type: 'image', fileId: 'i1' }
    ])
  })

  it('tells a model with tools that a scan has no text to search, and still blocks one that cannot see', () => {
    const scan = record({ name: 's.pdf', mime: 'application/pdf', isScanned: true, extracted: pages(2, (n) => ({ imageIds: [`i${n}`] })) })
    const plan = planFile(scan, { supportsVision: true, supportsTools: true })
    expect(plan.parts[0]).toMatchObject({ text: expect.stringContaining('这是扫描件，没有文字层') })
    expect(plan.parts[0]).toMatchObject({ text: expect.not.stringContaining('页面：') })
    expect(planFile(scan, { supportsVision: false, supportsTools: true }).blocked).not.toBeNull()
  })
})

describe('sentFileIds', () => {
  const sent = (id: string, createdAt: number, fileIds: string[]): Message => ({
    id,
    sessionId: 's',
    seq: 0,
    role: 'user',
    content: '',
    thinking: null,
    thinkingMs: null,
    attachments: fileIds.map((fileId) => ({ type: 'file', fileId })),
    status: 'done',
    error: null,
    errorKind: null,
    providerId: null,
    modelId: null,
    inputTokens: null,
    outputTokens: null,
    web: null,
    createdAt
  })

  it('lists files in the order first sent, each once, skipping other attachments', () => {
    const withRef: Message = {
      ...sent('m3', 2, ['c']),
      attachments: [{ type: 'note_ref', noteId: 'n', sectionTitle: null, label: 'x', text: 'x' }, { type: 'file', fileId: 'c' }]
    }
    // A thread's message is sent later than the main message after it in the list.
    expect(sentFileIds([sent('m2', 3, ['b', 'a']), sent('m1', 1, ['a']), withRef])).toEqual(['a', 'c', 'b'])
  })
})
