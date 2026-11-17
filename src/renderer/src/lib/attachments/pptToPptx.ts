// .ppt → .pptx, so a PowerPoint 97–2003 file goes down the same path as a .pptx: text, page images and the
// preview (D-090). Every shape, paragraph and run gets its properties written out in full, so the result
// never depends on PresentationML's placeholder inheritance, which the .ppt's masters don't map onto.
import JSZip from 'jszip'
import { readPpt, type CharFormat, type Props, type Rgb, type Shape, type Sheet, type StyleLevel, type TextBody, type TextColor } from './ppt'

const EMU_PER_UNIT = 1587.5 // master units are 1/576 inch
const emu = (v: number): number => Math.round(v * EMU_PER_UNIT)

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const CT = 'application/vnd.openxmlformats-officedocument.presentationml'
const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
// XML 1.0 has no place for most control characters.
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ESCAPES[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')

// MSOSPT shape types → DrawingML presets; anything else is drawn as a rectangle.
const PRESET: Record<number, string> = {
  1: 'rect', 2: 'roundRect', 3: 'ellipse', 4: 'diamond', 5: 'triangle', 6: 'rtTriangle', 7: 'parallelogram',
  8: 'trapezoid', 9: 'hexagon', 10: 'octagon', 11: 'plus', 12: 'star5', 13: 'rightArrow', 15: 'homePlate',
  16: 'cube', 20: 'line', 21: 'plaque', 22: 'can', 23: 'donut', 32: 'straightConnector1', 33: 'bentConnector2',
  34: 'bentConnector3', 38: 'curvedConnector3', 55: 'chevron', 56: 'pentagon', 61: 'wedgeRectCallout',
  62: 'wedgeRoundRectCallout', 63: 'wedgeEllipseCallout', 64: 'wave', 65: 'foldedCorner', 66: 'leftArrow',
  67: 'downArrow', 68: 'upArrow', 69: 'leftRightArrow', 70: 'upDownArrow', 71: 'irregularSeal1',
  72: 'irregularSeal2', 73: 'lightningBolt', 74: 'heart', 75: 'rect', 84: 'bevel', 85: 'leftBracket',
  86: 'rightBracket', 87: 'leftBrace', 88: 'rightBrace', 109: 'flowChartProcess', 110: 'flowChartDecision',
  111: 'flowChartInputOutput', 112: 'flowChartPredefinedProcess', 114: 'flowChartDocument',
  116: 'flowChartTerminator', 120: 'flowChartConnector', 122: 'flowChartPunchedTape', 125: 'flowChartCollate',
  176: 'flowChartAlternateProcess', 202: 'rect'
}
const PH_TYPE: Record<number, string> = {
  1: 'title', 13: 'title', 17: 'title', 3: 'ctrTitle', 15: 'ctrTitle', 4: 'subTitle', 16: 'subTitle',
  2: 'body', 6: 'body', 12: 'body', 14: 'body', 18: 'body', 7: 'dt', 8: 'sldNum', 9: 'ftr', 10: 'hdr'
}
const TITLE_PLACEHOLDERS = new Set([1, 3, 13, 15, 17])
// A slide placeholder type → the master placeholder it takes its fill, line and text frame from.
const MASTER_PH: Record<number, number> = { 13: 1, 17: 1, 15: 3, 14: 2, 18: 2, 16: 4, 19: 2, 7: 7, 8: 8, 9: 9, 10: 10 }
const NOTES_BODY = 12
const DASH = ['solid', 'sysDash', 'sysDot', 'sysDashDot', 'sysDashDotDot', 'dot', 'dash', 'lgDash', 'dashDot', 'lgDashDot', 'lgDashDotDot']
const ARROW = [null, 'triangle', 'stealth', 'diamond', 'oval', 'arrow']
const COMPOUND = ['sng', 'dbl', 'thickThin', 'thinThick', 'tri']
const ANCHOR: [string, boolean][] = [['t', false], ['ctr', false], ['b', false], ['t', true], ['ctr', true], ['b', true]]
const ALIGN = ['l', 'ctr', 'r', 'just']
const TAB_ALIGN = ['l', 'ctr', 'r', 'dec']
const VERTICAL: Record<number, string> = { 1: 'vert', 2: 'vert270', 5: 'eaVert' }
const DEFAULT_SCHEME: Rgb[] = [[255, 255, 255], [0, 0, 0], [128, 128, 128], [0, 0, 0], [0, 204, 153], [51, 51, 204], [51, 153, 255], [178, 178, 178]]
// A title longer than this is body text that happens to be large.
const MAX_TITLE_CHARS = 80

// Bullets from symbol fonts, as the characters they picture: few machines have these fonts.
const SYMBOL_BULLETS: Record<string, Record<number, string>> = {
  Wingdings: { 0xa7: '▪', 0xd8: '➢', 0x6e: '■', 0x6c: '●', 0xfc: '✓', 0x71: '❑', 0x75: '◆', 0x76: '❖', 0x77: '⬥', 0x9f: '•' },
  'Monotype Sorts': { 0x48: '★', 0x6e: '■', 0x6c: '●', 0x34: '✔', 0x75: '◆', 0x76: '❖', 0x71: '❏', 0x73: '▲', 0x74: '▼' },
  Webdings: { 0x34: '▶', 0x33: '◀', 0x3d: '■' },
  Symbol: { 0xb7: '•', 0xde: '⇒', 0xae: '→', 0xa8: '♦', 0xa7: '♣' }
}

const MEDIA_MIME: Record<string, string> = {
  png: 'image/png', jpeg: 'image/jpeg', emf: 'image/x-emf', wmf: 'image/x-wmf', bmp: 'image/bmp', tiff: 'image/tiff', pict: 'image/pict'
}

const hex = ([r, g, b]: Rgb): string => [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()

const num = (props: Props, pid: number): number | undefined => {
  const v = props[pid]
  return typeof v === 'number' ? v : undefined
}
// A boolean property word: bit n is the value, bit n+16 says whether it's set at all.
function flag(props: Props, defaults: Props, pid: number, bit: number): boolean | undefined {
  for (const p of [props, defaults]) {
    const w = num(p, pid)
    if (w !== undefined && w & (1 << (bit + 16))) return !!(w & (1 << bit))
  }
  return undefined
}
const prop = (props: Props, defaults: Props, pid: number, fallback: number): number => num(props, pid) ?? num(defaults, pid) ?? fallback
// 16.16 fixed point.
const fixed = (v: number): number => (v > 0x7fffffff ? v - 0x100000000 : v) / 65536

// IMsoArray: element count, allocated count, element size (0xFFF0 means two 16-bit halves), elements.
function msoArray(bytes: Uint8Array): { n: number; size: number; dv: DataView } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const raw = dv.getUint16(4, true)
  return { n: dv.getUint16(0, true), size: raw === 0xfff0 ? 4 : raw, dv }
}

// A freeform: vertices and segment commands in the shape's geoLeft..geoBottom space.
function customGeometry(props: Props): string {
  const vertices = props[0x145]
  const segments = props[0x146]
  if (typeof vertices !== 'object') return ''
  const left = num(props, 0x140) ?? 0
  const top = num(props, 0x141) ?? 0
  const w = (num(props, 0x142) ?? 21600) - left
  const h = (num(props, 0x143) ?? 21600) - top
  const v = msoArray(vertices.complex)
  const pts = Array.from({ length: v.n }, (_, i) => {
    const o = 6 + i * v.size
    const [x, y] = v.size === 4 ? [v.dv.getInt16(o, true), v.dv.getInt16(o + 2, true)] : [v.dv.getInt32(o, true), v.dv.getInt32(o + 4, true)]
    return `<a:pt x="${x - left}" y="${y - top}"/>`
  })
  let path = ''
  let k = 0
  const take = (tag: string, count: number): void => {
    path += `<a:${tag}>${pts.slice(k, k + count).join('')}</a:${tag}>`
    k += count
  }
  if (typeof segments === 'object') {
    const seg = msoArray(segments.complex)
    for (let i = 0; i < seg.n; i++) {
      const word = seg.dv.getUint16(6 + i * seg.size, true)
      const type = word >> 13
      const count = Math.max(word & 0x1fff, 1)
      if (type === 0) for (let j = 0; j < count; j++) take('lnTo', 1)
      else if (type === 1) for (let j = 0; j < count; j++) take('cubicBezTo', 3)
      else if (type === 2) take('moveTo', 1)
      else if (type === 3) path += '<a:close/>'
      else if (type === 4) break
      // Escapes (no fill, no line, arcs…) consume vertices of their own, counted in the low byte.
      else if (type === 5) k += word & 0xff
    }
  } else {
    take('moveTo', 1)
    while (k < pts.length) take('lnTo', 1)
  }
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${w}" h="${h}">${path}</a:path></a:pathLst></a:custGeom>`
}

const spTree = (inner: string): string =>
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${inner}</p:spTree>`

type Rels = Map<string, { type: string; target: string }>
const relsXml = (rels: Rels): string =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[...rels]
    .map(([id, r]) => `<Relationship Id="${id}" Type="${r.type}" Target="${r.target}"/>`)
    .join('')}</Relationships>`

function themeXml(scheme: Rgb[], font: string | undefined, eaFont: string | undefined): string {
  const clr = (tag: string, c: Rgb): string => `<a:${tag}><a:srgbClr val="${hex(c)}"/></a:${tag}>`
  const s = scheme
  const fonts = `<a:latin typeface="${esc(font ?? 'Arial')}"/><a:ea typeface="${esc(eaFont ?? '')}"/><a:cs typeface=""/>`
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const line = `<a:ln w="9525">${fill}</a:ln>`
  const effect = '<a:effectStyle><a:effectLst/></a:effectStyle>'
  return (
    `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Converted"><a:themeElements>` +
    `<a:clrScheme name="Converted">${clr('dk1', s[1])}${clr('lt1', s[0])}${clr('dk2', s[2])}${clr('lt2', s[7])}${clr('accent1', s[4])}${clr('accent2', s[5])}${clr('accent3', s[6])}${clr('accent4', s[3])}${clr('accent5', s[4])}${clr('accent6', s[5])}${clr('hlink', s[6])}${clr('folHlink', s[7])}</a:clrScheme>` +
    `<a:fontScheme name="Converted"><a:majorFont>${fonts}</a:majorFont><a:minorFont>${fonts}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Converted"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${line.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${effect.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>` +
    `</a:themeElements></a:theme>`
  )
}

export async function pptToPptx(data: Uint8Array): Promise<ArrayBuffer> {
  const ppt = await readPpt(data)
  const zip = new JSZip()
  const fontName = (i: number | undefined): string | undefined => (i === undefined ? undefined : ppt.fonts[i])

  // Picture number → its file in the package, written once however many slides use it.
  const media = new Map<number, string>()
  const mediaFor = (pib: number): string | null => {
    const blip = ppt.blips[pib - 1]
    if (!blip) return null
    let name = media.get(pib)
    if (!name) {
      name = `image${media.size + 1}.${blip.kind}`
      zip.file(`ppt/media/${name}`, blip.data)
      media.set(pib, name)
    }
    return name
  }

  // A slide follows its master; a title master follows its main master.
  const parentOf = (sh: Sheet): Sheet | undefined =>
    sh.masterRef ? ppt.masters.find((m) => m.slideId === sh.masterRef && m !== sh) : undefined
  const schemeOf = (sh: Sheet): Rgb[] | undefined => {
    const up = parentOf(sh)
    return (up && sh.followMasterScheme !== false ? schemeOf(up) : sh.scheme) ?? (up && schemeOf(up))
  }
  const stylesOf = (sh: Sheet): Sheet['masterStyles'] => {
    const up = parentOf(sh)
    return { ...(up ? stylesOf(up) : ppt.masterStyles), ...sh.masterStyles }
  }

  // role: masters skip their placeholders, slides get a title when they have none, notes keep only the notes.
  function sheetXml(sheet: Sheet, rels: Rels, role: 'master' | 'slide' | 'notes'): { bg: string; tree: string } {
    const scheme = schemeOf(sheet) ?? DEFAULT_SCHEME
    const styles = stylesOf(sheet)
    let nextId = 2

    const imageRel = (pib: number): string | null => {
      const name = mediaFor(pib)
      if (!name) return null
      const target = `../media/${name}`
      const existing = [...rels].find(([, r]) => r.target === target)?.[0]
      if (existing) return existing
      const id = `rId${rels.size + 1}`
      rels.set(id, { type: `${REL}/image`, target })
      return id
    }

    // OfficeArtCOLORREF: RGB plus a flags byte saying it's really a scheme index or a system color.
    const color = (v: number, alpha?: number): string | null => {
      const flags = (v >>> 24) & 0xff
      if (flags & 0x10) return null
      const rgb: Rgb = flags & 0x08 ? (scheme[v & 0xff] ?? [0, 0, 0]) : [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff]
      return alpha !== undefined && alpha < 1
        ? `<a:srgbClr val="${hex(rgb)}"><a:alpha val="${Math.round(alpha * 100000)}"/></a:srgbClr>`
        : `<a:srgbClr val="${hex(rgb)}"/>`
    }
    const textColor = (c: TextColor | undefined): string | null =>
      !c ? null : `<a:srgbClr val="${hex('rgb' in c ? c.rgb : (scheme[c.scheme] ?? [0, 0, 0]))}"/>`

    function fillXml(props: Props, defaults: Props = {}): string {
      if (flag(props, defaults, 0x1bf, 4) === false) return '<a:noFill/>'
      const type = prop(props, defaults, 0x180, 0)
      if (type === 9) return '<a:noFill/>'
      const opacity = num(props, 0x182)
      const fg = color(prop(props, defaults, 0x181, 0xffffff), opacity === undefined ? undefined : fixed(opacity))
      const blip = num(props, 0x186)
      if ((type === 2 || type === 3) && blip !== undefined) {
        const id = imageRel(blip)
        if (id) return `<a:blipFill><a:blip r:embed="${id}"/>${type === 2 ? '<a:tile/>' : '<a:stretch><a:fillRect/></a:stretch>'}</a:blipFill>`
      }
      if (type >= 4 && type <= 8) {
        const shades = props[0x197]
        let stops: [string | null, number][]
        if (typeof shades === 'object' && shades.complex.length >= 6) {
          const dv = new DataView(shades.complex.buffer, shades.complex.byteOffset, shades.complex.byteLength)
          stops = Array.from({ length: dv.getUint16(0, true) }, (_, i) => [color(dv.getUint32(6 + i * 8, true)), fixed(dv.getUint32(10 + i * 8, true))])
        } else {
          stops = [[fg, 0], [color(prop(props, defaults, 0x183, 0xffffff)), 1]]
        }
        // Focus 100% runs the gradient the other way.
        if (prop(props, defaults, 0x18c, 0) === 100) stops = stops.map(([c, pos]): [string | null, number] => [c, 1 - pos]).reverse()
        const angle = fixed(prop(props, defaults, 0x18b, 0))
        const gs = stops.map(([c, pos]) => `<a:gs pos="${Math.round(pos * 100000)}">${c ?? ''}</a:gs>`).join('')
        return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst><a:lin ang="${Math.round(((angle + 90) % 360) * 60000)}" scaled="0"/></a:gradFill>`
      }
      return fg ? `<a:solidFill>${fg}</a:solidFill>` : '<a:noFill/>'
    }

    function lineXml(props: Props, defaults: Props = {}): string {
      if (flag(props, defaults, 0x1ff, 3) === false) return '<a:ln><a:noFill/></a:ln>'
      const head = ARROW[num(props, 0x1d0) ?? 0]
      const tail = ARROW[num(props, 0x1d1) ?? 0]
      return (
        `<a:ln w="${prop(props, defaults, 0x1cb, 9525)}" cmpd="${COMPOUND[num(props, 0x1cd) ?? 0] ?? 'sng'}">` +
        `<a:solidFill>${color(prop(props, defaults, 0x1c0, 0)) ?? '<a:srgbClr val="000000"/>'}</a:solidFill>` +
        `<a:prstDash val="${DASH[prop(props, defaults, 0x1ce, 0)] ?? 'solid'}"/>${head ? `<a:headEnd type="${head}"/>` : ''}${tail ? `<a:tailEnd type="${tail}"/>` : ''}</a:ln>`
      )
    }

    function shadowXml(props: Props, defaults: Props = {}): string {
      if (flag(props, defaults, 0x23f, 1) !== true) return ''
      // Offsets in EMU; 1pt down and right unless set.
      const dx = prop(props, defaults, 0x205, 25400)
      const dy = prop(props, defaults, 0x206, 25400)
      const dir = Math.round((((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360) * 60000)
      const c = color(prop(props, defaults, 0x201, 0x808080)) ?? ''
      return `<a:effectLst><a:outerShdw dist="${Math.round(Math.hypot(dx, dy))}" dir="${dir}" algn="ctr" rotWithShape="0">${c}</a:outerShdw></a:effectLst>`
    }

    // Rotations near 90° and 270° store the anchor already turned a quarter.
    function xfrm(shape: Shape, child = ''): string {
      let { left, top, right, bottom } = shape.anchor ?? { left: 0, top: 0, right: 0, bottom: 0 }
      const rot = fixed(num(shape.props, 4) ?? 0)
      const norm = ((rot % 360) + 360) % 360
      if ((norm >= 45 && norm < 135) || (norm >= 225 && norm < 315)) {
        const cx = (left + right) / 2
        const cy = (top + bottom) / 2
        const hw = (bottom - top) / 2
        const hh = (right - left) / 2
        ;[left, right, top, bottom] = [cx - hw, cx + hw, cy - hh, cy + hh]
      }
      const attrs = `${rot ? ` rot="${Math.round(rot * 60000)}"` : ''}${shape.flipH ? ' flipH="1"' : ''}${shape.flipV ? ' flipV="1"' : ''}`
      return `<a:xfrm${attrs}><a:off x="${emu(left)}" y="${emu(top)}"/><a:ext cx="${emu(right - left)}" cy="${emu(bottom - top)}"/>${child}</a:xfrm>`
    }

    // The master's defaults for a text type and level. A level stores only what differs from the one above;
    // centered body (5), half body (7) and quarter body (8) build on body (1), centered title (6) on title (0).
    function baseStyle(textType: number, level: number): StyleLevel {
      const chain = [5, 7, 8].includes(textType) ? [1, textType] : textType === 6 ? [0, 6] : [textType]
      const out: StyleLevel = { pf: {}, cf: {} }
      for (const t of chain) {
        for (const l of (styles[t] ?? styles[4] ?? []).slice(0, level + 1)) {
          Object.assign(out.pf, l.pf)
          Object.assign(out.cf, l.cf)
        }
      }
      return out
    }

    function rPr(cf: CharFormat, tag = 'a:rPr'): string {
      const latin = fontName(cf.font)
      const ea = fontName(cf.eaFont)
      const c = textColor(cf.color)
      const attrs =
        ` lang="zh-CN"${cf.size ? ` sz="${cf.size * 100}"` : ''} b="${cf.bold ? 1 : 0}" i="${cf.italic ? 1 : 0}"` +
        `${cf.underline ? ' u="sng"' : ''}${cf.position ? ` baseline="${cf.position * 1000}"` : ''}`
      return `<${tag}${attrs}>${c ? `<a:solidFill>${c}</a:solidFill>` : ''}${latin ? `<a:latin typeface="${esc(latin)}"/>` : ''}${ea ? `<a:ea typeface="${esc(ea)}"/>` : ''}</${tag}>`
    }

    // Positive: percent of a line; negative: master units (8 to the point).
    const spacing = (tag: string, v: number | undefined): string =>
      v === undefined ? '' : v >= 0 ? `<${tag}><a:spcPct val="${v * 1000}"/></${tag}>` : `<${tag}><a:spcPts val="${Math.round((-v / 8) * 100)}"/></${tag}>`

    function textXml(text: TextBody, props: Props, defaults: Props): string {
      const str = text.text
      const style = text.style ?? { paras: [{ count: str.length + 1, level: 0, pf: {} }], chars: [{ count: str.length + 1, cf: {} }] }
      // Character index → its paragraph run and character run.
      const paraAt = style.paras.flatMap((p, i) => Array<number>(p.count).fill(i))
      const charAt = style.chars.flatMap((c, i) => Array<number>(c.count).fill(i))

      const paragraphs: [number, number][] = []
      let start = 0
      for (let i = 0; i <= str.length; i++) {
        if (i < str.length && str[i] !== '\r') continue
        paragraphs.push([start, i])
        start = i + 1
      }
      const body = paragraphs.map(([s, e]) => {
        const p = style.paras[paraAt[s]] ?? style.paras[style.paras.length - 1]
        const base = baseStyle(text.textType, p.level)
        const pf = { ...base.pf, ...p.pf }
        // Without a bullet the paragraph starts where the bullet would have been.
        const indent = pf.hasBullet
          ? ` marL="${emu(pf.leftMargin ?? 0)}" indent="${emu((pf.indent ?? 0) - (pf.leftMargin ?? 0))}"`
          : ` marL="${emu(pf.indent ?? 0)}" indent="0"`
        let bullet = '<a:buNone/>'
        if (pf.hasBullet && e > s) {
          const font = pf.bulletHasFont ? fontName(pf.bulletFont) : undefined
          const bc = pf.bulletHasColor ? textColor(pf.bulletColor) : null
          const size = pf.bulletHasSize && pf.bulletSize ? (pf.bulletSize > 0 ? `<a:buSzPct val="${pf.bulletSize * 1000}"/>` : `<a:buSzPts val="${-pf.bulletSize * 100}"/>`) : ''
          const code = pf.bulletChar ?? 0x2022
          const pictured = font && code < 0x100 ? SYMBOL_BULLETS[font]?.[code] : undefined
          const face = !pictured && font ? `<a:buFont typeface="${esc(font)}"/>` : ''
          bullet = `${bc ? `<a:buClr>${bc}</a:buClr>` : ''}${size}${face}<a:buChar char="${esc(pictured ?? String.fromCharCode(code))}"/>`
        }
        const tabs = pf.tabs?.length ? `<a:tabLst>${pf.tabs.map((t) => `<a:tab pos="${emu(t.pos)}" algn="${TAB_ALIGN[t.type] ?? 'l'}"/>`).join('')}</a:tabLst>` : ''
        const attrs = ` lvl="${p.level}"${indent} algn="${ALIGN[pf.align ?? 0] ?? 'l'}"${pf.defaultTab ? ` defTabSz="${emu(pf.defaultTab)}"` : ''}`
        const pPr = `<a:pPr${attrs}>${spacing('a:lnSpc', pf.lineSpacing)}${spacing('a:spcBef', pf.spaceBefore)}${spacing('a:spcAft', pf.spaceAfter)}${bullet}${tabs}</a:pPr>`

        const runs: string[] = []
        let endCf: CharFormat = { ...base.cf, ...style.chars[charAt[s]]?.cf }
        for (let i = s; i < e; ) {
          const ci = charAt[i]
          let j = i
          // A vertical tab is a line break inside the paragraph.
          while (j < e && charAt[j] === ci && str[j] !== '\u000b') j++
          const cf = { ...base.cf, ...(style.chars[ci] ?? style.chars[style.chars.length - 1])?.cf }
          endCf = cf
          if (j > i) runs.push(`<a:r>${rPr(cf)}<a:t>${esc(str.slice(i, j))}</a:t></a:r>`)
          if (str[j] === '\u000b') {
            runs.push(`<a:br>${rPr(cf)}</a:br>`)
            j++
          }
          i = j
        }
        return `<a:p>${pPr}${runs.join('')}${rPr(endCf, 'a:endParaRPr')}</a:p>`
      })

      const ins = [0x81, 0x82, 0x83, 0x84].map((pid, i) => prop(props, defaults, pid, i % 2 ? 45720 : 91440))
      const [anchor, center] = ANCHOR[prop(props, defaults, 0x87, 0)] ?? ['t', false]
      const vert = VERTICAL[num(props, 0x88) ?? 0]
      // PowerPoint stores "don't wrap" on nearly every text box yet wraps them all when it shows the slide.
      const bodyPr = `<a:bodyPr wrap="square" lIns="${ins[0]}" tIns="${ins[1]}" rIns="${ins[2]}" bIns="${ins[3]}" anchor="${anchor}"${center ? ' anchorCtr="1"' : ''}${vert ? ` vert="${vert}"` : ''} rtlCol="0"><a:noAutofit/></a:bodyPr>`
      return `<p:txBody>${bodyPr}<a:lstStyle/>${body.join('')}</p:txBody>`
    }

    // Fill, line and text frame a slide placeholder doesn't set come from its master's placeholder.
    function inherited(shape: Shape): Props {
      if (!shape.placeholder) return {}
      const want = MASTER_PH[shape.placeholder.type]
      const fallback = want === 3 ? 1 : want === 4 ? 2 : undefined
      for (let m = parentOf(sheet); m; m = parentOf(m)) {
        const found = m.shapes.find((x) => x.placeholder?.type === want) ?? m.shapes.find((x) => x.placeholder?.type === fallback)
        if (found) return found.props
      }
      return {}
    }

    const textOf = (shape: Shape): TextBody | undefined => (shape.textRef !== undefined ? sheet.texts[shape.textRef] : shape.text)
    const flat = (list: Shape[]): Shape[] => list.flatMap((x) => (x.children ? flat(x.children) : [x]))

    // Old decks often set their titles as plain text boxes: on a slide without a title placeholder, the
    // text in the largest type (the topmost of equals) is marked the title.
    let titleShape: Shape | null = null
    if (role === 'slide') {
      const all = flat(sheet.shapes)
      if (!all.some((x) => x.placeholder && TITLE_PLACEHOLDERS.has(x.placeholder.type))) {
        let best = 0
        for (const x of all) {
          const t = textOf(x)
          const trimmed = t?.text.trim()
          if (!t || !trimmed || trimmed.length > MAX_TITLE_CHARS) continue
          const baseSize = baseStyle(t.textType, 0).cf.size ?? 18
          const size = Math.max(...(t.style?.chars ?? [{ cf: {} as CharFormat }]).map((c) => c.cf.size ?? baseSize))
          if (size > best || (size === best && titleShape && (x.anchor?.top ?? 0) < (titleShape.anchor?.top ?? 0))) {
            best = size
            titleShape = x
          }
        }
      }
    }

    function shapeXml(shape: Shape): string {
      if (shape.deleted) return ''
      const id = nextId++
      if (shape.group) {
        const c = shape.childRect
        const ch = c ? `<a:chOff x="${emu(c.left)}" y="${emu(c.top)}"/><a:chExt cx="${emu(c.right - c.left)}" cy="${emu(c.bottom - c.top)}"/>` : ''
        return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${xfrm(shape, ch)}</p:grpSpPr>${(shape.children ?? []).map(shapeXml).join('')}</p:grpSp>`
      }
      const pib = num(shape.props, 0x104)
      // A picture, or an embedded object shown as its last picture.
      if (pib !== undefined && (shape.shapeType === 75 || shape.ole)) {
        const rid = imageRel(pib)
        if (rid) {
          const crop = [0x102, 0x100, 0x103, 0x101].map((pid) => Math.round(fixed(num(shape.props, pid) ?? 0) * 100000))
          const src = crop.some(Boolean) ? `<a:srcRect l="${crop[0]}" t="${crop[1]}" r="${crop[2]}" b="${crop[3]}"/>` : ''
          const ln = flag(shape.props, {}, 0x1ff, 3) ? lineXml(shape.props) : ''
          return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/>${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(shape)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${ln}</p:spPr></p:pic>`
        }
      }
      const defs = inherited(shape)
      const prst = PRESET[shape.shapeType] ?? 'rect'
      const isLine = prst === 'line' || prst.includes('Connector')
      const text = textOf(shape)
      const ph = shape === titleShape ? 'title' : shape.placeholder && PH_TYPE[shape.placeholder.type]
      const geom = customGeometry(shape.props) || `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`
      const spPr = `<p:spPr>${xfrm(shape)}${geom}${isLine ? '<a:noFill/>' : fillXml(shape.props, defs)}${lineXml(shape.props, defs)}${shadowXml(shape.props, defs)}</p:spPr>`
      const body = text && text.text.length > 0 ? textXml(text, shape.props, defs) : ''
      const nvPr = ph ? `<p:nvPr><p:ph type="${ph}"/></p:nvPr>` : '<p:nvPr/>'
      return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr${shape.shapeType === 202 ? ' txBox="1"' : ''}/>${nvPr}</p:nvSpPr>${spPr}${body}</p:sp>`
    }

    // A title master draws its main master's objects and background too, when it follows them.
    const up = role === 'master' ? parentOf(sheet) : undefined
    const bgShape = sheet.background ?? (up && sheet.followMasterBackground !== false ? up.background : null)
    const bg = bgShape ? `<p:bg><p:bgPr>${fillXml(bgShape.props)}<a:effectLst/></p:bgPr></p:bg>` : ''
    // A master's placeholders are templates for its slides, never drawn themselves. Of a notes page only
    // the notes are kept: the reader draws the slide picture itself.
    const own = sheet.shapes.filter((s) => (role === 'master' ? !s.placeholder : role === 'notes' ? s.placeholder?.type === NOTES_BODY : true))
    const fromUp = up && sheet.followMasterObjects !== false ? up.shapes.filter((s) => !s.placeholder) : []
    return { bg, tree: [...fromUp, ...own].map(shapeXml).join('') }
  }

  // ---------- masters: each becomes a slide master with one blank layout and its own theme ----------
  const masterNumber = new Map<number | undefined, number>()
  ppt.masters.forEach((m, i) => {
    const n = i + 1
    masterNumber.set(m.slideId, n)
    const rels: Rels = new Map([
      ['rId1', { type: `${REL}/slideLayout`, target: `../slideLayouts/slideLayout${n}.xml` }],
      ['rId2', { type: `${REL}/theme`, target: `../theme/theme${n}.xml` }]
    ])
    const { bg, tree } = sheetXml(m, rels, 'master')
    zip.file(
      `ppt/slideMasters/slideMaster${n}.xml`,
      `${XML}<p:sldMaster ${NS}><p:cSld>${bg}${spTree(tree)}</p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="${2147483648 + ppt.masters.length + i}" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`
    )
    zip.file(`ppt/slideMasters/_rels/slideMaster${n}.xml.rels`, relsXml(rels))
    zip.file(`ppt/slideLayouts/slideLayout${n}.xml`, `${XML}<p:sldLayout ${NS} preserve="1"><p:cSld name="Blank">${spTree('')}</p:cSld></p:sldLayout>`)
    zip.file(
      `ppt/slideLayouts/_rels/slideLayout${n}.xml.rels`,
      relsXml(new Map([['rId1', { type: `${REL}/slideMaster`, target: `../slideMasters/slideMaster${n}.xml` }]]))
    )
    const body = stylesOf(m)[1]?.[0]?.cf ?? {}
    zip.file(`ppt/theme/theme${n}.xml`, themeXml(schemeOf(m) ?? DEFAULT_SCHEME, fontName(body.font), fontName(body.eaFont)))
  })

  // ---------- slides and their notes ----------
  const notesPages: number[] = []
  ppt.slides.forEach((s, i) => {
    const n = i + 1
    const rels: Rels = new Map([
      ['rId1', { type: `${REL}/slideLayout`, target: `../slideLayouts/slideLayout${masterNumber.get(s.masterRef) ?? 1}.xml` }]
    ])
    const { bg, tree } = sheetXml(s, rels, 'slide')
    // Old PowerPoint also leaves date and page-number boxes on every notes page; only the notes body counts.
    const notes = s.notes
    const notesText = notes?.shapes
      .filter((x) => x.placeholder?.type === NOTES_BODY)
      .map((x) => (x.textRef !== undefined ? notes.texts[x.textRef] : x.text)?.text ?? '')
      .join('')
    if (notes && notesText?.trim()) {
      const notesRels: Rels = new Map([
        ['rId1', { type: `${REL}/notesMaster`, target: '../notesMasters/notesMaster1.xml' }],
        ['rId2', { type: `${REL}/slide`, target: `../slides/slide${n}.xml` }]
      ])
      const page = sheetXml(notes, notesRels, 'notes')
      zip.file(`ppt/notesSlides/notesSlide${n}.xml`, `${XML}<p:notes ${NS}><p:cSld>${spTree(page.tree)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`)
      zip.file(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, relsXml(notesRels))
      rels.set(`rId${rels.size + 1}`, { type: `${REL}/notesSlide`, target: `../notesSlides/notesSlide${n}.xml` })
      notesPages.push(n)
    }
    const attrs = `${s.followMasterObjects === false ? ' showMasterSp="0"' : ''}${s.hidden ? ' show="0"' : ''}`
    zip.file(
      `ppt/slides/slide${n}.xml`,
      `${XML}<p:sld ${NS}${attrs}><p:cSld>${s.followMasterBackground ? '' : bg}${spTree(tree)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    )
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, relsXml(rels))
  })
  if (notesPages.length > 0) {
    zip.file('ppt/notesMasters/notesMaster1.xml', `${XML}<p:notesMaster ${NS}><p:cSld>${spTree('')}</p:cSld>${CLR_MAP}</p:notesMaster>`)
    zip.file('ppt/notesMasters/_rels/notesMaster1.xml.rels', relsXml(new Map([['rId1', { type: `${REL}/theme`, target: '../theme/theme1.xml' }]])))
  }

  // ---------- package ----------
  const extensions = [...new Set([...media.values()].map((name) => name.slice(name.lastIndexOf('.') + 1)))]
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>`,
    ...ppt.masters.map(
      (_, i) =>
        `<Override PartName="/ppt/slideMasters/slideMaster${i + 1}.xml" ContentType="${CT}.slideMaster+xml"/>` +
        `<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="${CT}.slideLayout+xml"/>` +
        `<Override PartName="/ppt/theme/theme${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`
    ),
    ...ppt.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}.slide+xml"/>`),
    ...notesPages.map((n) => `<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="${CT}.notesSlide+xml"/>`),
    ...(notesPages.length > 0 ? [`<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT}.notesMaster+xml"/>`] : [])
  ]
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${extensions
      .map((e) => `<Default Extension="${e}" ContentType="${MEDIA_MIME[e]}"/>`)
      .join('')}${overrides.join('')}</Types>`
  )
  zip.file('_rels/.rels', relsXml(new Map([['rId1', { type: `${REL}/officeDocument`, target: 'ppt/presentation.xml' }]])))

  const presRels: Rels = new Map()
  const add = (type: string, target: string): string => {
    const id = `rId${presRels.size + 1}`
    presRels.set(id, { type: `${REL}/${type}`, target })
    return id
  }
  const masterIds = ppt.masters.map((_, i) => add('slideMaster', `slideMasters/slideMaster${i + 1}.xml`))
  const slideIds = ppt.slides.map((_, i) => add('slide', `slides/slide${i + 1}.xml`))
  add('theme', 'theme/theme1.xml')
  const notesMasterId = notesPages.length > 0 ? add('notesMaster', 'notesMasters/notesMaster1.xml') : null
  zip.file(
    'ppt/presentation.xml',
    `${XML}<p:presentation ${NS}>` +
      `<p:sldMasterIdLst>${masterIds.map((id, i) => `<p:sldMasterId id="${2147483648 + i}" r:id="${id}"/>`).join('')}</p:sldMasterIdLst>` +
      (notesMasterId ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterId}"/></p:notesMasterIdLst>` : '') +
      `<p:sldIdLst>${slideIds.map((id, i) => `<p:sldId id="${256 + i}" r:id="${id}"/>`).join('')}</p:sldIdLst>` +
      `<p:sldSz cx="${emu(ppt.size.width)}" cy="${emu(ppt.size.height)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  )
  zip.file('ppt/_rels/presentation.xml.rels', relsXml(presRels))
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
}
