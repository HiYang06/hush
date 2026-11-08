// Draws marks (background), threads (dashed underline) and clips (solid underline) with the CSS Custom
// Highlight API, so React's DOM is never touched (D-009), and answers which of them sit under a point.

import type { NoteClipSource } from '@shared/types'

export type Decoration =
  | { kind: 'mark'; id: string; color: string }
  | { kind: 'thread'; id: string }
  | { kind: 'clip'; clip: NoteClipSource }

const owners = new Map<AbstractRange, Decoration>()
const rangesByMessage = new Map<string, Range[]>()

function highlightName(d: Decoration): string {
  return d.kind === 'mark' ? `mark-${d.color}` : d.kind
}

function highlightFor(name: string): Highlight {
  let highlight = CSS.highlights.get(name)
  if (!highlight) {
    highlight = new Highlight()
    // Where a thread overlaps a mark, the mark's background would otherwise hide the underline; over a
    // clip's underline, the thread's wins, since it's the one that opens something in place.
    if (name === 'thread') highlight.priority = 1
    CSS.highlights.set(name, highlight)
  }
  return highlight
}

export function clearMessage(messageId: string): void {
  for (const range of rangesByMessage.get(messageId) ?? []) {
    const decoration = owners.get(range)
    if (decoration) CSS.highlights.get(highlightName(decoration))?.delete(range)
    owners.delete(range)
  }
  rangesByMessage.delete(messageId)
}

export function drawMessage(messageId: string, items: { range: Range; decoration: Decoration }[]): void {
  clearMessage(messageId)
  for (const { range, decoration } of items) {
    highlightFor(highlightName(decoration)).add(range)
    owners.set(range, decoration)
  }
  rangesByMessage.set(messageId, items.map((i) => i.range))
}

// A mark being written shows in its category's color, since focusing its comment box drops the selection.
// It has no owner, so clicking it opens nothing.
export function previewMark(range: Range, color: string): () => void {
  const highlight = highlightFor(`mark-${color}`)
  highlight.add(range)
  return () => highlight.delete(range)
}

// Every mark, thread and clip drawn under the point; several threads when they overlap there.
export function decorationsAt(x: number, y: number): Decoration[] {
  return CSS.highlights
    .highlightsFromPoint(x, y)
    .flatMap((hit) => hit.ranges.flatMap((r) => owners.get(r) ?? []))
}

// Where a jump lands (a ⌘K hit, a mark) flashes for a moment; it belongs to nothing, so clicking it opens nothing.
export function flashPassages(ranges: Range[], ms: number): void {
  const highlight = new Highlight(...ranges)
  CSS.highlights.set('search', highlight)
  setTimeout(() => {
    if (CSS.highlights.get('search') === highlight) CSS.highlights.delete('search')
  }, ms)
}
