// Needs canvas, which only the window has; this is why preparing files happens here (D-018, D-039).
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { charCount, IMAGE_MAX_EDGE, PDF_MATH_CHARS, PDF_VECTOR_PATHS, SCANNED_CHARS_PER_PAGE } from '@shared/files'
import type { DocumentPage, OutlineEntry, PageTag } from '@shared/types'
import { assembleLines, captionTags, pageHeading, type TextRun } from './pdfText'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjs }

export type Encoded = { mime: string; data: Uint8Array<ArrayBuffer> }

function canvasBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encoding failed'))), mime, 0.85)
  )
}

export async function encode(canvas: HTMLCanvasElement, mime: string): Promise<Encoded> {
  return { mime, data: new Uint8Array(await (await canvasBlob(canvas, mime)).arrayBuffer()) }
}

// null when the image is small enough to send as is.
export async function downscale(data: Uint8Array<ArrayBuffer>, mime: string): Promise<Encoded | null> {
  const bitmap = await createImageBitmap(new Blob([data], { type: mime }))
  const scale = IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height)
  if (scale >= 1) {
    bitmap.close()
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  // PNG and GIF may be transparent, which JPEG would turn black.
  return encode(canvas, mime === 'image/jpeg' ? 'image/jpeg' : 'image/png')
}

export type PdfContent = { pages: DocumentPage[]; outline: OutlineEntry[]; isScanned: boolean }

// Stores a rendered page and returns its file id.
export type StoreImage = (page: number, image: Encoded) => Promise<string>

// LaTeX (Computer Modern, AMS, tx), Libertine, STIX and Word's Cambria Math. Embedded fonts carry a
// six-letter subset prefix, as in "LICAEO+CMMI10".
const MATH_FONT = /^([A-Z]{6}\+)?(CM(MI|SY|EX)|MSBM|MSAM|tx(sy|mi|ex)|STIX)|Math/i
const RASTER = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject])

async function render(page: pdfjs.PDFPageProxy): Promise<Encoded> {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: IMAGE_MAX_EDGE / Math.max(base.width, base.height) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  await page.render({ canvas, viewport }).promise
  return encode(canvas, 'image/jpeg')
}

type Outline = Awaited<ReturnType<pdfjs.PDFDocumentProxy['getOutline']>>

// Bookmarks in order, each with the page it opens; ones pointing nowhere (broken files) are left out.
async function readOutline(doc: pdfjs.PDFDocumentProxy): Promise<OutlineEntry[]> {
  const entries: OutlineEntry[] = []
  async function walk(items: Outline, depth: number): Promise<void> {
    for (const item of items ?? []) {
      const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest
      const ref = Array.isArray(dest) ? dest[0] : null
      const index =
        typeof ref === 'number' ? ref : ref ? await doc.getPageIndex(ref).catch(() => null) : null
      const title = item.title.replace(/\s+/g, ' ').trim()
      if (index !== null && title) entries.push({ title, page: index + 1, depth })
      await walk(item.items, depth + 1)
    }
  }
  await walk(await doc.getOutline(), 0)
  return entries
}

// Every page's text, heading and tags; pages with a figure, table or formula (every page of a scan)
// are rendered and stored as they go, so a long document never sits in memory as images (D-077).
export async function readPdf(data: Uint8Array<ArrayBuffer>, storeImage: StoreImage): Promise<PdfContent> {
  // pdf.js takes ownership of the buffer it is given; the original still has to be saved.
  // fontExtraProperties keeps the font names, which tell formulas apart.
  const task = pdfjs.getDocument({ data: data.slice(), fontExtraProperties: true })
  try {
    const doc = await task.promise
    const pages: DocumentPage[] = []
    const paths: number[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      // Loads the page's fonts into commonObjs, so their names can be read below.
      const ops = await page.getOperatorList()
      const content = await page.getTextContent()
      const runs: TextRun[] = []
      let mathChars = 0
      for (const item of content.items) {
        if (!('str' in item)) continue
        const [, , c, d, x, y] = item.transform as number[]
        runs.push({ str: item.str, x, y, size: Math.hypot(c, d) || item.height, width: item.width })
        const font = page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : null
        if (MATH_FONT.test(font?.name ?? '')) mathChars += item.str.replace(/\s/g, '').length
      }
      const lines = assembleLines(runs)
      const tags = new Set<PageTag>(captionTags(lines))
      if (mathChars >= PDF_MATH_CHARS) tags.add('math')
      if (ops.fnArray.some((fn) => RASTER.has(fn))) tags.add('image')
      paths.push(ops.fnArray.filter((fn) => fn === pdfjs.OPS.constructPath).length)
      pages.push({
        n,
        title: pageHeading(lines),
        text: lines.map((l) => l.text).join('\n'),
        tags: [...tags],
        imageIds: []
      })
    }
    // Slides draw diagrams as vector shapes, with no caption to give them away. Counted above the
    // quietest page, since a template's frame and rules repeat on every page.
    const baseline = Math.min(...paths)
    for (const [i, page] of pages.entries()) {
      if (paths[i] - baseline >= PDF_VECTOR_PATHS && !page.tags.includes('figure')) page.tags.push('figure')
    }
    const chars = pages.reduce((sum, p) => sum + charCount(p.text), 0)
    const isScanned = chars / doc.numPages < SCANNED_CHARS_PER_PAGE

    for (const page of pages) {
      if (isScanned || page.tags.length > 0) {
        page.imageIds = [await storeImage(page.n, await render(await doc.getPage(page.n)))]
      }
    }
    return { pages, outline: await readOutline(doc), isScanned }
  } finally {
    await task.destroy()
  }
}
