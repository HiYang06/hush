import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

// Only ~~double~~ strikes through: models write ranges like 20~30, and two of them in one paragraph
// would otherwise strike out the text between.
export const gfmOptions = { singleTilde: false }

const parser = unified().use(remarkParse).use(remarkGfm, gfmOptions).use(remarkMath)
const codeParser = unified().use(remarkParse).use(remarkGfm, gfmOptions)

type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] }

// Pairs each backslash with the character after it, so `\\$` stays an escaped backslash before a `$`.
function replaceEscapedDollars(tex: string): string {
  return tex.replace(/\\[\s\S]/g, (pair) => (pair === '\\$' ? '{\\char"24}' : pair))
}

// The text between the start of `at`'s line and `at`: an indent and/or `>` when `at` begins the line's content.
function linePrefix(markdown: string, at: number): string {
  return markdown.slice(markdown.lastIndexOf('\n', at - 1) + 1, at)
}

// Writes display math as remark-math's only reliable block form: `$$` alone on the lines before and after.
// The fences repeat the line's indent or `>` so the block stays inside the same list item or quote.
// Math that shares its line with other text stays inline.
function displayMath(markdown: string, start: number, end: number, tex: string): string {
  const prefix = linePrefix(markdown, start)
  const lineEnd = markdown.indexOf('\n', end)
  const rest = markdown.slice(end, lineEnd < 0 ? undefined : lineEnd)
  const safe = replaceEscapedDollars(tex)
  if (!/^[ \t>]*$/.test(prefix) || rest.trim()) return `$$${safe}$$`
  const opensLine = /^[ \t]*\n/.test(safe)
  const body = safe.replace(/^[ \t]*\n/, '').replace(/\n[ \t>]*$/, '')
  return `$$\n${opensLine ? body : prefix + body.trim()}\n${prefix}$$`
}

// Where the scan at `j` continues: past the code span starting there, if any. A span inside math is the
// code-only parse misreading a backtick in the formula (`\text{`(`}`), and a closer can't hide in one.
function skipCode(codeEnds: Map<number, number>, j: number): number {
  return codeEnds.get(j) ?? j
}

// The index of the `$` run of exactly `count` that closes a run opened before `from`, or -1.
// Single-dollar math cannot cross a blank line.
function findDollarClose(markdown: string, codeEnds: Map<number, number>, from: number, count: number): number {
  for (let j = from; j < markdown.length; ) {
    const after = skipCode(codeEnds, j)
    if (after > j) j = after
    else if (markdown[j] === '\\') j += 2
    else if (count === 1 && markdown.startsWith('\n\n', j)) return -1
    else if (markdown[j] !== '$') j++
    else {
      let run = 0
      while (markdown[j + run] === '$') run++
      if (run === count) return j
      j += run
    }
  }
  return -1
}

// The index of the `\)` / `\]` closing a bracket opened before `from`, or -1. Inline `\(…\)` stays on one line.
function findBracketClose(markdown: string, codeEnds: Map<number, number>, from: number, close: ')' | ']'): number {
  for (let j = from; j < markdown.length; j++) {
    j = skipCode(codeEnds, j)
    if (close === ')' && markdown[j] === '\n') return -1
    if (markdown[j] !== '\\') continue
    if (markdown[j + 1] === close) return j > from ? j : -1
    j++
  }
  return -1
}

// remark-math's tokenizer misreads much of what models write, and each misreading breaks everything after it:
// - `\(…\)` / `\[…\]` aren't math to it, and Markdown reads `\[` as an escaped `[`;
// - `$$\begin{aligned}` on one line opens a block whose first line is dropped as "meta", and
//   `\end{aligned}$$` doesn't close it, so the rest of the reply becomes one formula;
// - `\$` inside math isn't an escape, so `$\$$` leaves a delimiter open;
// - a lone `$` (an end marker `{$}`, a price `$5`) pairs with the next one and turns the prose between into math.
// So one pass decides where math is and writes it in the forms remark-math reads unambiguously: escaped `\$`
// for literal dollars, `{\char"24}` for `\$` inside math, `$$` fences on their own lines for display math.
// Code is copied through untouched.
export function normalizeMathDelimiters(markdown: string): string {
  if (!/\$|\\[([]/.test(markdown)) return markdown
  // Parsed without remark-math, whose misreadings are what this repairs and could hide a code span.
  const code: [number, number][] = []
  const walk = (node: Node): void => {
    if (node.type === 'code' || node.type === 'inlineCode') code.push([node.position!.start.offset!, node.position!.end.offset!])
    else node.children?.forEach(walk)
  }
  walk(codeParser.parse(markdown) as Node)
  const codeEnds = new Map(code)
  let out = ''
  let i = 0
  let next = 0
  while (i < markdown.length) {
    while (next < code.length && code[next][1] <= i) next++
    if (next < code.length && code[next][0] <= i) {
      out += markdown.slice(i, code[next][1])
      i = code[next][1]
      continue
    }
    const ch = markdown[i]
    if (ch === '\\') {
      const bracket = markdown[i + 1]
      const close = bracket === '(' || bracket === '[' ? findBracketClose(markdown, codeEnds, i + 2, bracket === '(' ? ')' : ']') : -1
      if (close >= 0) {
        const tex = markdown.slice(i + 2, close)
        out += bracket === '(' ? `$${replaceEscapedDollars(tex)}$` : displayMath(markdown, i, close + 2, tex)
        i = close + 2
      } else {
        out += markdown.slice(i, i + 2)
        i += 2
      }
      continue
    }
    if (ch !== '$') {
      out += ch
      i++
      continue
    }
    let count = 0
    while (markdown[i + count] === '$') count++
    const close = count <= 2 ? findDollarClose(markdown, codeEnds, i + count, count) : -1
    if (count === 1) {
      // Pandoc's rule: math hugs its delimiters, and a closing `$` isn't followed by a digit. Nor does math
      // open with closing punctuation: that's an end marker, as in `[S → ·L, $]` or `{=, $}`.
      if (close < 0 || /[\s\]}，。；：、！？）】」]/.test(markdown[i + 1]) || /\s/.test(markdown[close - 1]) || /\d/.test(markdown[close + 1] ?? '')) {
        out += '\\$'
        i++
        continue
      }
      out += `$${replaceEscapedDollars(markdown.slice(i + 1, close))}$`
      i = close + 1
      continue
    }
    if (close < 0) {
      // Still streaming `$$\begin{…}`: the fence goes on its own line now, and remend closes it with `\n$$`.
      const prefix = linePrefix(markdown, i)
      const opensBlock = count === 2 && /^[ \t>]*$/.test(prefix) && /^[ \t]*\S/.test(markdown.slice(i + 2))
      out += opensBlock ? `$$\n${prefix}` : '$'.repeat(count)
      i += count
      continue
    }
    const tex = markdown.slice(i + 2, close)
    out += tex.includes('\n') ? displayMath(markdown, i, close + 2, tex) : `$$${replaceEscapedDollars(tex)}$$`
    i = close + 2
  }
  return out
}

// Splits Markdown into its top-level blocks, so a streaming reply re-renders only the block still growing.
// Rendered one by one and joined with '\n', the blocks give the same DOM as the whole text: react-markdown
// puts exactly one '\n' text node between top-level elements, and anchor positions count it.
export function splitBlocks(markdown: string): string[] {
  const tree = parser.parse(markdown)
  // Link and footnote definitions are used by blocks elsewhere in the text and render nothing themselves.
  if (tree.children.some((n) => n.type === 'definition' || n.type === 'footnoteDefinition')) return [markdown]
  return tree.children.map((n) => markdown.slice(n.position!.start.offset, n.position!.end.offset))
}
