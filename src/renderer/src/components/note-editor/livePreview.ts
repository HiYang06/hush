import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import katex from 'katex'
import { Prec, StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { hushLinkMessageId } from '@shared/noteClips'
import { hushLinkSessionId } from '@shared/sessionLinks'
import { gfmOptions } from '@renderer/lib/markdownBlocks'

// Live preview (D-013 step two): lines the selection touches show their Markdown; every other line hides
// the markup. A view plugin hides markup within lines; tables and display math replace whole lines,
// which CodeMirror only takes from a state field.

const hidden = Decoration.replace({})
const FENCE = /^\s*(`{3,}|~{3,})/

function selectedLines(state: EditorState, focused: boolean): Set<number> {
  const lines = new Set<number>()
  if (!focused) return lines
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) lines.add(n)
  }
  return lines
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly quoted = false
  ) {
    super()
  }
  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display && other.quoted === this.quoted
  }
  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? `cm-preview-block${this.quoted ? ' cm-preview-quote' : ''}` : 'cm-preview-math'
    el.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false })
    return el
  }
  // Clicking it puts the cursor there, which turns it back into source.
  ignoreEvent(): boolean {
    return false
  }
}

// Rendered the way replies render tables, so cells keep their bold, code and math.
class TableWidget extends WidgetType {
  constructor(
    readonly markdown: string,
    readonly quoted: boolean
  ) {
    super()
  }
  eq(other: TableWidget): boolean {
    return other.markdown === this.markdown && other.quoted === this.quoted
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = `cm-preview-block markdown-body${this.quoted ? ' cm-preview-quote' : ''}`
    el.innerHTML = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        {
          remarkPlugins: [[remarkGfm, gfmOptions], remarkMath],
          rehypePlugins: [rehypeKatex],
          components: { table: ({ children }) => createElement('div', { className: 'table-scroll-wrapper' }, createElement('table', null, children)) }
        },
        this.markdown
      )
    )
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

function quoteDepth(node: SyntaxNode): number {
  let depth = 0
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === 'Blockquote') depth++
  return depth
}

function blockDecorations(state: EditorState): DecorationSet {
  const doc = state.doc
  const sourceLines = selectedLines(state, state.field(focusField))
  const decorations: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'BlockMath' && node.name !== 'Table') return
      const first = doc.lineAt(node.from)
      const last = doc.lineAt(node.to)
      for (let n = first.number; n <= last.number; n++) if (sourceLines.has(n)) return false
      const depth = quoteDepth(node.node)
      const text = doc
        .sliceString(first.from, last.to)
        .split('\n')
        .map((line) => {
          for (let i = 0; i < depth; i++) line = line.replace(/^\s*>\s?/, '')
          return line
        })
        .join('\n')
      const widget =
        node.name === 'Table'
          ? new TableWidget(text, depth > 0)
          : new MathWidget(text.trim().replace(/^\$\$/, '').replace(/\$\$$/, ''), true, depth > 0)
      decorations.push(Decoration.replace({ widget, block: true }).range(first.from, last.to))
      return false
    }
  })
  return Decoration.set(decorations)
}

const setFocus = StateEffect.define<boolean>()

const focusField = StateField.define<boolean>({
  create: () => false,
  update: (focused, tr) => tr.effects.reduce((value, effect) => (effect.is(setFocus) ? effect.value : value), focused)
})

const blockField = StateField.define<DecorationSet>({
  create: blockDecorations,
  update(decorations, tr) {
    if (
      !tr.isUserEvent('input.type.compose') &&
      (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocus)) || syntaxTree(tr.startState) !== syntaxTree(tr.state))
    ) {
      return blockDecorations(tr.state)
    }
    return decorations.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field)
})

// Moving up or down skips a replaced block as one unit, so the keyboard could never get into a table or
// display math; when the next line is the edge of one, land on that line, which shows its source.
function enterBlock(forward: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view
    const cursor = state.selection.main
    if (!cursor.empty) return false
    const line = state.doc.lineAt(cursor.head)
    const next = forward ? line.number + 1 : line.number - 1
    if (next < 1 || next > state.doc.lines) return false
    if (state.doc.lineAt(view.moveVertically(cursor, forward).head).number === line.number) return false
    const target = state.doc.line(next)
    let edge = false
    state.field(blockField).between(target.from, target.to, (from, to) => {
      if (forward ? from === target.from : to === target.to) edge = true
    })
    if (!edge) return false
    view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true })
    return true
  }
}

function previewDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const doc = state.doc
  const sourceLines = selectedLines(state, view.hasFocus)
  const isSource = (pos: number): boolean => sourceLines.has(doc.lineAt(pos).number)
  const decorations: Range<Decoration>[] = []
  const hide = (from: number, to: number): void => {
    if (from < to && !isSource(from)) decorations.push(hidden.range(from, to))
  }
  const withSpace = (to: number): number => (doc.sliceString(to, to + 1) === ' ' ? to + 1 : to)
  const lineClass = (from: number, to: number, className: (line: number, first: number, last: number) => string): void => {
    const first = doc.lineAt(from).number
    const last = doc.lineAt(to).number
    for (let n = first; n <= last; n++) decorations.push(Decoration.line({ class: className(n, first, last) }).range(doc.line(n).from))
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        switch (node.name) {
          case 'HeaderMark':
            if (node.node.parent?.name.startsWith('ATXHeading')) hide(node.from, withSpace(node.to))
            break
          case 'EmphasisMark':
            hide(node.from, node.to)
            break
          // A backslash hard break covers the line break too; only the backslash is hidden.
          case 'HardBreak':
            if (doc.sliceString(node.from, node.from + 1) === '\\') hide(node.from, node.from + 1)
            break
          case 'InlineCode':
            for (const mark of node.node.getChildren('CodeMark')) hide(mark.from, mark.to)
            decorations.push(Decoration.mark({ class: 'cm-preview-inline-code' }).range(node.from, node.to))
            return false
          case 'Blockquote':
            lineClass(node.from, node.to, () => 'cm-preview-quote')
            break
          case 'QuoteMark':
            hide(node.from, withSpace(node.to))
            break
          case 'FencedCode': {
            lineClass(node.from, node.to, (n, first, last) =>
              `cm-preview-codeblock${n === first ? ' cm-preview-codeblock-start' : ''}${n === last ? ' cm-preview-codeblock-end' : ''}`
            )
            const open = doc.lineAt(node.from)
            hide(open.from, open.to)
            const close = doc.lineAt(node.to)
            if (close.number > open.number && FENCE.test(close.text)) hide(close.from, close.to)
            return false
          }
          case 'Link':
            linkDecorations(node.node, state, isSource, hide, decorations)
            break
          case 'InlineMath': {
            const marks = node.node.getChildren('InlineMathMark')
            if (!isSource(node.from) && marks.length === 2) {
              const widget = new MathWidget(doc.sliceString(marks[0].to, marks[1].from), false)
              decorations.push(Decoration.replace({ widget }).range(node.from, node.to))
            }
            return false
          }
          case 'BlockMath':
          case 'Table':
            return false
        }
      }
    })
  }
  return Decoration.set(decorations, true)
}

function linkDecorations(
  link: SyntaxNode,
  state: EditorState,
  isSource: (pos: number) => boolean,
  hide: (from: number, to: number) => void,
  decorations: Range<Decoration>[]
): void {
  const marks = link.getChildren('LinkMark')
  const url = link.getChild('URL')
  // `[text](url)` only; reference links and `[text]` alone stay as written.
  if (marks.length < 3 || !url || isSource(link.from)) return
  const href = state.sliceDoc(url.from, url.to)
  hide(link.from, marks[0].to)
  hide(marks[1].from, link.to)
  const source = href.startsWith('hush://message/')
  const title = source ? '点击跳回原文' : hushLinkSessionId(href) ? '点击打开会话' : href
  decorations.push(
    Decoration.mark({
      class: source ? 'cm-preview-link cm-preview-source' : 'cm-preview-link',
      attributes: { 'data-href': href, title }
    }).range(marks[0].to, marks[1].from)
  )
}

// Clicking a link a preview line shows follows it; on a line showing its source, ⌘-click still does.
export function previewLinkClick(
  event: MouseEvent,
  onJumpToMessage: (messageId: string) => void,
  onOpenSession: (sessionId: string) => void
): boolean {
  if (event.button !== 0) return false
  const link = (event.target as HTMLElement).closest<HTMLElement>('.cm-preview-link')
  const href = link?.dataset.href
  if (!href) return false
  event.preventDefault()
  const sessionId = hushLinkSessionId(href)
  if (href.startsWith('hush://message/')) onJumpToMessage(hushLinkMessageId(href))
  else if (sessionId) onOpenSession(sessionId)
  else void window.api.invoke('links:open', href)
  return true
}

export const livePreview = [
  focusField,
  EditorView.focusChangeEffect.of((_, focusing) => setFocus.of(focusing)),
  blockField,
  Prec.high(
    keymap.of([
      { key: 'ArrowDown', run: enterBlock(true) },
      { key: 'ArrowUp', run: enterBlock(false) }
    ])
  ),
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = previewDecorations(view)
      }
      update(update: ViewUpdate): void {
        // Redrawing while an input method is composing drops keys and mixes decorations into the
        // composed text (D-043), so hold still until it commits.
        if (update.view.composing) {
          this.decorations = this.decorations.map(update.changes)
          return
        }
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = previewDecorations(update.view)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  ),
  EditorView.theme({
    '.cm-preview-inline-code': {
      padding: '0.1em 0.35em',
      borderRadius: '5px',
      backgroundColor: 'color-mix(in srgb, var(--text-primary) 5%, transparent)'
    },
    '.cm-line.cm-preview-quote': {
      borderLeft: '3px solid var(--border-strong)',
      paddingLeft: '12px',
      color: 'var(--text-secondary)'
    },
    '.cm-line.cm-preview-codeblock': {
      fontFamily: 'var(--font-mono)',
      fontSize: '0.88em',
      paddingLeft: '10px',
      paddingRight: '10px',
      backgroundColor: 'color-mix(in srgb, var(--text-primary) 2.5%, transparent)'
    },
    '.cm-preview-codeblock-start': { borderTopLeftRadius: '6px', borderTopRightRadius: '6px' },
    '.cm-preview-codeblock-end': { borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px' },
    '.cm-preview-link': { color: 'var(--accent-link)', cursor: 'pointer' },
    // The syntax highlighting colors the innermost span; the link's own color should show instead.
    '.cm-preview-link span': { color: 'inherit' },
    '.cm-preview-link.cm-preview-source': { color: 'var(--text-muted)' },
    '.cm-preview-block': { margin: '0.4em 0', fontSize: 'var(--body-font-size)', cursor: 'text' },
    '.cm-preview-block.cm-preview-quote': {
      margin: '0',
      paddingLeft: '12px',
      borderLeft: '3px solid var(--border-strong)'
    },
    '.cm-preview-block .katex-display': { margin: '0', overflowX: 'auto', overflowY: 'hidden' },
    '.cm-preview-block .table-scroll-wrapper': { margin: '0' }
  })
]
