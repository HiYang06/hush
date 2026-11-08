import { describe, expect, it } from 'vitest'
import { noteHeadings, noteSections } from '../src/shared/noteSections'

const NOTE = `前言

# 线性代数

## 特征值

Av = λv

### 求法

解特征方程

## 奇异值 ##

\`\`\`python
# 不是标题
\`\`\`

# 概率`

describe('noteHeadings', () => {
  it('finds ATX headings with their line, skipping fenced code and closing #s', () => {
    expect(noteHeadings(NOTE)).toEqual([
      { level: 1, title: '线性代数', line: 2 },
      { level: 2, title: '特征值', line: 4 },
      { level: 3, title: '求法', line: 8 },
      { level: 2, title: '奇异值', line: 12 },
      { level: 1, title: '概率', line: 18 }
    ])
  })

  it('needs a space after the #s, and something after the space', () => {
    expect(noteHeadings('#标签\n#   \n####### 七级')).toEqual([])
  })

  it('only closes a fence with the same character', () => {
    expect(noteHeadings('~~~\n```\n# 仍在代码里\n~~~\n# 标题')).toEqual([{ level: 1, title: '标题', line: 4 }])
  })
})

describe('noteSections', () => {
  it('runs a section to the next heading of the same or a higher level', () => {
    const sections = noteSections(NOTE)
    expect(sections.map((s) => [s.line, s.endLine])).toEqual([
      [2, 18],
      [4, 12],
      [8, 12],
      [12, 18],
      [18, 19]
    ])
    expect(sections.map((s) => [s.title, s.body])).toEqual([
      ['线性代数', '## 特征值\n\nAv = λv\n\n### 求法\n\n解特征方程\n\n## 奇异值 ##\n\n```python\n# 不是标题\n```'],
      ['特征值', 'Av = λv\n\n### 求法\n\n解特征方程'],
      ['求法', '解特征方程'],
      ['奇异值', '```python\n# 不是标题\n```'],
      ['概率', '']
    ])
  })
})
