// The marker a reply writes after a sentence it got from a web source, like [3] (docs/plans/2026-10-25-web-search.md).
// Only numbers of the reply's own sources count, so an ordinary "[1]" in other text stays text.
const MARKER = /\[(\d{1,3})\]/g

export type CitationPiece = { text: string } | { n: number }

export function splitCitations(text: string, numbers: ReadonlySet<number>): CitationPiece[] {
  const pieces: CitationPiece[] = []
  let last = 0
  for (const match of text.matchAll(MARKER)) {
    const n = Number(match[1])
    if (!numbers.has(n)) continue
    // Models write "低 [1]"; the badge sits right after the word, as a footnote mark would.
    const before = text.slice(last, match.index).replace(/[ \t]+$/, '')
    if (before) pieces.push({ text: before })
    pieces.push({ n })
    last = match.index + match[0].length
  }
  if (last < text.length) pieces.push({ text: text.slice(last) })
  return pieces
}

export function stripCitations(text: string, numbers: ReadonlySet<number>): string {
  return splitCitations(text, numbers)
    .map((p) => ('text' in p ? p.text : ''))
    .join('')
}
