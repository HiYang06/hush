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

// Many models write math as \(…\) and \[…\]; remark-math only knows $…$ and $$…$$, and Markdown reads
// `\[` as an escaped `[`. Rewrites them outside code and existing math.
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes('\\(') && !markdown.includes('\\[')) return markdown
  const literal: [number, number][] = []
  const walk = (node: Node): void => {
    if (LITERAL_TYPES.has(node.type)) literal.push([node.position!.start.offset!, node.position!.end.offset!])
    else node.children?.forEach(walk)
  }
  walk(parser.parse(markdown) as Node)
  return markdown.replace(BRACKET_MATH, (match, display: string | undefined, inline: string | undefined, at: number) => {
    const end = at + match.length
    if (literal.some(([s, e]) => at < e && end > s)) return match
    if (inline !== undefined) return `$${inline}$`
    // A \[…\] alone on its line(s) becomes a $$ block; the fences repeat the line's indent or `>`
    // so it stays inside the same list item or quote.
    const lineStart = markdown.lastIndexOf('\n', at - 1) + 1
    const prefix = markdown.slice(lineStart, at)
    const lineEnd = markdown.indexOf('\n', end)
    const rest = markdown.slice(end, lineEnd < 0 ? undefined : lineEnd)
    if (!/^[ \t>]*$/.test(prefix) || rest.trim()) return `$$${display}$$`
    const opensLine = /^[ \t]*\n/.test(display!)
    const body = display!.replace(/^[ \t]*\n/, '').replace(/\n[ \t>]*$/, '')
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
