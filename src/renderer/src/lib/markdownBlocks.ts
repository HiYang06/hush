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

const LITERAL_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html'])
// (?<!\\): `\\[2pt]` is a LaTeX line break, and `\\(` an escaped backslash.
const BRACKET_MATH = /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]|(?<!\\)\\\(([^\n]+?)(?<!\\)\\\)/g

// Pairs each backslash with the character after it, so `\\$` stays an escaped backslash before a `$`.
function replaceEscapedDollars(tex: string): string {
  return tex.replace(/\\[\s\S]/g, (pair) => (pair === '\\$' ? '{\\char"24}' : pair))
}

// remark-math does not treat `\$` inside `$…$` / `$$…$$` as an escaped dollar sign, so `$\$$`
// leaves an unclosed delimiter that swallows or breaks subsequent formulas in the paragraph.
// Replaces `\$` inside math spans with `{\char"24}` (rendered identically by KaTeX) while
// leaving code, and `\$` in normal text, untouched.
function escapeDollarsInMath(markdown: string): string {
  if (!markdown.includes('\\$')) return markdown
  // Parsed without remark-math: its misreading of `\$` is what this repairs, and could hide a code span.
  const code: [number, number][] = []
  const walk = (node: Node): void => {
    if (node.type === 'code' || node.type === 'inlineCode') code.push([node.position!.start.offset!, node.position!.end.offset!])
    else node.children?.forEach(walk)
  }
  walk(codeParser.parse(markdown) as Node)
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
    if (markdown[i] === '\\') {
      out += markdown.slice(i, i + 2)
      i += 2
      continue
    }
    if (markdown[i] !== '$') {
      out += markdown[i++]
      continue
    }
    let count = 0
    while (markdown[i + count] === '$') count++
    let closeAt = -1
    for (let j = i + count; count <= 2 && j < markdown.length; ) {
      if (markdown[j] === '\\') j += 2
      else if (count === 1 && markdown.startsWith('\n\n', j)) break
      else if (markdown[j] !== '$') j++
      else {
        let closeCount = 0
        while (markdown[j + closeCount] === '$') closeCount++
        if (closeCount === count) {
          closeAt = j
          break
        }
        j += closeCount
      }
    }
    const delim = '$'.repeat(count)
    if (closeAt < 0) {
      out += delim
      i += count
      continue
    }
    out += delim + replaceEscapedDollars(markdown.slice(i + count, closeAt)) + delim
    i = closeAt + count
  }
  return out
}

// Many models write math as \(…\) and \[…\]; remark-math only knows $…$ and $$…$$, and Markdown reads
// `\[` as an escaped `[`. Rewrites them outside code and existing math.
export function normalizeMathDelimiters(markdown: string): string {
  let result = escapeDollarsInMath(markdown)
  if (!result.includes('\\(') && !result.includes('\\[')) return result
  const literal: [number, number][] = []
  const walk = (node: Node): void => {
    if (LITERAL_TYPES.has(node.type)) literal.push([node.position!.start.offset!, node.position!.end.offset!])
    else node.children?.forEach(walk)
  }
  walk(parser.parse(result) as Node)
  return result.replace(BRACKET_MATH, (match, display: string | undefined, inline: string | undefined, at: number) => {
    const end = at + match.length
    if (literal.some(([s, e]) => at < e && end > s)) return match
    if (inline !== undefined) return `$${replaceEscapedDollars(inline)}$`
    // A \[…\] alone on its line(s) becomes a $$ block; the fences repeat the line's indent or `>`
    // so it stays inside the same list item or quote.
    const lineStart = result.lastIndexOf('\n', at - 1) + 1
    const prefix = result.slice(lineStart, at)
    const lineEnd = result.indexOf('\n', end)
    const rest = result.slice(end, lineEnd < 0 ? undefined : lineEnd)
    const safeDisplay = replaceEscapedDollars(display!)
    if (!/^[ \t>]*$/.test(prefix) || rest.trim()) return `$$${safeDisplay}$$`
    const opensLine = /^[ \t]*\n/.test(safeDisplay)
    const body = safeDisplay.replace(/^[ \t]*\n/, '').replace(/\n[ \t>]*$/, '')
    return `$$\n${opensLine ? '' : prefix}${opensLine ? body : body.trim()}\n${prefix}$$`
  })
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
