import { GFM, parser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { mathSyntax } from '../../src/renderer/src/components/note-editor/mathSyntax'

const md = parser.configure([GFM, mathSyntax])

function nodes(text: string, name: string): string[] {
  const found: string[] = []
  md.parse(text).iterate({
    enter: (node) => {
      if (node.name === name) found.push(text.slice(node.from, node.to))
    }
  })
  return found
}

describe('mathSyntax', () => {
  it('finds inline math', () => {
    expect(nodes('当 $n \\ge n_0$ 时，$$x^2$$ 也算', 'InlineMath')).toEqual(['$n \\ge n_0$', '$$x^2$$'])
    expect(nodes('转义的 \\$5 和 $ 单个', 'InlineMath')).toEqual([])
    expect(nodes('空的 $$ 不算', 'InlineMath')).toEqual([])
    expect(nodes('`$x$` 在代码里', 'InlineMath')).toEqual([])
  })

  it('keeps inline math to one line', () => {
    expect(nodes('开头 $a\n+ b$ 结尾', 'InlineMath')).toEqual([])
  })

  it('finds block math', () => {
    expect(nodes('前文\n\n$$\nE = mc^2\n$$\n\n后文', 'BlockMath')).toEqual(['$$\nE = mc^2\n$$'])
    expect(nodes('$$ a + b $$\n后文', 'BlockMath')).toEqual(['$$ a + b $$'])
    expect(nodes('紧跟段落\n$$\nx\n$$', 'BlockMath')).toEqual(['$$\nx\n$$'])
    expect(nodes('$$\n没有闭合', 'BlockMath')).toEqual(['$$\n没有闭合'])
  })

  it('ends block math with its quote', () => {
    expect(nodes('> $$\n> x\n> $$\n\n外面', 'BlockMath')).toEqual(['$$\n> x\n> $$'])
    expect(nodes('> $$\n> x\n\n外面', 'BlockMath')).toEqual(['$$\n> x'])
  })

  it('leaves code alone', () => {
    expect(nodes('```\n$$\nx\n$$\n```', 'BlockMath')).toEqual([])
  })
})
