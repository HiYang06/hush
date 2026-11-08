import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { extractDocx, extractPptx, unicodeSymbols, withUnicodeSymbols } from '../../src/renderer/src/lib/attachments/office'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function png(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(PNG_HEADER)
  return bytes
}

function rels(entries: [id: string, type: string, target: string][]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`
}

function textShape(lines: string[], placeholder?: string): string {
  const ph = placeholder ? `<p:nvSpPr><p:nvPr><p:ph type="${placeholder}"/></p:nvPr></p:nvSpPr>` : ''
  return `<p:sp>${ph}<p:txBody>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`
}

async function pptx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  // Slide order comes from presentation.xml, not file names: slide2.xml is the first slide here.
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>'
  )
  zip.file('ppt/_rels/presentation.xml.rels', rels([['rId1', 'slide', 'slides/slide1.xml'], ['rId2', 'slide', 'slides/slide2.xml']]))
  zip.file('ppt/slides/slide2.xml', `<p:sld>${textShape(['矩阵 &amp; 向量', '第二行'])}${textShape(['1'], 'sldNum')}<p:pic><a:blip r:embed="rId5"/></p:pic><p:pic><a:blip r:embed="rId6"/></p:pic></p:sld>`)
  zip.file(
    'ppt/slides/_rels/slide2.xml.rels',
    rels([
      ['rId5', 'image', '../media/image1.png'],
      ['rId6', 'image', '../media/icon.png'],
      ['rId7', 'notesSlide', '../notesSlides/notesSlide1.xml']
    ])
  )
  zip.file('ppt/notesSlides/notesSlide1.xml', `<p:notes>${textShape(['讲到这里停一下'])}${textShape(['1'], 'sldNum')}</p:notes>`)
  zip.file(
    'ppt/slides/slide1.xml',
    `<p:sld>${textShape(['总结'], 'title')}${textShape(['要点'])}<p:cxnSp/><p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl/></a:graphicData></a:graphic></p:graphicFrame></p:sld>`
  )
  zip.file('ppt/media/image1.png', png(20 * 1024))
  zip.file('ppt/media/icon.png', png(2 * 1024))
  return zip.generateAsync({ type: 'arraybuffer' })
}

async function docx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>'
  )
  zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']]))
  zip.file('word/_rels/document.xml.rels', rels([['rId9', 'image', 'media/figure.png']]))
  zip.file('word/media/figure.png', png(100))
  const drawing = `<w:drawing><wp:inline><wp:docPr id="1" name="图"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId9"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>` +
      `<w:p><w:r><w:t>图之前</w:t></w:r></w:p><w:p><w:r>${drawing}</w:r></w:p><w:p><w:r><w:t>图之后 &lt;b&gt;</w:t></w:r></w:p>` +
      `</w:body></w:document>`
  )
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('extractPptx', () => {
  it('goes slide by slide: title, text and notes, tags and images, skipping slide numbers and small icons', async () => {
    const slides = await extractPptx(await pptx())
    expect(slides.map((s) => ({ ...s, images: s.images.map((i) => `${i.name} ${i.mime}`) }))).toEqual([
      {
        path: 'ppt/slides/slide2.xml',
        title: '',
        text: '矩阵 & 向量\n第二行\n\n演讲者备注：\n讲到这里停一下',
        shownChars: 8,
        tags: ['image'],
        images: ['image1.png image/png']
      },
      // A connector draws a diagram; a table is a table, even inside a graphic frame.
      { path: 'ppt/slides/slide1.xml', title: '总结', text: '要点', shownChars: 4, tags: ['figure', 'table'], images: [] }
    ])
  })
})

describe('unicodeSymbols', () => {
  const run = (typeface: string, text: string): string =>
    `<a:r><a:rPr lang="en-US"><a:sym typeface="${typeface}" pitchFamily="18" charset="2"/></a:rPr><a:t>${text}</a:t></a:r>`

  it('turns Symbol-font code points into the characters they draw, in Symbol runs only', () => {
    const xml = `<a:p><a:r><a:rPr/><a:t>f(n) \uf0ce</a:t></a:r>${run('Symbol', '\uf0ce\uf0b3\uf0a3\uf061\uf0e5')}${run('Wingdings', '\uf0fc')}</a:p>`
    expect(unicodeSymbols(xml)).toBe(
      `<a:p><a:r><a:rPr/><a:t>f(n) \uf0ce</a:t></a:r>${run('Symbol', '∈≥≤α∑')}${run('Wingdings', '\uf0fc')}</a:p>`
    )
  })

  it('maps every Symbol code it knows to one character', () => {
    for (let code = 0x20; code <= 0xfe; code++) {
      const fixed = unicodeSymbols(run('Symbol', String.fromCharCode(0xf000 + code)))
      expect([...fixed.match(/<a:t>(.*)<\/a:t>/)![1]]).toHaveLength(1)
    }
  })

  it('fixes the file the renderer reads, and leaves a file without Symbol runs untouched', async () => {
    const plain = await pptx()
    expect(await withUnicodeSymbols(plain)).toBe(plain)

    const zip = await JSZip.loadAsync(plain)
    zip.file('ppt/slides/slide1.xml', `<p:sld><p:sp><p:txBody><a:p>${run('Symbol', 'n\uf0b3n\uf031')}</a:p></p:txBody></p:sp></p:sld>`)
    const fixed = await withUnicodeSymbols(await zip.generateAsync({ type: 'arraybuffer' }))
    const slides = await extractPptx(fixed)
    expect(slides[1].text).toBe('n≥n1')
  })
})

describe('extractDocx', () => {
  it('keeps images where they appear in the text', async () => {
    const parts = await extractDocx(await docx())
    expect(parts.map((p) => (p.type === 'text' ? p.text : `[${p.mime} ${p.data.length}]`))).toEqual([
      '图之前',
      '[image/png 100]',
      '图之后 <b>'
    ])
  })
})
