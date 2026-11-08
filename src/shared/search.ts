// Shared by the search query (main) and the highlighting after a jump (renderer), so both agree on
// what counts as a hit.

export function searchTerms(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/).filter(Boolean))]
}

// Every occurrence of any term, ignoring case, in order and without overlaps; `gap` may sit between a
// term's characters.
function matches(text: string, terms: string[], gap: string): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = []
  for (const term of terms) {
    const pattern = [...term].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(gap)
    for (const m of text.matchAll(new RegExp(pattern, 'giu'))) found.push({ from: m.index, to: m.index + m[0].length })
  }
  found.sort((a, b) => a.from - b.from || b.to - a.to)
  const merged: { from: number; to: number }[] = []
  for (const m of found) {
    const last = merged[merged.length - 1]
    if (last && m.from < last.to) last.to = Math.max(last.to, m.to)
    else merged.push({ ...m })
  }
  return merged
}

export function termMatches(text: string, terms: string[]): { from: number; to: number }[] {
  return matches(text, terms, '')
}

// The same hits in Markdown source, where emphasis and code markers can sit inside a term ('**特**征值');
// for the note editor, which shows the source.
export function sourceTermMatches(markdown: string, terms: string[]): { from: number; to: number }[] {
  return matches(markdown, terms, '[*_~`]*')
}

const SNIPPET_SIDE = 30

// Roughly what the reader sees: markers dropped, link text kept. What full-text search indexes (D-049);
// good enough for that, not a parser.
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|(>\s?)+|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[^\w*])\*(\S[^*\n]*?)\*/g, '$1$2')
}

// Text around the first hit in plain text, on one line; ellipses mark what was cut.
export function snippet(plain: string, terms: string[]): string {
  const flat = plain.replace(/\s+/g, ' ').trim()
  const first = termMatches(flat, terms)[0]
  if (!first) return flat.slice(0, SNIPPET_SIDE * 2)
  const start = Math.max(0, first.from - SNIPPET_SIDE)
  const end = Math.min(flat.length, first.to + SNIPPET_SIDE)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
