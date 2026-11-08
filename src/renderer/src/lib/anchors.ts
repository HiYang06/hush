import { termMatches } from '@shared/search'

// Converts between a selection in a rendered message and "position + quote + context" (architecture.md).
// Positions count characters of the message's plain text: what the reader sees, except that a formula
// counts as its LaTeX source and app chrome (marked data-anchor-skip) doesn't count at all.

export type Anchor = { quote: string; start: number; end: number; prefix: string; suffix: string }

const CONTEXT_LENGTH = 30

type Segment =
  | { kind: 'text'; node: Text; start: number; end: number }
  | { kind: 'math'; el: Element; start: number; end: number }

type TextModel = { text: string; segments: Segment[] }

// ---------- Pure part: works on the plain text only ----------

export function makeAnchor(text: string, start: number, end: number): Anchor {
  return {
    quote: text.slice(start, end),
    start,
    end,
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + CONTEXT_LENGTH)
  }
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

// The stored position first; if the quote isn't there any more, the occurrence whose surroundings
// match the stored context best, the nearest one breaking ties. null when the quote is gone.
export function locateAnchor(
  text: string,
  anchor: Pick<Anchor, 'quote' | 'start' | 'end' | 'prefix' | 'suffix'>
): { start: number; end: number } | null {
  const { quote } = anchor
  if (!quote) return null
  if (text.slice(anchor.start, anchor.end) === quote) return { start: anchor.start, end: anchor.end }

  let best: { start: number; score: number; distance: number } | null = null
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    const score =
      commonSuffixLength(text.slice(Math.max(0, i - anchor.prefix.length), i), anchor.prefix) +
      commonPrefixLength(text.slice(i + quote.length, i + quote.length + anchor.suffix.length), anchor.suffix)
    const distance = Math.abs(i - anchor.start)
    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = { start: i, score, distance }
    }
  }
  return best && { start: best.start, end: best.start + quote.length }
}

// ---------- DOM part ----------

function texOf(katex: Element): string {
  return katex.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? katex.textContent ?? ''
}

function buildModel(root: Element): TextModel {
  const segments: Segment[] = []
  let text = ''
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node as Text).data
      if (value) {
        segments.push({ kind: 'text', node: node as Text, start: text.length, end: text.length + value.length })
        text += value
      }
      return
    }
    if (!(node instanceof Element) || node.hasAttribute('data-anchor-skip')) return
    if (node.classList.contains('katex')) {
      const tex = texOf(node)
      segments.push({ kind: 'math', el: node, start: text.length, end: text.length + tex.length })
      text += tex
      return
    }
    for (const child of node.childNodes) walk(child)
  }
  walk(root)
  return { text, segments }
}

function segmentRange(seg: Segment): Range {
  const r = document.createRange()
  if (seg.kind === 'text') r.selectNodeContents(seg.node)
  else r.selectNode(seg.el)
  return r
}

// A boundary inside a formula snaps to the formula's start or end: formulas are taken whole.
function offsetOf(model: TextModel, node: Node, offset: number, side: 'start' | 'end'): number {
  const el = node instanceof Element ? node : node.parentElement
  const katex = el?.closest('.katex')
  for (const seg of model.segments) {
    if (seg.kind === 'math' && seg.el === katex) return side === 'start' ? seg.start : seg.end
    if (seg.kind === 'text' && seg.node === node) return seg.start + Math.min(offset, seg.node.data.length)
    const r = segmentRange(seg)
    const position = r.comparePoint(node, offset)
    if (position < 0) return seg.start
    // Not inside the formula (handled above), so the point sits right on its edge.
    if (position === 0) return node === r.startContainer && offset === r.startOffset ? seg.start : seg.end
  }
  return model.text.length
}

function trimmed(text: string, start: number, end: number): { start: number; end: number } {
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  return { start, end }
}

// null when the selection holds nothing but whitespace or app chrome.
export function selectionToAnchor(root: Element, range: Range): Anchor | null {
  const model = buildModel(root)
  const { start, end } = trimmed(
    model.text,
    offsetOf(model, range.startContainer, range.startOffset, 'start'),
    offsetOf(model, range.endContainer, range.endOffset, 'end')
  )
  return start < end ? makeAnchor(model.text, start, end) : null
}

// The same selection with any formula it touches taken whole, so the reader sees what gets stored.
export function expandToFormulas(range: Range): Range {
  const expanded = range.cloneRange()
  const startKatex = (range.startContainer instanceof Element
    ? range.startContainer
    : range.startContainer.parentElement
  )?.closest('.katex')
  const endKatex = (range.endContainer instanceof Element
    ? range.endContainer
    : range.endContainer.parentElement
  )?.closest('.katex')
  if (startKatex) expanded.setStartBefore(startKatex)
  if (endKatex) expanded.setEndAfter(endKatex)
  return expanded
}

function pointAt(model: TextModel, offset: number, side: 'start' | 'end'): [Node, number] | null {
  // At a boundary between two segments, a start belongs to the next one and an end to the previous one.
  const seg = model.segments.find((s) => (side === 'start' ? s.end > offset : s.end >= offset && s.start < offset))
  if (!seg) return null
  if (seg.kind === 'text') return [seg.node, offset - seg.start]
  const parent = seg.el.parentNode
  if (!parent) return null
  const index = Array.prototype.indexOf.call(parent.childNodes, seg.el) as number
  return side === 'start' ? [parent, index] : [parent, index + 1]
}

function rangeAt(model: TextModel, startOffset: number, endOffset: number): Range | null {
  const start = pointAt(model, startOffset, 'start')
  const end = pointAt(model, endOffset, 'end')
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(...start)
  range.setEnd(...end)
  return range
}

export function anchorToRange(root: Element, anchor: Anchor): Range | null {
  const model = buildModel(root)
  const found = locateAnchor(model.text, anchor)
  return found && rangeAt(model, found.start, found.end)
}

// Positions alone, for a clip: its link keeps no quote to check against, and a finished reply's text
// never changes (only the last round can be regenerated, which deletes the reply).
export function offsetsToRange(root: Element, start: number, end: number): Range | null {
  return start < end ? rangeAt(buildModel(root), start, end) : null
}

// Search hits in the rendered text, for highlighting after a ⌘K jump.
export function termRanges(root: Element, terms: string[]): Range[] {
  const model = buildModel(root)
  return termMatches(model.text, terms).flatMap((m) => rangeAt(model, m.from, m.to) ?? [])
}
