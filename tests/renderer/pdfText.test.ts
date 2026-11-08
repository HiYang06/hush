import { describe, expect, it } from 'vitest'
import { assembleLines, captionTags, pageHeading, type TextRun } from '../../src/renderer/src/lib/attachments/pdfText'

const run = (str: string, x: number, y: number, size = 10, width = str.length * size * 0.5): TextRun => ({ str, x, y, size, width })

describe('assembleLines', () => {
  it('keeps sub- and superscripts on their line, and breaks where the baseline moves a full line', () => {
    const lines = assembleLines([
      run('E = mc', 0, 100),
      run('2', 30, 104, 7, 3.5),
      run('where x', 0, 86),
      run('i', 35, 83, 7, 2),
      run('is', 40, 86)
    ])
    expect(lines.map((l) => l.text)).toEqual(['E = mc2', 'where xi is'])
  })

  it('adds a space at a gap between words, but not between CJK characters of justified text', () => {
    const lines = assembleLines([run('Table', 0, 50, 10, 25), run('cell', 40, 50, 10, 20), run('中文', 0, 30, 10, 20), run('排版', 21, 30, 10, 20)])
    expect(lines.map((l) => l.text)).toEqual(['Table cell', '中文排版'])
  })
})

describe('pageHeading', () => {
  it('takes the largest text when it stands out, joining a title that wraps', () => {
    const lines = [
      { text: 'Chapter 3', size: 24 },
      { text: 'Eigenvalues', size: 24 },
      { text: 'Body text goes here.', size: 10 }
    ]
    expect(pageHeading(lines)).toBe('Chapter 3 Eigenvalues')
    expect(pageHeading([{ text: 'a', size: 10 }, { text: 'b', size: 10.2 }])).toBe('')
  })
})

describe('captionTags', () => {
  it('counts a caption only at the start of a line', () => {
    expect(captionTags([{ text: 'Figure 2: Model', size: 9 }, { text: '表 1 结果', size: 9 }])).toEqual(['figure', 'table'])
    expect(captionTags([{ text: 'as shown in Figure 2', size: 9 }])).toEqual([])
  })
})
