import type { Parent, Root, RootContent } from 'mdast'
import type { WebSource } from '@shared/types'
import { splitCitations } from '@shared/citations'

// Turns a reply's [n] markers into <sup class="cite"> nodes. Only text nodes are touched, so markers in
// code and formulas (which carry their content as `value`, not as text children) stay as written.
export function remarkCitations(sources: WebSource[]) {
  const numbers = new Set(sources.map((s) => s.n))
  const visit = (node: Parent): void => {
    node.children = (node.children as RootContent[]).flatMap((child): RootContent[] => {
      if (child.type !== 'text') {
        if ('children' in child) visit(child)
        return [child]
      }
      const pieces = splitCitations(child.value, numbers)
      if (pieces.every((p) => 'text' in p)) return [child]
      return pieces.map(
        (p): RootContent =>
          'text' in p
            ? { type: 'text', value: p.text }
            : {
                type: 'text',
                value: String(p.n),
                data: { hName: 'sup', hProperties: { className: ['cite'], dataCite: p.n } }
              }
      )
    }) as Parent['children']
  }
  return () => (tree: Root) => visit(tree)
}
