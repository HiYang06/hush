import JSZip from 'jszip'
import mammoth from 'mammoth'
import { charCount, detectMime, MIN_SLIDE_IMAGE_BYTES } from '@shared/files'
import type { PageTag } from '@shared/types'

// Like ExtractedPart, but images still carry their bytes; prepare.ts stores them and swaps in file ids.
export type OfficePart =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; mime: string; data: Uint8Array<ArrayBuffer> }

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// A run in the Symbol font stores U+F000 plus the font's own code (U+F0CE for ∈), which only that font
// draws, and only on Windows; models can't read it either. Symbol codes 0x20–0x7E, then 0xA0–0xFE
// (0xF0 has no character).
const SYMBOL_LOW = ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼'
const SYMBOL_HIGH = '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓◊⟨®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪⟩∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭'

function symbolChar(c: string): string {
  const code = c.charCodeAt(0) - 0xf000
  if (code <= 0x7e) return SYMBOL_LOW[code - 0x20]
  if (code >= 0xa0) return SYMBOL_HIGH[code - 0xa0]
  return c
}

// Only runs set in Symbol: Wingdings and other symbol fonts use the same code points for other pictures.
export function unicodeSymbols(xml: string): string {
  return xml.replace(/<a:r\b[^>]*>(?:(?!<\/a:r>)[\s\S])*?typeface="Symbol"[\s\S]*?<\/a:r>/g, (run) =>
    run.replace(/[-]/g, symbolChar)
  )
}

// The window's pptx renderer reads the file itself, so the preview needs the characters fixed in the
// file. A file without Symbol runs comes back as is; otherwise only the changed slides are recompressed.
export async function withUnicodeSymbols(data: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(data)
  let changed = false
  for (const file of zip.file(/^ppt\/(?:slides|notesSlides)\/[^/]+\.xml$/)) {
    const xml = await file.async('string')
    const fixed = unicodeSymbols(xml)
    if (fixed === xml) continue
    zip.file(file.name, fixed)
    changed = true
  }
  return changed ? zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }) : data
}

function htmlToText(html: string): string {
  return decodeXml(
    html
      .replace(/<h(\d)[^>]*>/g, (_, level) => `\n${'#'.repeat(Number(level))} `)
      .replace(/<li[^>]*>/g, '\n- ')
      .replace(/<br\s*\/?>|<\/(p|h\d|tr)>/g, '\n')
      .replace(/<\/t[dh]>/g, ' | ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Models only take these; EMF, WMF and TIFF from Office files are dropped.
function imageMime(name: string): string | null {
  const mime = detectMime(name, '')
  return mime?.startsWith('image/') ? mime : null
}

// Text with embedded images where they appear in the document.
export async function extractDocx(data: ArrayBuffer): Promise<OfficePart[]> {
  const images: OfficePart[] = []
  const { value: html } = await mammoth.convertToHtml(
    // The Node build (tests) reads `buffer`, the browser build `arrayBuffer`.
    { arrayBuffer: data, buffer: data as unknown as Buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const mime = image.contentType
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) return { src: '' }
        const data = new Uint8Array(await image.readAsArrayBuffer())
        images.push({ type: 'image', name: `image${images.length + 1}`, mime, data })
        return { src: `hush-image:${images.length - 1}` }
      })
    }
  )

  const parts: OfficePart[] = []
  const pieces = html.split(/<img[^>]*src="hush-image:(\d+)"[^>]*\/?>/)
  pieces.forEach((piece, i) => {
    if (i % 2 === 1) {
      parts.push(images[Number(piece)])
    } else {
      const text = htmlToText(piece)
      if (text) parts.push({ type: 'text', text })
    }
  })
  return parts
}

function resolvePath(fromFile: string, target: string): string {
  const parts = fromFile.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

function relsPath(file: string): string {
  const slash = file.lastIndexOf('/')
  return `${file.slice(0, slash)}/_rels/${file.slice(slash + 1)}.rels`
}

// Relationship id → absolute path inside the zip, plus each relationship's type.
async function readRels(zip: JSZip, file: string): Promise<Map<string, { path: string; type: string }>> {
  const xml = (await zip.file(relsPath(file))?.async('string')) ?? ''
  const rels = new Map<string, { path: string; type: string }>()
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const attr = (name: string): string => m[0].match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? ''
    if (attr('TargetMode') === 'External') continue
    rels.set(attr('Id'), { path: resolvePath(file, attr('Target')), type: attr('Type') })
  }
  return rels
}

// Slide numbers, dates, headers and footers are layout furniture, not content.
const FURNITURE = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph\b[^>]*type="(?:sldNum|dt|ftr|hdr)"[\s\S]*?<\/p:sp>/g
const TITLE = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph\b[^>]*type="(?:title|ctrTitle)"[\s\S]*?<\/p:sp>/

function slideText(xml: string): string {
  return [...xml.replace(FURNITURE, '').matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
    .map(([, p]) => decodeXml([...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(([, t]) => t).join('')))
    .filter((line) => line.trim())
    .join('\n')
}

// What a slide draws besides text, which its text alone loses (D-077). A text box is a rect; any other
// geometry, a connector, SmartArt or a chart is part of a diagram.
function slideTags(xml: string): PageTag[] {
  const tags: PageTag[] = []
  if (/<p:cxnSp\b|<a:custGeom\b|<a:prstGeom\b[^>]*prst="(?!rect")|<a:graphicData\b[^>]*uri="[^"]*\/(?:diagram|chart)"/.test(xml)) {
    tags.push('figure')
  }
  if (/<a:tbl\b/.test(xml)) tags.push('table')
  if (/<m:oMath\b/.test(xml)) tags.push('math')
  return tags
}

export type OfficeImage = Extract<OfficePart, { type: 'image' }>

// path: the slide's file in the zip, which the renderer knows the slide by. text: the body (without
// the title) and the speaker notes. shownChars: how much text the slide itself shows, title and body,
// to check a rendering against.
export type PptxSlide = {
  path: string
  title: string
  text: string
  shownChars: number
  tags: PageTag[]
  images: OfficeImage[]
}

// Per slide, in presentation order; the window renders the slides that have tags (slides.ts).
export async function extractPptx(data: ArrayBuffer): Promise<PptxSlide[]> {
  const zip = await JSZip.loadAsync(data)
  const presentation = 'ppt/presentation.xml'
  const presentationXml = (await zip.file(presentation)?.async('string')) ?? ''
  const presentationRels = await readRels(zip, presentation)
  const slidePaths = [...presentationXml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
    .map(([, id]) => presentationRels.get(id)?.path)
    .filter((p): p is string => Boolean(p))

  const slides: PptxSlide[] = []
  for (const path of slidePaths) {
    const xml = (await zip.file(path)?.async('string')) ?? ''
    const rels = await readRels(zip, path)
    const notesPath = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'))?.path
    const notes = notesPath ? slideText((await zip.file(notesPath)?.async('string')) ?? '') : ''
    const titleShape = xml.match(TITLE)?.[0] ?? ''
    const title = slideText(titleShape).replace(/\s+/g, ' ').trim()
    const body = slideText(xml.replace(titleShape, ''))
    const text = [body, notes && `演讲者备注：\n${notes}`].filter(Boolean).join('\n\n')

    const images: OfficeImage[] = []
    const seen = new Set<string>()
    for (const [, id] of xml.matchAll(/r:embed="([^"]+)"/g)) {
      const target = rels.get(id)?.path
      if (!target || seen.has(target)) continue
      seen.add(target)
      const mime = imageMime(target)
      const bytes = (await zip.file(target)?.async('uint8array')) as Uint8Array<ArrayBuffer> | undefined
      // Small images are mostly icons and logos.
      if (!mime || !bytes || bytes.length < MIN_SLIDE_IMAGE_BYTES) continue
      images.push({ type: 'image', name: target.split('/').pop() ?? target, mime, data: bytes })
    }
    const tags = slideTags(xml)
    if (images.length > 0) tags.push('image')
    slides.push({ path, title, text, shownChars: charCount(title + body), tags, images })
  }
  return slides
}
