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
      '`$\\$$`',
      '```latex\n\\[ x \\]\n$\\$$```',
      '- 运行：\n\n      ```bash\n      echo $A "\\$B" $C\n      ```',
      '    echo $A "\\$B" $C',
      '$$\na \\\\[2pt] b\n$$',
      '路径 C:\\\\(x\\\\)',
      '价格 \\$5 和 \\$10',
      '没有公式'
    ]
    for (const s of untouched) expect(n(s), s).toBe(s)
  })

  it('puts $$ fences that share a line with the formula on their own lines', () => {
    const aligned = '**转换**：\n$$\\begin{aligned}\nA &\\to \\beta A\' \\\\\nA\' &\\to \\varepsilon\n\\end{aligned}$$\n\n### 下一节'
    expect(n(aligned)).toBe('**转换**：\n$$\n\\begin{aligned}\nA &\\to \\beta A\' \\\\\nA\' &\\to \\varepsilon\n\\end{aligned}\n$$\n\n### 下一节')
    const html = render(n(aligned))
    expect(html).toContain('katex-display')
    expect(html).not.toContain('katex-error')
    expect(html).toContain('<h3>下一节</h3>')
    expect(render(n('> 引用\n> $$\\begin{cases}\n> x \\\\\n> \\end{cases}$$\n\n正文'))).toMatch(/<blockquote>[\s\S]*katex-display[\s\S]*<\/blockquote>\n<p>正文/)
    expect(n('1. 步骤\n\n   $$x\n   = 1$$')).toBe('1. 步骤\n\n   $$\n   x\n   = 1\n   $$')
  })

  it('opens the display block while a $$\\begin line is still streaming', () => {
    expect(n('前文\n$$\\begin{aligned}\nA &\\to')).toBe('前文\n$$\n\\begin{aligned}\nA &\\to')
  })

  it('keeps a lone $ literal instead of pairing it across prose', () => {
    const cases = ['FOLLOW(S) = {$}。\n由 S 得 FOLLOW(R) = {=, $}。', '遇 $ 接受，再看 $x$', '价格 $5 和 $10', '搜索符 [R, $]，后面是 `$`']
    for (const c of cases) {
      const html = render(n(c))
      expect(html, c).not.toMatch(/class="katex"[\s\S]*[\u4e00-\u9fff]{2}[\s\S]*<\/annotation>/)
    }
    expect(n('遇 $ 接受，再看 $x$')).toBe('遇 \\$ 接受，再看 $x$')
    expect(render(n('价格 $5 和 $10'))).toBe('<p>价格 $5 和 $10</p>')
  })

  it('leaves canonical math as written', () => {
    for (const s of ['$x$ 与 $$y$$', '$$\nE = mc^2\n$$', '- 项\n\n  $$\n  a\n  $$', '> $$\n> a\n> $$']) expect(n(s), s).toBe(s)
  })

  it('escapes \\$ inside math spans so remark-math does not break subsequent formulas', () => {
    const cases = [
      '先加 $\\$$，再把 $A \\to \\alpha$ 填入 $M[A, b]$。',
      '先置 $\\$ \\in \\text{FOLLOW}(S)$。',
      '但一定会有 $\\$$！',
      '$$\\text{end} = \\$$$',
      '\\(\\$\\) 与 \\(x\\)'
    ]
    for (const c of cases) {
      const html = render(n(c))
      const visible = html.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, '')
      expect(html, c).toContain('class="katex"')
      expect(html, c).not.toContain('katex-error')
      expect(visible, c).not.toContain('\\text{')
      expect(visible, c).not.toContain('\\to')
    }
  })
})
