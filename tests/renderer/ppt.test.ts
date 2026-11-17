import { describe, expect, it } from 'vitest'
import { detectMime, PPT_MIME } from '../../src/shared/files'
import { extractPptx } from '../../src/renderer/src/lib/attachments/office'
import { pptToPptx } from '../../src/renderer/src/lib/attachments/pptToPptx'

// A small .ppt built record by record ([MS-PPT], [MS-ODRAW]) inside a compound file ([MS-CFB]).

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function le(...fields: [bits: 8 | 16 | 32, value: number][]): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, [bits]) => n + bits / 8, 0))
  const dv = new DataView(out.buffer)
  let o = 0
  for (const [bits, v] of fields) {
    if (bits === 8) dv.setUint8(o, v)
    else if (bits === 16) dv.setUint16(o, v, true)
    else dv.setUint32(o, v >>> 0, true)
    o += bits / 8
  }
  return out
}

const utf16 = (s: string): Uint8Array => new Uint8Array(new Uint16Array([...s].map((c) => c.charCodeAt(0))).buffer)

function atom(type: number, payload: Uint8Array, inst = 0, ver = 0): Uint8Array {
  return concat([le([16, (inst << 4) | ver], [16, type], [32, payload.length]), payload])
}
const container = (type: number, kids: Uint8Array[], inst = 0): Uint8Array => atom(type, concat(kids), inst, 0xf)

const MASTER_ID = 0x80000000
const SLIDE_IDS = [256, 257]

// Text whose characters are all one size.
function styledText(textType: number, text: string, size: number): Uint8Array[] {
  const n = text.length + 1
  return [
    atom(0x0f9f, le([32, textType])),
    atom(0x0fa0, utf16(text)),
    atom(0x0fa1, concat([le([32, n], [16, 0], [32, 0]), le([32, n], [32, 0x20000], [16, size])]))
  ]
}

function shape(shapeType: number, flags: number, extra: Uint8Array[]): Uint8Array {
  return container(0xf004, [atom(0xf00a, le([32, 0], [32, flags]), shapeType, 2), ...extra])
}
const anchor = (top: number, left: number, right: number, bottom: number): Uint8Array => atom(0xf010, le([16, top], [16, left], [16, right], [16, bottom]))
const placeholder = (type: number): Uint8Array => container(0xf011, [atom(0x0bc3, le([32, 0], [8, type], [8, 0], [16, 0]))])
const textRef = (i: number): Uint8Array => container(0xf00d, [atom(0x0f9e, le([32, i]))])

function drawing(shapes: Uint8Array[]): Uint8Array {
  const patriarch = shape(0, 0x5, [atom(0xf009, new Uint8Array(16), 0, 1)])
  return container(0x040c, [container(0xf002, [container(0xf003, [patriarch, ...shapes])])])
}

const slideAtom = (masterRef: number): Uint8Array => atom(0x03ef, concat([new Uint8Array(12), le([32, masterRef], [32, 0], [16, 0x7], [16, 0])]), 0, 2)
const persistAtom = (ref: number, id: number): Uint8Array => atom(0x03f3, le([32, ref], [32, 0], [32, 0], [32, id], [32, 0]))

// Big enough that the slide image's picture isn't dropped as an icon.
const PNG = concat([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), new Uint8Array(12 * 1024)])

function documentStream(encrypted: boolean): { doc: Uint8Array; editOffset: number } {
  const blip = atom(0xf01e, concat([new Uint8Array(17), PNG]), 0x6e0)
  // The picture sits inside its store entry, after the entry's 36 bytes.
  const fbse = atom(0xf007, concat([le([8, 6], [8, 6]), new Uint8Array(18), le([32, blip.length], [32, 1], [32, 0], [32, 0]), blip]), 6, 2)
  const pictures = container(0x040b, [container(0xf000, [container(0xf001, [fbse])])])
  const sized = (inst: number, size: number): Uint8Array => atom(0x0fa3, le([16, 1], [32, 0], [32, 0x20000], [16, size]), inst)

  const parts: Uint8Array[] = []
  const offsets: number[] = []
  let at = 0
  const place = (rec: Uint8Array): void => {
    offsets.push(at)
    parts.push(rec)
    at += rec.length
  }
  // Persist objects 1–5: master, two slides, notes, document.
  place(container(0x03f8, [slideAtom(0), drawing([])]))
  place(
    container(0x03ee, [
      slideAtom(MASTER_ID),
      drawing([
        shape(1, 0, [anchor(50, 50, 650, 120), placeholder(13), textRef(0)]),
        shape(1, 0, [anchor(150, 50, 650, 450), placeholder(14), textRef(1)]),
        shape(75, 0, [atom(0xf00b, le([16, 0x4104], [32, 1]), 1, 3), anchor(300, 400, 600, 500)])
      ])
    ])
  )
  place(
    container(0x03ee, [
      slideAtom(MASTER_ID),
      drawing([
        shape(202, 0, [anchor(200, 50, 650, 260), container(0xf00d, styledText(4, '小字正文', 18))]),
        shape(202, 0, [anchor(40, 50, 650, 120), container(0xf00d, styledText(4, '大字标题', 40))])
      ])
    ])
  )
  place(
    container(0x03f0, [
      atom(0x03f1, le([32, SLIDE_IDS[0]], [32, 0])),
      drawing([shape(1, 0, [anchor(400, 50, 500, 700), placeholder(12), textRef(0)])])
    ])
  )
  place(
    container(0x03e8, [
      atom(0x03e9, concat([le([32, 5760], [32, 4320]), new Uint8Array(32)]), 0, 1),
      container(0x03f2, [
        container(0x07d5, [atom(0x0fb7, concat([utf16('Arial'), new Uint8Array(64 - 10 + 4)]))]),
        sized(0, 44),
        sized(1, 20)
      ]),
      pictures,
      container(0x0ff0, [persistAtom(1, MASTER_ID)], 1),
      container(
        0x0ff0,
        [
          persistAtom(2, SLIDE_IDS[0]),
          atom(0x0f9f, le([32, 0])),
          atom(0x0fa0, utf16('第一页标题')),
          atom(0x0f9f, le([32, 1])),
          atom(0x0fa0, utf16('要点一\r要点二')),
          persistAtom(3, SLIDE_IDS[1])
        ],
        0
      ),
      container(0x0ff0, [persistAtom(4, 0x100), atom(0x0f9f, le([32, 2])), atom(0x0fa0, utf16('备注内容'))], 2)
    ])
  )
  const dir = at
  place(atom(0x1772, concat([le([32, 1 | (5 << 20)]), ...offsets.map((o) => le([32, o]))])))
  const editOffset = at
  const edit = le([32, 0], [16, 0], [8, 0], [8, 3], [32, 0], [32, dir], [32, 5], [32, 5], [16, 1], [16, 0])
  place(atom(0x0ff5, encrypted ? concat([edit, le([32, 6])]) : edit))
  return { doc: concat(parts), editOffset }
}

// Streams padded past the mini-stream cutoff, so all of them sit in ordinary 512-byte sectors.
function compoundFile(streams: [string, Uint8Array][]): Uint8Array {
  const SECTOR = 512
  const FREE = 0xffffffff
  const END = 0xfffffffe
  const padded = streams.map(([name, data]) => {
    const size = Math.max(data.length, 4096)
    const bytes = new Uint8Array(Math.ceil(size / SECTOR) * SECTOR)
    bytes.set(data)
    return { name, size, bytes }
  })
  // Sector 0: the FAT; sector 1: the directory; then the streams.
  const fat = new Uint32Array(SECTOR / 4).fill(FREE)
  fat[0] = 0xfffffffd
  fat[1] = END
  let next = 2
  const starts = padded.map(({ bytes }) => {
    const start = next
    const n = bytes.length / SECTOR
    for (let i = 0; i < n; i++) fat[start + i] = i === n - 1 ? END : start + i + 1
    next += n
    return start
  })

  const entry = (name: string, type: number, start: number, size: number, child: number, right: number): Uint8Array => {
    const e = new Uint8Array(128)
    e.set(utf16(name))
    const dv = new DataView(e.buffer)
    dv.setUint16(64, (name.length + 1) * 2, true)
    e[66] = type
    e[67] = 1
    dv.setUint32(68, FREE, true)
    dv.setUint32(72, right, true)
    dv.setUint32(76, child, true)
    dv.setUint32(116, start, true)
    dv.setUint32(120, size, true)
    return e
  }
  const dirSector = concat([
    entry('Root Entry', 5, END, 0, 1, FREE),
    ...padded.map((s, i) => entry(s.name, 2, starts[i], s.size, FREE, i + 2 <= padded.length ? i + 2 : FREE)),
    new Uint8Array((3 - padded.length) * 128)
  ])

  const header = new Uint8Array(SECTOR)
  const h = new DataView(header.buffer)
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  h.setUint16(0x18, 0x3e, true)
  h.setUint16(0x1a, 3, true)
  h.setUint16(0x1c, 0xfffe, true)
  h.setUint16(0x1e, 9, true)
  h.setUint16(0x20, 6, true)
  h.setUint32(0x2c, 1, true)
  h.setUint32(0x30, 1, true)
  h.setUint32(0x38, 4096, true)
  h.setUint32(0x3c, END, true)
  h.setUint32(0x44, END, true)
  for (let i = 0; i < 109; i++) h.setUint32(0x4c + i * 4, i === 0 ? 0 : FREE, true)
  return concat([header, new Uint8Array(fat.buffer), dirSector, ...padded.map((s) => s.bytes)])
}

function ppt({ encrypted = false } = {}): Uint8Array {
  const { doc, editOffset } = documentStream(encrypted)
  // CurrentUserAtom: size, header token, then the offset of the newest UserEditAtom.
  const currentUser = atom(0x0ff6, le([32, 20], [32, 0xe391c05f], [32, editOffset], [16, 0], [16, 0x3f4], [8, 3], [8, 0], [16, 0]))
  return compoundFile([
    ['PowerPoint Document', doc],
    ['Current User', currentUser]
  ])
}

describe('pptToPptx', () => {
  it('turns a .ppt into a .pptx with titles, body text, notes and pictures', async () => {
    const slides = await extractPptx(await pptToPptx(ppt()))
    expect(slides).toHaveLength(2)
    expect(slides[0].title).toBe('第一页标题')
    expect(slides[0].text).toBe('要点一\n要点二\n\n演讲者备注：\n备注内容')
    expect(slides[0].images.map((i) => [i.mime, i.data.length])).toEqual([['image/png', PNG.length]])
    expect(slides[0].tags).toEqual(['image'])
  })

  it('takes the largest text as the title of a slide without a title placeholder', async () => {
    const [, slide] = await extractPptx(await pptToPptx(ppt()))
    expect(slide.title).toBe('大字标题')
    expect(slide.text).toBe('小字正文')
  })

  it('rejects encrypted files and files of other kinds', async () => {
    await expect(pptToPptx(ppt({ encrypted: true }))).rejects.toThrow('Encrypted')
    await expect(pptToPptx(new TextEncoder().encode('PK not a compound file'))).rejects.toThrow()
  })

  it('recognizes .ppt by its extension', () => {
    expect(detectMime('第三章.PPT', '')).toBe(PPT_MIME)
  })
})
