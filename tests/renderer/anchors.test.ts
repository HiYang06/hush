import { describe, expect, it } from 'vitest'
import { locateAnchor, makeAnchor } from '../../src/renderer/src/lib/anchors'

const TEXT = '特征值描述方向不变的伸缩。奇异值也描述伸缩，但奇异值不要求方向不变。'

describe('makeAnchor', () => {
  it('keeps up to 30 characters of context on each side', () => {
    const start = TEXT.indexOf('奇异值也')
    const anchor = makeAnchor(TEXT, start, start + 3)
    expect(anchor).toEqual({
      quote: '奇异值',
      start,
      end: start + 3,
      prefix: '特征值描述方向不变的伸缩。',
      suffix: '也描述伸缩，但奇异值不要求方向不变。'
    })
    const long = 'x'.repeat(40) + 'Q' + 'y'.repeat(40)
    expect(makeAnchor(long, 40, 41)).toMatchObject({ prefix: 'x'.repeat(30), suffix: 'y'.repeat(30) })
  })
})

describe('locateAnchor', () => {
  const second = TEXT.lastIndexOf('奇异值')
  const anchor = makeAnchor(TEXT, second, second + 3)

  it('uses the stored position when the quote is still there', () => {
    expect(locateAnchor(TEXT, anchor)).toEqual({ start: second, end: second + 3 })
  })

  it('finds the right one of two occurrences by context after the position drifted', () => {
    const shifted = '（补充）' + TEXT
    expect(locateAnchor(shifted, anchor)).toEqual({ start: second + 4, end: second + 7 })
    const first = TEXT.indexOf('奇异值')
    expect(locateAnchor(shifted, makeAnchor(TEXT, first, first + 3))).toEqual({ start: first + 4, end: first + 7 })
  })

  it('takes the nearest occurrence when the context matches neither', () => {
    const text = 'ab奇异值cd奇异值ef'
    expect(locateAnchor(text, { quote: '奇异值', start: 7, end: 10, prefix: 'zz', suffix: 'zz' })).toEqual({
      start: 7,
      end: 10
    })
    expect(locateAnchor(text, { quote: '奇异值', start: 0, end: 3, prefix: 'zz', suffix: 'zz' })).toEqual({
      start: 2,
      end: 5
    })
  })

  it('gives up when the quote is gone', () => {
    expect(locateAnchor('完全不同的文字', anchor)).toBeNull()
    expect(locateAnchor(TEXT, { ...anchor, quote: '' })).toBeNull()
  })
})
