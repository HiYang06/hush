import type { ElementContent, Properties, Root } from 'hast'
import { describe, expect, it } from 'vitest'
import { hastToMarkdown } from '../../src/renderer/src/lib/clip'

const h = (tagName: string, properties: Properties, ...children: ElementContent[]): ElementContent => ({
  type: 'element',
  tagName,
  properties,
  children
})
const t = (value: string): ElementContent => ({ type: 'text', value })
const root = (...children: ElementContent[]): Root => ({ type: 'root', children })

// KaTeX's output, reduced to what matters: the rendered glyphs and the <annotation> with the source.
const katex = (tex: string): ElementContent =>
  h(
    'span',
    { className: ['katex'] },
    h('span', { className: ['katex-mathml'] }, h('math', {}, h('semantics', {}, h('annotation', { encoding: 'application/x-tex' }, t(tex))))),
    h('span', { className: ['katex-html'] }, t('σ₁'))
  )

describe('hastToMarkdown', () => {
  it('keeps inline markup and lists', () => {
    const tree = root(
      h('p', {}, t('SVD 是'), h('strong', {}, t('最重要')), t('的分解，'), h('code', {}, t('np.linalg.svd'))),
      h('ul', {}, h('li', {}, t('正交')), h('li', {}, t('对角')))
    )
    expect(hastToMarkdown(tree)).toBe('SVD 是**最重要**的分解，`np.linalg.svd`\n\n- 正交\n- 对角')
  })

  it('writes formulas as their LaTeX source, not the rendered glyphs', () => {
    const tree = root(
      h('p', {}, t('最大奇异值 '), katex('\\sigma_1'), t(' 决定范数')),
      h('span', { className: ['katex-display'] }, katex('A = U\\Sigma V^T'))
    )
    expect(hastToMarkdown(tree)).toBe('最大奇异值 $\\sigma_1$ 决定范数\n\n$$\nA = U\\Sigma V^T\n$$')
  })

  it("turns a highlighted code block into a fence, without the header's language label and copy button", () => {
    const tree = root(
      h(
        'div',
        { className: ['code-block-wrapper'], dataLanguage: 'python' },
        h('div', { className: ['code-block-header'], dataAnchorSkip: '' }, h('span', {}, t('python')), h('button', {}, t('复制'))),
        h(
          'div',
          { className: ['code-block-scroll'] },
          h('pre', { className: ['shiki'] }, h('code', {}, h('span', { className: ['line'] }, t('u, s, vt = svd(a)')), t('\n'), h('span', { className: ['line'] }, t('print(s)'))))
        )
      )
    )
    expect(hastToMarkdown(tree)).toBe('```python\nu, s, vt = svd(a)\nprint(s)\n```')
  })

  it('keeps tables', () => {
    const row = (tag: string, ...cells: string[]) => h('tr', {}, ...cells.map((c) => h(tag, {}, t(c))))
    const tree = root(
      h('div', { className: ['table-scroll-wrapper'] }, h('table', {}, h('thead', {}, row('th', '分解', '条件')), h('tbody', {}, row('td', 'SVD', '任意矩阵'))))
    )
    expect(hastToMarkdown(tree)).toBe('| 分解  | 条件   |\n| --- | ---- |\n| SVD | 任意矩阵 |')
  })

  it('turns a citation badge into a link to its source', () => {
    const cite = h('sup', { className: ['cite'], dataAnchorSkip: '', dataUrl: 'https://a.com/x', dataCite: '2' }, h('button', {}, t('2')))
    expect(hastToMarkdown(root(h('p', {}, t('奇异值非负'), cite, t('。'))))).toBe('奇异值非负[\\[2\\]](https://a.com/x)。')
  })
})
