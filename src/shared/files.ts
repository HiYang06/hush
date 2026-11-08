// Pure and shared: context.ts uses planFile to build the request, and the input box uses it to block a
// send the model can't take, so the two can never disagree.
import type { DocumentPage, FileRecord, Message, Model, OutlineEntry, PageTag } from './types'

export type FileKind = 'image' | 'pdf' | 'docx' | 'pptx' | 'text'

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

// Limits from D-038.
export const MAX_IMAGES_PER_MESSAGE = 20
// Page images sent with a document whole, to a model without tools (D-077).
export const MAX_DOCUMENT_PAGE_IMAGES = 20
export const IMAGE_MAX_EDGE = 1568
export const SCANNED_CHARS_PER_PAGE = 20
// A page with this many characters in math fonts gets a page image (D-057, lowered in D-077).
export const PDF_MATH_CHARS = 15
// A page drawing this many more vector paths than the document's quietest page has a figure, even
// without a caption (D-077). Slide templates alone draw 10–15 paths on every page.
export const PDF_VECTOR_PATHS = 50
export const MIN_SLIDE_IMAGE_BYTES = 10 * 1024

const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown csv tsv json jsonl yaml yml toml xml html htm css scss js mjs cjs ts tsx jsx ' +
    'py ipynb rb go rs java kt swift c h cpp hpp cc cs php sh zsh bash sql r m lua tex bib ini cfg log'
  ).split(' ')
)

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

// The mime Hush stores for a file, decided by its extension: browsers report an empty type for most
// code files. null means the file type isn't supported.
export function detectMime(name: string, reportedMime: string): string | null {
  const ext = extension(name)
  if (IMAGE_MIMES[ext]) return IMAGE_MIMES[ext]
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'docx') return DOCX_MIME
  if (ext === 'pptx') return PPTX_MIME
  if (TEXT_EXTENSIONS.has(ext) || reportedMime.startsWith('text/')) return 'text/plain'
  return null
}

export function fileKind(mime: string): FileKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === DOCX_MIME) return 'docx'
  if (mime === PPTX_MIME) return 'pptx'
  return 'text'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Number((bytes / 1024 / 1024 / 1024).toFixed(1))} GB`
}

export const fileUrl = (id: string): string => `hush-file://${id}`

export type PlannedPart =
  | { type: 'text'; text: string }
  | { type: 'image'; fileId: string }

// blocked: why this file can't go to this model. In history the parts (a text placeholder) are sent
// anyway; in the message being written the input box refuses to send.
export type FilePlan = { parts: PlannedPart[]; blocked: string | null }

type Capabilities = Pick<Model, 'supportsVision' | 'supportsTools'>

export const TAG_NAMES: Record<PageTag, string> = { figure: '图', table: '表', math: '公式', image: '图片' }

export function documentPages(file: FileRecord): DocumentPage[] {
  return (file.extracted ?? []).flatMap((p) => (p.type === 'page' ? [p] : []))
}

function outlineOf(file: FileRecord): OutlineEntry[] {
  return (file.extracted ?? []).flatMap((p) => (p.type === 'outline' ? p.entries : []))
}

// A document the model reads through search_document / read_document_pages instead of whole (D-077).
export function readsByTool(file: FileRecord, caps: Capabilities): boolean {
  return caps.supportsTools && documentPages(file).length > 0
}

export function charCount(text: string): number {
  return text.replace(/\s/g, '').length
}

function pageRange(first: number, last: number): string {
  return first === last ? `第 ${first} 页` : `第 ${first}–${last} 页`
}

// A bookmark runs until the next one at its level or above starts.
function outlineLines(entries: OutlineEntry[], pageCount: number): string[] {
  return entries.map((e, i) => {
    const next = entries.slice(i + 1).find((later) => later.depth <= e.depth)
    const last = Math.max(e.page, (next?.page ?? pageCount + 1) - 1)
    return `${'  '.repeat(e.depth)}- ${e.title}（${pageRange(e.page, last)}）`
  })
}

// What the context carries for a document read by tool: its outline and one line per page, never the
// text. Built from the stored record only, so it is byte-identical every turn and stays cached.
export function documentMap(file: FileRecord): string {
  const pages = documentPages(file)
  const lines = [
    `[文档：${file.name}，共 ${pages.length} 页。这里只有目录和页面地图，没有正文]`,
    file.isScanned
      ? '这是扫描件，没有文字层，search_document 搜不到内容；用 read_document_pages 直接翻阅页面图片。'
      : '涉及文档内容时，先用 search_document 检索，或用 read_document_pages 翻阅对应的页，依据读到的内容回答，并注明页码。'
  ]
  const outline = outlineOf(file)
  if (outline.length > 0) lines.push('', '目录：', ...outlineLines(outline, pages.length))
  if (!file.isScanned) {
    lines.push('', '页面：')
    for (const p of pages) {
      const tags = p.tags.map((t) => TAG_NAMES[t]).join('、')
      lines.push([`第 ${p.n} 页`, p.title, `${charCount(p.text)} 字`, tags].filter(Boolean).join(' · '))
    }
  }
  return lines.join('\n')
}

// A document sent whole, for a model without tools: every page's text, and the first page images.
function wholeDocument(header: string, file: FileRecord, caps: Capabilities): PlannedPart[] {
  const parts: PlannedPart[] = [{ type: 'text', text: header }]
  const skipped: number[] = []
  let images = 0
  for (const p of documentPages(file)) {
    const text = [p.title, p.text].filter(Boolean).join('\n')
    if (text) parts.push({ type: 'text', text: `## 第 ${p.n} 页\n${text}` })
    if (!caps.supportsVision || p.imageIds.length === 0) continue
    if (images + p.imageIds.length > MAX_DOCUMENT_PAGE_IMAGES) {
      skipped.push(p.n)
      continue
    }
    images += p.imageIds.length
    for (const fileId of p.imageIds) parts.push({ type: 'image', fileId })
  }
  if (skipped.length > 0) parts.push({ type: 'text', text: `（第 ${skipped.join('、')} 页的图片没有附上）` })
  return parts
}

// pdf and pptx: the page map, the whole document, or (prepared before D-077) the old parts.
function planDocument(header: string, file: FileRecord, caps: Capabilities): PlannedPart[] {
  if (readsByTool(file, caps)) return [{ type: 'text', text: documentMap(file) }]
  if (documentPages(file).length > 0) return wholeDocument(header, file, caps)
  return withImagesIfVision(header, file, caps)
}

function extractedText(file: FileRecord): string {
  return (file.extracted ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

// The extracted text in order, and the extracted images where the model can see them.
function withImagesIfVision(header: string, file: FileRecord, caps: Capabilities): PlannedPart[] {
  const parts: PlannedPart[] = [{ type: 'text', text: header }]
  for (const p of file.extracted ?? []) {
    if (p.type === 'text') parts.push(p)
    else if (p.type === 'image' && caps.supportsVision) parts.push({ type: 'image', fileId: p.fileId })
  }
  return parts
}

// Follows the table in product.md section 8.
export function planFile(file: FileRecord, caps: Capabilities): FilePlan {
  const header = `[文件：${file.name}]`
  switch (fileKind(file.mime)) {
    case 'image': {
      if (!caps.supportsVision) {
        return { parts: [{ type: 'text', text: `[图片：${file.name}]` }], blocked: '当前模型不能看图' }
      }
      // A downscaled copy, when the original was too large, is the only extracted part.
      const resized = file.extracted?.find((p) => p.type === 'image')
      return { parts: [{ type: 'image', fileId: resized?.fileId ?? file.id }], blocked: null }
    }
    case 'pdf':
      if (file.isScanned && !caps.supportsVision) {
        return {
          parts: [{ type: 'text', text: `[扫描件 PDF：${file.name}]` }],
          blocked: '这个 PDF 是扫描件，当前模型不能看图'
        }
      }
      return { parts: planDocument(header, file, caps), blocked: null }
    case 'pptx':
      return { parts: planDocument(header, file, caps), blocked: null }
    case 'docx':
      return { parts: withImagesIfVision(header, file, caps), blocked: null }
    case 'text':
      return { parts: [{ type: 'text', text: `${header}\n${extractedText(file)}` }], blocked: null }
  }
}

export function countImages(plans: FilePlan[]): number {
  return plans.reduce((n, plan) => n + plan.parts.filter((p) => p.type === 'image').length, 0)
}

// The 附件 tab's list: every file sent in these messages, in the order first sent, each once.
export function sentFileIds(messages: Message[]): string[] {
  const ids = new Set<string>()
  for (const m of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
    for (const a of m.attachments) if (a.type === 'file') ids.add(a.fileId)
  }
  return [...ids]
}
