import type { MarkdownConfig } from '@lezer/markdown'

// `$…$` / `$$…$$` for the note editor's parser, read the way remark-math reads them in replies.

const DOLLAR = 36
const BACKSLASH = 92
const NEWLINE = 10

const opensBlock = (text: string, pos: number): boolean => text.startsWith('$$', pos)

export const mathSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'InlineMath' }, { name: 'InlineMathMark' }, { name: 'BlockMath', block: true }],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1
        const size = cx.char(pos + 1) === DOLLAR ? 2 : 1
        for (let i = pos + size; i < cx.end; i++) {
          const c = cx.char(i)
          // Kept to one line, so live preview can hide it without spanning a line break.
          if (c === NEWLINE) return -1
          if (c === BACKSLASH) i++
          else if (c === DOLLAR && (size === 1 || cx.char(i + 1) === DOLLAR)) {
            if (i === pos + size) return -1
            return cx.addElement(
              cx.elt('InlineMath', pos, i + size, [cx.elt('InlineMathMark', pos, pos + size), cx.elt('InlineMathMark', i, i + size)])
            )
          }
        }
        return -1
      },
      before: 'Escape'
    }
  ],
  parseBlock: [
    {
      name: 'BlockMath',
      parse(cx, line) {
        if (!opensBlock(line.text, line.pos)) return false
        const from = cx.lineStart + line.pos
        const rest = line.text.slice(line.pos + 2).trim()
        if (rest.length > 2 && rest.endsWith('$$')) cx.nextLine()
        else {
          // Same loop as lezer's fenced code: unclosed, it runs to the end of its container, as in remark-math.
          // `depth` is there at runtime but left out of lezer's types; the quote test covers it.
          while (cx.nextLine() && (line as typeof line & { depth: number }).depth >= cx.depth) {
            if (line.text.slice(line.pos).trimEnd().endsWith('$$')) {
              cx.nextLine()
              break
            }
          }
        }
        cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd()))
        return true
      },
      endLeaf: (_, line) => opensBlock(line.text, line.pos)
    }
  ]
}
