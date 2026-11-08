// Pure: rebuilds a PDF page's lines from pdf.js text items by position (D-077). pdf.js's own hasEOL
// breaks a line wherever the baseline moves, which shreds formulas (sub- and superscripts) and tables.

// x, y: where the run starts, in PDF units (y grows upwards); size: the font size.
export type TextRun = { str: string; x: number; y: number; size: number; width: number }

export type Line = { text: string; size: number }

const CJK = /[⺀-鿿가-힯＀-￯]/

// Item order is kept, since it follows the reading order across columns; geometry only decides
// where one line ends and whether two runs need a space between them.
export function assembleLines(runs: TextRun[]): Line[] {
  const lines: Line[] = []
  let current: { text: string; size: number; y: number; right: number; space: boolean } | null = null
  for (const run of runs) {
    if (!run.str.trim()) {
      if (current) current.space = true
      continue
    }
    const size = Math.max(current?.size ?? 0, run.size)
    // Sub- and superscripts sit less than half a line off the baseline; the next line sits a full line off.
    const sameLine =
      current !== null && Math.abs(run.y - current.y) <= size * 0.5 && run.x >= current.right - size * 2
    if (!current || !sameLine) {
      if (current) lines.push({ text: current.text.trim(), size: current.size })
      current = { text: run.str, size: run.size, y: run.y, right: run.x + run.width, space: false }
      continue
    }
    const gap = run.x - current.right
    const between = CJK.test(current.text.slice(-1)) && CJK.test(run.str[0])
    // Justified CJK text has small gaps between characters that are not spaces.
    const needsSpace = current.space || gap > size * (between ? 1 : 0.15)
    if (needsSpace && !/\s$/.test(current.text) && !/^\s/.test(run.str)) current.text += ' '
    current.text += run.str
    current.right = Math.max(current.right, run.x + run.width)
    current.space = false
    if (run.size > current.size) {
      current.size = run.size
      current.y = run.y
    }
  }
  if (current) lines.push({ text: current.text.trim(), size: current.size })
  return lines.filter((l) => l.text)
}

const MAX_HEADING_CHARS = 80

// The page's largest text, when it stands out from the rest; consecutive lines of that size (a title
// that wraps) join up.
export function pageHeading(lines: Line[]): string {
  if (lines.length === 0) return ''
  const max = Math.max(...lines.map((l) => l.size))
  const isMax = (l: Line): boolean => l.size >= max - 0.5
  const rest = lines.filter((l) => !isMax(l))
  if (rest.length === 0) return ''
  // The size most of the other text is set in, weighted by length.
  const sizes = rest.flatMap((l) => Array<number>(l.text.length).fill(l.size)).sort((a, b) => a - b)
  if (max < sizes[Math.floor(sizes.length / 2)] * 1.15) return ''
  const start = lines.findIndex(isMax)
  const heading: string[] = []
  for (const line of lines.slice(start)) {
    if (!isMax(line)) break
    heading.push(line.text)
  }
  const text = heading.join(' ').replace(/\s+/g, ' ').trim()
  return text.length > MAX_HEADING_CHARS ? `${text.slice(0, MAX_HEADING_CHARS)}…` : text
}

const FIGURE_CAPTION = /^(Figure|Fig\.|图)\s*\d+/
const TABLE_CAPTION = /^(Table|表)\s*\d+/

// A caption line, not a mention in a sentence: the line starts with it.
export function captionTags(lines: Line[]): ('figure' | 'table')[] {
  const tags = new Set<'figure' | 'table'>()
  for (const { text } of lines) {
    if (FIGURE_CAPTION.test(text)) tags.add('figure')
    if (TABLE_CAPTION.test(text)) tags.add('table')
  }
  return [...tags]
}
