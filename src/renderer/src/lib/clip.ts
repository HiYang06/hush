// Turns a selection in a rendered reply back into Markdown for clipping, so bold, lists, code and formulas
// survive. Rendered HTML is converted rather than mapped back to the reply's source: source positions
// only exist per block, while the DOM range is exact down to the character.
import type { Element as HastElement, Nodes as HastNodes } from 'hast'
import { fromDom } from 'hast-util-from-dom'
import { defaultHandlers, toMdast, type Handle } from 'hast-util-to-mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { mathToMarkdown } from 'mdast-util-math'
import { toMarkdown } from 'mdast-util-to-markdown'

// ---------- Pure part: hast → Markdown ----------

function classesOf(node: HastElement): string[] {
  const value = node.properties.className
  return Array.isArray(value) ? value.map(String) : []
}

function textOf(node: HastNodes): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

function find(node: HastNodes, test: (el: HastElement) => boolean): HastElement | null {
  if (node.type === 'element' && test(node)) return node
  if (!('children' in node)) return null
  for (const child of node.children) {
    const hit = find(child, test)
    if (hit) return hit
  }
  return null
}

// KaTeX keeps the formula's source in an <annotation>; the rendered glyphs are useless as Markdown.
function texOf(katex: HastElement): string {
  const annotation = find(katex, (el) => el.tagName === 'annotation')
  return (annotation ? textOf(annotation) : textOf(katex)).trim()
}

const span: Handle = (state, node) => {
  const classes = classesOf(node)
  if (classes.includes('katex-display')) return { type: 'math', value: texOf(node) }
  if (classes.includes('katex')) return { type: 'inlineMath', value: texOf(node) }
  return defaultHandlers.span(state, node)
}

// ShikiCodeBlock: a header (language, copy button) that isn't code, then Shiki's <pre>.
const div: Handle = (state, node) => {
  if (!classesOf(node).includes('code-block-wrapper')) return defaultHandlers.div(state, node)
  const pre = find(node, (el) => el.tagName === 'pre')
  const lang = node.properties.dataLanguage
  return {
    type: 'code',
    lang: typeof lang === 'string' && lang !== 'text' ? lang : null,
    value: (pre ? textOf(pre) : '').replace(/\n$/, '')
  }
}

// A citation badge (MarkdownContent's Citation) keeps its source as a link, so the note knows where it came from.
const sup: Handle = (state, node) => {
  const url = node.properties.dataUrl
  if (!classesOf(node).includes('cite') || typeof url !== 'string') return defaultHandlers.sup(state, node)
  return { type: 'link', url, children: [{ type: 'text', value: `[${String(node.properties.dataCite)}]` }] }
}

export function hastToMarkdown(tree: HastNodes): string {
  const mdast = toMdast(tree, { handlers: { span, div, sup } })
  return toMarkdown(mdast, { bullet: '-', extensions: [gfmToMarkdown(), mathToMarkdown()] }).trim()
}

// ---------- DOM part ----------

// cloneContents() leaves out the elements the range sits inside, so a selection within bold text or
// a list item would lose that markup; they are put back around it, up to the reply's body.
export function rangeToMarkdown(range: Range, body: Element): string {
  let fragment: Node = range.cloneContents()
  const common = range.commonAncestorContainer
  for (
    let el = common instanceof Element ? common : common.parentElement;
    el && el !== body;
    el = el.parentElement
  ) {
    const shell = el.cloneNode(false)
    shell.appendChild(fragment)
    fragment = shell
  }
  const root = document.createElement('div')
  root.appendChild(fragment)
  return hastToMarkdown(fromDom(root) as HastNodes)
}
