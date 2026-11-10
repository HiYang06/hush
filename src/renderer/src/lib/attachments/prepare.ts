import { detectMime, fileKind } from '@shared/files'
import type { DocumentPage, ExtractedPart, FileRecord } from '@shared/types'
import { downscale, type Encoded } from './images'

export class UnsupportedFileError extends Error {
  override name = 'UnsupportedFileError'
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? name : name.slice(0, dot)
}

const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }

// A derived image (resized copy, rendered page, embedded picture) is stored as a file of its own.
async function addImage(name: string, image: Encoded): Promise<{ type: 'image'; fileId: string }> {
  const resized = await downscale(image.data, image.mime)
  const { mime, data } = resized ?? image
  const record = await window.api.invoke('files:add', {
    name: `${baseName(name)}.${EXTENSION[mime]}`,
    mime,
    data,
    extracted: null,
    isScanned: null
  })
  return { type: 'image', fileId: record.id }
}

// Extracts everything a model might need now (D-018); context.ts later picks what to send.
export async function prepareFile(file: File): Promise<FileRecord> {
  const mime = detectMime(file.name, file.type)
  if (!mime) throw new UnsupportedFileError(file.name)
  const data = new Uint8Array(await file.arrayBuffer())
  let extracted: ExtractedPart[] | null = null
  let isScanned: boolean | null = null

  switch (fileKind(mime)) {
    case 'image': {
      const resized = await downscale(data, mime)
      if (resized) extracted = [await addImage(file.name, resized)]
      break
    }
    case 'pdf': {
      const { readPdf } = await import('./media')
      const pdf = await readPdf(data, async (n, image) => (await addImage(`${baseName(file.name)}-${n}`, image)).fileId)
      isScanned = pdf.isScanned
      extracted = [
        ...(pdf.outline.length > 0 ? [{ type: 'outline' as const, entries: pdf.outline }] : []),
        ...pdf.pages.map((p) => ({ type: 'page' as const, ...p }))
      ]
      break
    }
    case 'pptx': {
      const { extractPptx, withUnicodeSymbols } = await import('./office')
      const { renderSlides } = await import('./slides')
      const pptx = await withUnicodeSymbols(data.buffer)
      const slides = await extractPptx(pptx)
      const rendered = await renderSlides(
        pptx,
        new Map(slides.filter((s) => s.tags.length > 0).map((s) => [s.path, s.shownChars]))
      )
      extracted = []
      for (const [i, slide] of slides.entries()) {
        const n = i + 1
        const drawn = rendered.get(slide.path)
        // A slide the renderer couldn't draw, or drew only in part, still has its embedded pictures.
        const images = [
          ...(drawn ? [{ ...drawn.image, name: `slide${n}` }] : []),
          ...(!drawn || !drawn.complete ? slide.images : [])
        ]
        const imageIds: string[] = []
        for (const img of images) imageIds.push((await addImage(`${baseName(file.name)}-${img.name}`, img)).fileId)
        const page: DocumentPage = { n, title: slide.title, text: slide.text, tags: slide.tags, imageIds }
        extracted.push({ type: 'page', ...page })
      }
      break
    }
    case 'docx': {
      const { extractDocx } = await import('./office')
      extracted = []
      for (const p of await extractDocx(data.buffer)) {
        extracted.push(p.type === 'text' ? p : await addImage(`${baseName(file.name)}-${p.name}`, p))
      }
      break
    }
    case 'text':
      extracted = [{ type: 'text', text: new TextDecoder().decode(data) }]
      break
  }

  return window.api.invoke('files:add', { name: file.name, mime, data, extracted, isScanned })
}
