// Reads a PowerPoint 97–2003 .ppt: the compound file ([MS-CFB]), the PowerPoint records ([MS-PPT]) and the
// shapes inside them ([MS-ODRAW]), into the little pptToPptx.ts needs to write the same slides as .pptx.

const END_OF_CHAIN = 0xfffffffa

// Stream name → bytes, for the streams of a compound file.
export function readCfb(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const u32 = (o: number): number => dv.getUint32(o, true)
  if (u32(0) !== 0xe011cfd0 || u32(4) !== 0xe11ab1a1) throw new Error('Not a compound file')
  const sec = 1 << dv.getUint16(0x1e, true)
  const mini = 1 << dv.getUint16(0x20, true)
  const nFat = u32(0x2c)
  const cutoff = u32(0x38)
  const secOff = (s: number): number => (s + 1) * sec
  const perSec = sec / 4

  // The first 109 FAT sectors are listed in the header; the rest in a chain of DIFAT sectors.
  const fatSectors: number[] = []
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) fatSectors.push(u32(0x4c + i * 4))
  for (let d = u32(0x44); fatSectors.length < nFat && d < END_OF_CHAIN; d = u32(secOff(d) + sec - 4)) {
    for (let i = 0; i < perSec - 1 && fatSectors.length < nFat; i++) fatSectors.push(u32(secOff(d) + i * 4))
  }
  const fat = new Uint32Array(fatSectors.length * perSec)
  fatSectors.forEach((s, i) => {
    for (let j = 0; j < perSec; j++) fat[i * perSec + j] = u32(secOff(s) + j * 4)
  })

  const chain = (start: number, table: Uint32Array): number[] => {
    const out: number[] = []
    for (let s = start; s < END_OF_CHAIN; s = table[s]) {
      out.push(s)
      if (out.length > table.length) throw new Error('Sector chain loops')
    }
    return out
  }
  const readBig = (start: number, size?: number): Uint8Array => {
    const secs = chain(start, fat)
    const out = new Uint8Array(secs.length * sec)
    secs.forEach((s, i) => out.set(buf.subarray(secOff(s), secOff(s) + sec), i * sec))
    return size === undefined ? out : out.subarray(0, size)
  }

  const dir = readBig(u32(0x30))
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  const entries: { name: string; type: number; start: number; size: number }[] = []
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const type = dir[o + 66]
    if (type === 0) continue
    const nameLen = ddv.getUint16(o + 64, true)
    const name = new TextDecoder('utf-16le').decode(dir.subarray(o, o + Math.max(0, nameLen - 2)))
    entries.push({ name, type, start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) })
  }
  const root = entries.find((e) => e.type === 5)
  if (!root) throw new Error('Compound file without a root entry')
  // Streams below the cutoff live in the mini stream, which is the root entry's own data.
  const miniStream = readBig(root.start, root.size)
  const miniFatBytes = u32(0x3c) < END_OF_CHAIN ? readBig(u32(0x3c)) : new Uint8Array(0)
  const miniFat = new Uint32Array(miniFatBytes.slice().buffer)
  const readMini = (start: number, size: number): Uint8Array => {
    const secs = chain(start, miniFat)
    const out = new Uint8Array(secs.length * mini)
    secs.forEach((s, i) => out.set(miniStream.subarray(s * mini, (s + 1) * mini), i * mini))
    return out.subarray(0, size)
  }
  const streams = new Map<string, Uint8Array>()
  for (const e of entries) {
    if (e.type !== 2 || streams.has(e.name)) continue
    streams.set(e.name, e.size < cutoff ? readMini(e.start, e.size) : readBig(e.start, e.size))
  }
  return streams
}

type Rec = { ver: number; inst: number; type: number; len: number; off: number; end: number }

class Bytes {
  readonly dv: DataView
  constructor(readonly u8: Uint8Array) {
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  }
  u16 = (o: number): number => this.dv.getUint16(o, true)
  i16 = (o: number): number => this.dv.getInt16(o, true)
  u32 = (o: number): number => this.dv.getUint32(o, true)
  i32 = (o: number): number => this.dv.getInt32(o, true)
  header(o: number): Rec {
    const vi = this.u16(o)
    const len = this.u32(o + 4)
    return { ver: vi & 0xf, inst: vi >> 4, type: this.u16(o + 2), len, off: o + 8, end: Math.min(o + 8 + len, this.u8.length) }
  }
  children(rec: Rec): Rec[] {
    const out: Rec[] = []
    for (let o = rec.off; o + 8 <= rec.end; ) {
      const r = this.header(o)
      out.push(r)
      o = r.off + r.len
    }
    return out
  }
}

const RT = {
  DocumentAtom: 0x03e9,
  Slide: 0x03ee,
  SlideAtom: 0x03ef,
  NotesAtom: 0x03f1,
  Environment: 0x03f2,
  SlidePersistAtom: 0x03f3,
  SSSlideInfoAtom: 0x03f9,
  PPDrawingGroup: 0x040b,
  PPDrawing: 0x040c,
  FontCollection: 0x07d5,
  ColorSchemeAtom: 0x07f0,
  OutlineTextRefAtom: 0x0f9e,
  TextHeaderAtom: 0x0f9f,
  TextCharsAtom: 0x0fa0,
  StyleTextPropAtom: 0x0fa1,
  TxMasterStyleAtom: 0x0fa3,
  TextBytesAtom: 0x0fa8,
  FontEntityAtom: 0x0fb7,
  SlideListWithText: 0x0ff0,
  UserEditAtom: 0x0ff5,
  PlaceholderAtom: 0x0bc3,
  DggContainer: 0xf000,
  BStoreContainer: 0xf001,
  DgContainer: 0xf002,
  SpgrContainer: 0xf003,
  SpContainer: 0xf004,
  FBSE: 0xf007,
  FSPGR: 0xf009,
  FSP: 0xf00a,
  FOPT: 0xf00b,
  ClientTextbox: 0xf00d,
  ChildAnchor: 0xf00f,
  ClientAnchor: 0xf010,
  ClientData: 0xf011,
  TertiaryFOPT: 0xf122
}

// ---------- text ----------

export type TextColor = { rgb: [number, number, number] } | { scheme: number } | null
export type Rgb = [number, number, number]

export type ParaFormat = {
  hasBullet?: boolean
  bulletHasFont?: boolean
  bulletHasColor?: boolean
  bulletHasSize?: boolean
  bulletChar?: number
  bulletFont?: number
  bulletSize?: number
  bulletColor?: TextColor
  align?: number
  // Positive: percent of a line; negative: master units.
  lineSpacing?: number
  spaceBefore?: number
  spaceAfter?: number
  leftMargin?: number
  indent?: number
  defaultTab?: number
  tabs?: { pos: number; type: number }[]
}

export type CharFormat = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  font?: number
  eaFont?: number
  size?: number
  color?: TextColor
  position?: number
}

export type TextBody = {
  textType: number
  text: string
  style: { paras: { count: number; level: number; pf: ParaFormat }[]; chars: { count: number; cf: CharFormat }[] } | null
}

export type StyleLevel = { pf: ParaFormat; cf: CharFormat }
export type MasterStyles = Record<number, StyleLevel[]>

function readColorIndex(b: Bytes, o: number): TextColor {
  const index = b.u8[o + 3]
  return index === 0xfe ? { rgb: [b.u8[o], b.u8[o + 1], b.u8[o + 2]] } : index < 8 ? { scheme: index } : null
}

// TextPFException: a mask says which fields follow, in an order that differs from the mask's bit order.
function readPF(b: Bytes, o: number): [ParaFormat, number] {
  const start = o
  const m = b.u32(o)
  o += 4
  const pf: ParaFormat = {}
  if (m & 0xf) {
    const f = b.u16(o)
    o += 2
    if (m & 0x1) pf.hasBullet = !!(f & 1)
    if (m & 0x2) pf.bulletHasFont = !!(f & 2)
    if (m & 0x4) pf.bulletHasColor = !!(f & 4)
    if (m & 0x8) pf.bulletHasSize = !!(f & 8)
  }
  const field = (bit: number, read: () => void, size = 2): void => {
    if (!(m & bit)) return
    read()
    o += size
  }
  field(0x80, () => (pf.bulletChar = b.u16(o)))
  field(0x10, () => (pf.bulletFont = b.u16(o)))
  field(0x40, () => (pf.bulletSize = b.i16(o)))
  field(0x20, () => (pf.bulletColor = readColorIndex(b, o)), 4)
  field(0x800, () => (pf.align = b.u16(o)))
  field(0x1000, () => (pf.lineSpacing = b.i16(o)))
  field(0x2000, () => (pf.spaceBefore = b.i16(o)))
  field(0x4000, () => (pf.spaceAfter = b.i16(o)))
  field(0x100, () => (pf.leftMargin = b.i16(o)))
  field(0x400, () => (pf.indent = b.i16(o)))
  field(0x8000, () => (pf.defaultTab = b.u16(o)))
  if (m & 0x100000) {
    const n = b.u16(o)
    pf.tabs = Array.from({ length: n }, (_, i) => ({ pos: b.i16(o + 2 + i * 4), type: b.u16(o + 4 + i * 4) }))
    o += 2 + n * 4
  }
  // Font alignment, wrap flags and text direction: read past, not used.
  if (m & 0x10000) o += 2
  if (m & 0xe0000) o += 2
  if (m & 0x200000) o += 2
  return [pf, o - start]
}

function readCF(b: Bytes, o: number): [CharFormat, number] {
  const start = o
  const m = b.u32(o)
  o += 4
  const cf: CharFormat = {}
  if (m & 0x3eb7) {
    const s = b.u16(o)
    o += 2
    if (m & 0x1) cf.bold = !!(s & 1)
    if (m & 0x2) cf.italic = !!(s & 2)
    if (m & 0x4) cf.underline = !!(s & 4)
  }
  if (m & 0x10000) { cf.font = b.u16(o); o += 2 }
  if (m & 0x200000) { cf.eaFont = b.u16(o); o += 2 }
  if (m & 0x400000) o += 2
  if (m & 0x800000) o += 2
  if (m & 0x20000) { cf.size = b.u16(o); o += 2 }
  if (m & 0x40000) { cf.color = readColorIndex(b, o); o += 4 }
  if (m & 0x80000) { cf.position = b.i16(o); o += 2 }
  return [cf, o - start]
}

// Paragraph runs, then character runs; each list covers the text plus one.
function readStyleTextProp(b: Bytes, rec: Rec, textLength: number): NonNullable<TextBody['style']> {
  const paras: { count: number; level: number; pf: ParaFormat }[] = []
  const chars: { count: number; cf: CharFormat }[] = []
  let o = rec.off
  for (let covered = 0; covered < textLength + 1 && o < rec.end; ) {
    const count = b.u32(o)
    const [pf, n] = readPF(b, o + 6)
    paras.push({ count, level: b.u16(o + 4), pf })
    covered += count
    o += 6 + n
  }
  for (let covered = 0; covered < textLength + 1 && o < rec.end; ) {
    const count = b.u32(o)
    const [cf, n] = readCF(b, o + 4)
    chars.push({ count, cf })
    covered += count
    o += 4 + n
  }
  return { paras, chars }
}

function readMasterStyle(b: Bytes, rec: Rec): StyleLevel[] {
  const levels: StyleLevel[] = []
  let o = rec.off + 2
  for (let i = 0; i < b.u16(rec.off); i++) {
    // Text types from 5 up store each level's number before it.
    if (rec.inst >= 5) o += 2
    const [pf, a] = readPF(b, o)
    const [cf, c] = readCF(b, o + a)
    o += a + c
    levels.push({ pf, cf })
  }
  return levels
}

function readText(b: Bytes, rec: Rec): string {
  const bytes = b.u8.subarray(rec.off, rec.end)
  if (rec.type === RT.TextCharsAtom) return new TextDecoder('utf-16le').decode(bytes)
  // TextBytesAtom holds the low bytes of UTF-16 code units, which isn't any one 8-bit encoding.
  return Array.from(bytes, (c) => String.fromCharCode(c)).join('')
}

// Text bodies in a list of sibling records: a TextHeaderAtom, then its characters, then its style.
function collectTexts(b: Bytes, recs: Rec[]): TextBody[] {
  const texts: TextBody[] = []
  let cur: TextBody | null = null
  for (const r of recs) {
    if (r.type === RT.TextHeaderAtom) {
      cur = { textType: b.u32(r.off), text: '', style: null }
      texts.push(cur)
    } else if (cur && (r.type === RT.TextCharsAtom || r.type === RT.TextBytesAtom)) {
      cur.text = readText(b, r)
    } else if (cur && r.type === RT.StyleTextPropAtom) {
      cur.style = readStyleTextProp(b, r, cur.text.length)
    }
  }
  return texts
}

// ---------- shapes ----------

// Property id → value, or the bytes of a complex property.
export type Props = Record<number, number | { complex: Uint8Array }>

export type Rect = { left: number; top: number; right: number; bottom: number }

export type Shape = {
  props: Props
  shapeType: number
  group: boolean
  deleted: boolean
  ole: boolean
  flipH: boolean
  flipV: boolean
  background: boolean
  childRect?: Rect
  anchor?: Rect
  placeholder?: { type: number }
  // Index into the sheet's texts, for placeholder text kept in the slide list.
  textRef?: number
  text?: TextBody
  children?: Shape[]
}

// IMsoArray properties (vertices, segments, guides, handles, connection sites, shade colors, dash style).
const ARRAY_PROPS = new Set([0x145, 0x146, 0x151, 0x152, 0x153, 0x154, 0x155, 0x156, 0x157, 0x158, 0x197, 0x1cf])

function readProps(b: Bytes, rec: Rec, into: Props): void {
  let complex = rec.off + rec.inst * 6
  for (let i = 0; i < rec.inst; i++) {
    const o = rec.off + i * 6
    const id = b.u16(o)
    let value = b.u32(o + 2)
    const pid = id & 0x3fff
    if (id & 0x8000) {
      // Some writers leave the array's 6-byte header out of the stored length.
      if (ARRAY_PROPS.has(pid) && complex + 6 <= rec.end) {
        const raw = b.u16(complex + 4)
        if (b.u16(complex) * (raw === 0xfff0 ? 4 : raw) === value) value += 6
      }
      into[pid] = { complex: b.u8.subarray(complex, complex + value) }
      complex += value
    } else into[pid] = value
  }
}

function readAnchor(b: Bytes, r: Rec): Rect {
  if (r.type === RT.ClientAnchor && r.len === 8) {
    return { top: b.i16(r.off), left: b.i16(r.off + 2), right: b.i16(r.off + 4), bottom: b.i16(r.off + 6) }
  }
  if (r.type === RT.ClientAnchor) return { top: b.i32(r.off), left: b.i32(r.off + 4), right: b.i32(r.off + 8), bottom: b.i32(r.off + 12) }
  return { left: b.i32(r.off), top: b.i32(r.off + 4), right: b.i32(r.off + 8), bottom: b.i32(r.off + 12) }
}

function readShape(b: Bytes, sp: Rec): Shape {
  const shape: Shape = { props: {}, shapeType: 0, group: false, deleted: false, ole: false, flipH: false, flipV: false, background: false }
  for (const r of b.children(sp)) {
    switch (r.type) {
      case RT.FSP: {
        const flags = b.u32(r.off + 4)
        shape.shapeType = r.inst
        shape.group = !!(flags & 0x1)
        shape.deleted = !!(flags & 0x8)
        shape.ole = !!(flags & 0x10)
        shape.flipH = !!(flags & 0x40)
        shape.flipV = !!(flags & 0x80)
        shape.background = !!(flags & 0x400)
        break
      }
      case RT.FSPGR:
        shape.childRect = { left: b.i32(r.off), top: b.i32(r.off + 4), right: b.i32(r.off + 8), bottom: b.i32(r.off + 12) }
        break
      case RT.FOPT:
      case RT.TertiaryFOPT:
        readProps(b, r, shape.props)
        break
      case RT.ClientAnchor:
      case RT.ChildAnchor:
        shape.anchor = readAnchor(b, r)
        break
      case RT.ClientData:
        for (const c of b.children(r)) if (c.type === RT.PlaceholderAtom) shape.placeholder = { type: b.u8[c.off + 4] }
        break
      case RT.ClientTextbox: {
        const kids = b.children(r)
        const ref = kids.find((c) => c.type === RT.OutlineTextRefAtom)
        if (ref) shape.textRef = b.i32(ref.off)
        const [text] = collectTexts(b, kids)
        if (text) shape.text = text
        break
      }
    }
  }
  return shape
}

// A group's first child describes the group itself.
function readGroup(b: Bytes, spgr: Rec): Shape {
  const [first, ...rest] = b.children(spgr)
  const group = readShape(b, first)
  group.children = rest.flatMap((k) =>
    k.type === RT.SpContainer ? [readShape(b, k)] : k.type === RT.SpgrContainer ? [readGroup(b, k)] : []
  )
  return group
}

function readDrawing(b: Bytes, ppDrawing: Rec): { shapes: Shape[]; background: Shape | null } {
  const out: { shapes: Shape[]; background: Shape | null } = { shapes: [], background: null }
  const dg = b.children(ppDrawing).find((r) => r.type === RT.DgContainer)
  for (const r of dg ? b.children(dg) : []) {
    if (r.type === RT.SpgrContainer) out.shapes = readGroup(b, r).children ?? []
    else if (r.type === RT.SpContainer) {
      const s = readShape(b, r)
      if (s.background) out.background = s
    }
  }
  return out
}

// ---------- pictures ----------

export type Blip = { kind: 'emf' | 'wmf' | 'pict' | 'jpeg' | 'png' | 'bmp' | 'tiff'; data: Uint8Array }

const BLIP: Record<number, Blip['kind'] | 'dib'> = {
  0xf01a: 'emf',
  0xf01b: 'wmf',
  0xf01c: 'pict',
  0xf01d: 'jpeg',
  0xf01e: 'png',
  0xf01f: 'dib',
  0xf029: 'tiff',
  0xf02a: 'jpeg'
}
// Instances that store a second 16-byte id before the picture.
const TWO_UIDS = new Set([0x3d5, 0x217, 0x543, 0x46b, 0x6e3, 0x6e1, 0x7a9, 0x6e5])

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function readBlip(b: Bytes, o: number): Promise<Blip | null> {
  const r = b.header(o)
  const kind = BLIP[r.type]
  if (!kind) return null
  const p = r.off + (TWO_UIDS.has(r.inst) ? 32 : 16)
  if (kind === 'emf' || kind === 'wmf' || kind === 'pict') {
    // A metafile header, then the metafile, deflated unless the header says otherwise.
    const data = b.u8.subarray(p + 34, r.end)
    return { kind, data: b.u8[p + 32] === 0 ? await inflate(data) : data }
  }
  // A one-byte tag, then the picture.
  const data = b.u8.subarray(p + 1, r.end)
  if (kind !== 'dib') return { kind, data }
  // A DIB lacks the BMP file header; the pixels start after the info header and palette.
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const infoSize = dv.getUint32(0, true)
  const bits = dv.getUint16(14, true)
  const colors = dv.getUint32(32, true) || (bits <= 8 ? 1 << bits : 0)
  const bmp = new Uint8Array(14 + data.length)
  const h = new DataView(bmp.buffer)
  bmp[0] = 0x42
  bmp[1] = 0x4d
  h.setUint32(2, bmp.length, true)
  h.setUint32(10, 14 + infoSize + colors * 4, true)
  bmp.set(data, 14)
  return { kind: 'bmp', data: bmp }
}

// Picture n (pib) of the document is blips[n - 1]; most live in the Pictures stream, some inline.
async function readBlips(b: Bytes, dgg: Rec, pictures: Uint8Array | undefined): Promise<(Blip | null)[]> {
  const store = b.children(dgg).find((r) => r.type === RT.BStoreContainer)
  if (!store) return []
  const pb = pictures ? new Bytes(pictures) : null
  return Promise.all(
    b.children(store).map(async (fbse) => {
      if (fbse.type !== RT.FBSE) return readBlip(b, fbse.off - 8)
      const size = b.u32(fbse.off + 20)
      const foDelay = b.u32(fbse.off + 28)
      const inline = fbse.off + 36 + b.u8[fbse.off + 33]
      if (inline + 8 <= fbse.end) return readBlip(b, inline)
      if (pb && size > 0 && foDelay < pb.u8.length) return readBlip(pb, foDelay)
      return null
    })
  )
}

// ---------- document ----------

export type Sheet = {
  // Slides and notes point at their master's slideId; a title master at its main master's.
  slideId?: number
  masterRef?: number
  followMasterObjects?: boolean
  followMasterScheme?: boolean
  followMasterBackground?: boolean
  hidden?: boolean
  shapes: Shape[]
  background: Shape | null
  scheme?: Rgb[]
  masterStyles: MasterStyles
  // Placeholder text, which shapes reach by textRef.
  texts: TextBody[]
  notes?: Sheet | null
}

export type Ppt = {
  // Master units, 576 to the inch.
  size: { width: number; height: number }
  fonts: string[]
  masterStyles: MasterStyles
  blips: (Blip | null)[]
  masters: Sheet[]
  slides: Sheet[]
}

export async function readPpt(buf: Uint8Array): Promise<Ppt> {
  const streams = readCfb(buf)
  const doc = streams.get('PowerPoint Document')
  const cu = streams.get('Current User')
  if (!doc || !cu) throw new Error('Not a PowerPoint 97–2003 file')
  const b = new Bytes(doc)

  // Each save appends an edit; walking back from the newest, later persist directories override earlier ones.
  const edits: { lastEdit: number; dir: number; docRef: number }[] = []
  for (let o = new Bytes(cu).u32(16); ; ) {
    const r = b.header(o)
    if (r.type !== RT.UserEditAtom) throw new Error('Broken user edit chain')
    // Only an encrypted file stores the encryption session's persist id after the fixed fields.
    if (edits.length === 0 && r.len >= 32) throw new Error('Encrypted .ppt')
    edits.push({ lastEdit: b.u32(r.off + 8), dir: b.u32(r.off + 12), docRef: b.u32(r.off + 16) })
    if (edits.length > 4096) throw new Error('User edit chain loops')
    if (edits[edits.length - 1].lastEdit === 0) break
    o = edits[edits.length - 1].lastEdit
  }
  const persist = new Map<number, number>()
  for (const e of [...edits].reverse()) {
    const r = b.header(e.dir)
    for (let o = r.off; o < r.end; ) {
      const w = b.u32(o)
      const n = w >>> 20
      for (let i = 0; i < n; i++) persist.set((w & 0xfffff) + i, b.u32(o + 4 + i * 4))
      o += 4 + n * 4
    }
  }
  const at = (ref: number): Rec => {
    const offset = persist.get(ref)
    if (offset === undefined) throw new Error(`Missing persist object ${ref}`)
    return b.header(offset)
  }

  const docKids = b.children(at(edits[0].docRef))
  const docAtom = docKids.find((r) => r.type === RT.DocumentAtom)
  if (!docAtom) throw new Error('Document without a DocumentAtom')
  const size = { width: b.i32(docAtom.off), height: b.i32(docAtom.off + 4) }

  const fonts: string[] = []
  const masterStyles: MasterStyles = {}
  const env = docKids.find((r) => r.type === RT.Environment)
  for (const r of env ? b.children(env) : []) {
    if (r.type === RT.FontCollection) {
      for (const f of b.children(r)) {
        if (f.type === RT.FontEntityAtom) fonts.push(new TextDecoder('utf-16le').decode(b.u8.subarray(f.off, f.off + 64)).replace(/\0[\s\S]*$/, ''))
      }
    }
    if (r.type === RT.TxMasterStyleAtom) masterStyles[r.inst] = readMasterStyle(b, r)
  }

  const groupHolder = docKids.find((r) => r.type === RT.PPDrawingGroup)
  const dgg = groupHolder && b.children(groupHolder).find((r) => r.type === RT.DggContainer)
  const blips = dgg ? await readBlips(b, dgg, streams.get('Pictures')) : []

  // instance 0: slides, 1: masters, 2: notes. Each entry is a SlidePersistAtom followed by its placeholder text.
  type Entry = { persistRef: number; slideId: number; recs: Rec[] }
  const lists: Record<number, Entry[]> = { 0: [], 1: [], 2: [] }
  for (const r of docKids) {
    if (r.type !== RT.SlideListWithText || !lists[r.inst]) continue
    let cur: Entry | null = null
    for (const k of b.children(r)) {
      if (k.type === RT.SlidePersistAtom) {
        cur = { persistRef: b.u32(k.off), slideId: b.u32(k.off + 12), recs: [] }
        lists[r.inst].push(cur)
      } else cur?.recs.push(k)
    }
  }

  const readSheet = (e: Entry): Sheet & { slideRef?: number } => {
    const sheet: Sheet & { slideRef?: number } = { slideId: e.slideId, shapes: [], background: null, masterStyles: {}, texts: collectTexts(b, e.recs) }
    for (const k of b.children(at(e.persistRef))) {
      if (k.type === RT.SlideAtom) {
        sheet.masterRef = b.u32(k.off + 12)
        const flags = b.u16(k.off + 20)
        sheet.followMasterObjects = !!(flags & 1)
        sheet.followMasterScheme = !!(flags & 2)
        sheet.followMasterBackground = !!(flags & 4)
      }
      if (k.type === RT.NotesAtom) sheet.slideRef = b.u32(k.off)
      if (k.type === RT.SSSlideInfoAtom) sheet.hidden = !!(b.u16(k.off + 10) & 0x4)
      if (k.type === RT.PPDrawing) Object.assign(sheet, readDrawing(b, k))
      if (k.type === RT.ColorSchemeAtom && k.inst === 1) {
        sheet.scheme = Array.from({ length: 8 }, (_, i): Rgb => [b.u8[k.off + i * 4], b.u8[k.off + i * 4 + 1], b.u8[k.off + i * 4 + 2]])
      }
      if (k.type === RT.TxMasterStyleAtom) sheet.masterStyles[k.inst] = readMasterStyle(b, k)
    }
    return sheet
  }

  const notes = lists[2].map(readSheet)
  return {
    size,
    fonts,
    masterStyles,
    blips,
    masters: lists[1].map(readSheet),
    slides: lists[0].map((e) => ({ ...readSheet(e), notes: notes.find((n) => n.slideRef === e.slideId) ?? null }))
  }
}
