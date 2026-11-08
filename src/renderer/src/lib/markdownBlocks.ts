import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

// Only ~~double~~ strikes through: models write ranges like 20~30, and two of them in one paragraph
// would otherwise strike out the text between.
export const gfmOptions = { singleTilde: false }

const parser = unified().use(remarkParse).use(remarkGfm, gfmOptions).use(remarkMath)

// Splits Markdown into its top-level blocks, so a streaming reply re-renders only the block still growing.
// Rendered one by one and joined with '\n', the blocks give the same DOM as the whole text: react-markdown
// puts exactly one '\n' text node between top-level elements, and anchor positions count it.
export function splitBlocks(markdown: string): string[] {
  const tree = parser.parse(markdown)
  // Link and footnote definitions are used by blocks elsewhere in the text and render nothing themselves.
  if (tree.children.some((n) => n.type === 'definition' || n.type === 'footnoteDefinition')) return [markdown]
  return tree.children.map((n) => markdown.slice(n.position!.start.offset, n.position!.end.offset))
}
