import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

// Only ~~double~~ strikes through: models write ranges like 20~30, and two of them in one paragraph
// would otherwise strike out the text between.
export const gfmOptions = { singleTilde: false }

const parser = unified().use(remarkParse).use(remarkGfm, gfmOptions).use(remarkMath)

type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] }

const LITERAL_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html'])
// (?<!\\): `\\[2pt]` is a LaTeX line break, and `\\(` an escaped backslash.
const BRACKET_MATH = /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]|(?<!\\)\\\(([^\n]+?)(?<!\\)\\\)/g

// remark-math does not treat `\$` inside `$…$` / `$$…$$` as an escaped dollar sign, so `$\$$`
// leaves an unclosed delimiter that swallows or breaks subsequent formulas in the paragraph.
// Replaces `\$` inside math spans with `{\char"24}` (rendered identically by KaTeX) while
// leaving code blocks, inline code, and `\$` in normal text untouched.
function replaceEscapedDollars(tex: string): string {
  let out = ''
  let i = 0
  while (i < tex.length) {
    if (tex[i] === '\\' && i + 1 < tex.length) {
      if (tex[i + 1] === '$') {
        out += '{\\char"24}'
        i += 2
        continue
      }
      out += tex.slice(i, i + 2)
      i += 2
      continue
    }
    out += tex[i]
    i++
  }
  return out
}

function escapeDollarsInMath(markdown: string): string {
  if (!markdown.includes('\\$')) return markdown
  let out = ''
  let i = 0
  while (i < markdown.length) {
    // Fenced code block at start of line
    if (i === 0 || markdown[i - 1] === '\n') {
      const fence = /^[ ]{0,3}(`{3,}|~{3,})/.exec(markdown.slice(i))
      if (fence) {
        const marker = fence[1]
        const ch = marker[0]
        const len = marker.length
        const closeRe = new RegExp(`\\n[ ]{0,3}${ch}{${len},}[ \\t]*(?=\\n|$)`)
        const rest = markdown.slice(i + fence[0].length)
        const close = closeRe.exec(rest)
        const end = close ? i + fence[0].length + close.index + close[0].length : markdown.length
        out += markdown.slice(i, end)
        i = end
        continue
      }
    }

    // Inline code span
    if (markdown[i] === '`') {
      let ticks = 0
      while (markdown[i + ticks] === '`') ticks++
      let j = i + ticks
      let found = -1
      while (j < markdown.length) {
        if (markdown[j] === '\n' && markdown[j + 1] === '\n') break
        if (markdown[j] === '`') {
          let closeTicks = 0
          while (markdown[j + closeTicks] === '`') closeTicks++
          if (closeTicks === ticks) {
            found = j + closeTicks
            break
          }
          j += closeTicks
          continue
        }
        j++
      }
      const end = found >= 0 ? found : i + ticks
      out += markdown.slice(i, end)
      i = end
      continue
    }

    // Escaped character outside math
    if (markdown[i] === '\\' && i + 1 < markdown.length) {
      out += markdown.slice(i, i + 2)
      i += 2
      continue
    }

    // Math delimiter (`$$` or `$`)
    if (markdown[i] === '$') {
      let count = 0
      while (markdown[i + count] === '$') count++
      if (count === 1 || count === 2) {
        let j = i + count
        let closeAt = -1
        while (j < markdown.length) {
          if (markdown[j] === '\\' && j + 1 < markdown.length) {
            j += 2
            continue
          }
          if (count === 1 && markdown[j] === '\n' && markdown[j + 1] === '\n') break
          if (markdown[j] === '$') {
            let closeCount = 0
            while (markdown[j + closeCount] === '$') closeCount++
            if (closeCount === count) {
              closeAt = j
              break
            }
            j += closeCount
            continue
          }
          j++
        }
        if (closeAt >= 0) {
          const delim = '$'.repeat(count)
          const body = markdown.slice(i + count, closeAt)
          out += delim + replaceEscapedDollars(body) + delim
          i = closeAt + count
          continue
        }
      }
      out += '$'.repeat(count)
      i += count
      continue
    }

    out += markdown[i]
    i++
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
