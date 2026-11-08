import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { describe, expect, it } from 'vitest'
import { gfmOptions, normalizeMathDelimiters, splitBlocks } from '../../src/renderer/src/lib/markdownBlocks'

const render = (markdown: string): string =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [[remarkGfm, gfmOptions], remarkMath], rehypePlugins: [rehypeKatex] }, markdown)
  )

const renderBlocks = (markdown: string): string =>
  renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      ...splitBlocks(markdown).flatMap((block, i) => [
        ...(i > 0 ? ['\n'] : []),
        createElement(ReactMarkdown, { remarkPlugins: [[remarkGfm, gfmOptions], remarkMath], rehypePlugins: [rehypeKatex] }, block)
      ])
    )
  )

const samples = {
  mixed: [
    '# 标题',
    '第一段，**加粗**和 `code`。\n同一段的第二行。',
    '- 一\n- 二\n\n  二的第二段\n- 三',
    '1. 甲\n2. 乙',
    '> 引用\n>\n> 第二段',
    '```ts\nconst a = 1\n\nconst b = 2\n```',
    '$$\nE = mc^2\n$$',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    '---',
    '行内公式 $x^2$ 结尾'
  ].join('\n\n'),
  unclosedFence: '说明：\n\n```python\nprint(1)\n\nprint(2)',
  html: '前面\n\n<div>raw</div>\n\n后面',
  empty: ''
}

describe('splitBlocks', () => {
  it('renders the same DOM as the whole text', () => {
    for (const [name, markdown] of Object.entries(samples)) {
      expect(renderBlocks(markdown), name).toBe(render(markdown))
    }
  })

  it('splits at top-level blocks only', () => {
    expect(splitBlocks(samples.mixed)).toHaveLength(10)
    expect(splitBlocks(samples.unclosedFence)).toEqual(['说明：', '```python\nprint(1)\n\nprint(2)'])
  })

  it('strikes through only with double tildes', () => {
    expect(render('约 20~30 分钟，40~50 个')).toBe('<p>约 20~30 分钟，40~50 个</p>')
    expect(render('~~删掉~~')).toBe('<p><del>删掉</del></p>')
  })

  it('keeps text with definitions whole', () => {
    const withRef = '见 [文档][d]。\n\n[d]: https://example.com'
    const withFootnote = '正文[^1]。\n\n[^1]: 注释'
    expect(splitBlocks(withRef)).toEqual([withRef])
    expect(splitBlocks(withFootnote)).toEqual([withFootnote])
  })
})

describe('normalizeMathDelimiters', () => {
  const n = normalizeMathDelimiters

  it('turns \\(…\\) into inline math', () => {
    expect(n('恰好 \\(b\\) 个 token')).toBe('恰好 $b$ 个 token')
    expect(render(n('设 \\(x^2\\) 为'))).toContain('class="katex"')
  })

  it('turns a \\[…\\] on its own lines into a display block', () => {
    expect(n('前文\n\\[\nE = mc^2\n\\]\n后文')).toBe('前文\n$$\nE = mc^2\n$$\n后文')
    expect(n('\\[ a + b \\]')).toBe('$$\na + b\n$$')
    expect(render(n('前文\n\\[\nE = mc^2\n\\]\n后文'))).toContain('katex-display')
    expect(render(n('\\[ a + b \\]'))).toContain('katex-display')
  })

  it('keeps a display block inside its list item or quote', () => {
    expect(render(n('1. 第一步：\n\n   \\[\n   x = 1\n   \\]'))).toMatch(/<li>[\s\S]*katex-display[\s\S]*<\/li>/)
    expect(render(n('> 引用\n> \\[ x \\]'))).toMatch(/<blockquote>[\s\S]*katex-display[\s\S]*<\/blockquote>/)
  })

  it('renders a \\[…\\] inside a sentence inline', () => {
    expect(n('所以 \\[x\\] 成立')).toBe('所以 $$x$$ 成立')
  })

  it('leaves code, existing math and LaTeX line breaks alone', () => {
    const untouched = [
      '`\\(x\\)`',
      '```latex\n\\[ x \\]\n```',
      '$$\na \\\\[2pt] b\n$$',
      '路径 C:\\\\(x\\\\)',
      '没有公式'
    ]
    for (const s of untouched) expect(n(s), s).toBe(s)
  })
})
