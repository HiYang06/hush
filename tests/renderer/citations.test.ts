import type { Root } from 'mdast'
import { describe, expect, it } from 'vitest'
import { splitCitations, stripCitations } from '@shared/citations'
import { remarkCitations } from '../../src/renderer/src/lib/citations'

const source = (n: number) => ({ n, url: `https://s${n}.com`, title: `S${n}`, date: null, snippet: '' })

describe('citations', () => {
  it("splits out only the reply's own source numbers", () => {
    expect(splitCitations('结论 [1][3]，见 [9]。', new Set([1, 3]))).toEqual([
      { text: '结论' },
      { n: 1 },
      { n: 3 },
      { text: '，见 [9]。' }
    ])
    expect(stripCitations('结论 [1]。', new Set([1]))).toBe('结论。')
  })

  it('marks text nodes as badges and leaves code and formulas alone', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: '有界 [1]' },
            { type: 'inlineCode', value: 'a[1]' },
            { type: 'inlineMath', value: 'x_[1]' }
          ]
        }
      ]
    }
    remarkCitations([source(1)])()(tree)
    expect(tree.children[0]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', value: '有界' },
        { type: 'text', value: '1', data: { hName: 'sup', hProperties: { className: ['cite'], dataCite: 1 } } },
        { type: 'inlineCode', value: 'a[1]' },
        { type: 'inlineMath', value: 'x_[1]' }
      ]
    })
  })
})
