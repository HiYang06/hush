import { describe, expect, it } from 'vitest'
import { estimateTokens, formatTokens, parseTokens } from '../../src/renderer/src/lib/tokens'

describe('formatTokens', () => {
  it.each([
    [null, '—'],
    [999, '999'],
    [128_000, '128K'],
    [200_000, '200K'],
    [65_536, '64K'],
    [1_000_000, '1M'],
    [1_048_576, '1M'],
    [1_500, '1.5K']
  ])('%s → %s', (n, text) => {
    expect(formatTokens(n)).toBe(text)
  })
})

describe('parseTokens', () => {
  it.each([
    ['', null],
    ['  ', null],
    ['128000', 128_000],
    ['128,000', 128_000],
    ['200k', 200_000],
    ['1M', 1_000_000],
    ['1.5m', 1_500_000],
    ['abc', 'invalid'],
    ['0', 'invalid'],
    ['-5', 'invalid']
  ])('%j → %s', (input, value) => {
    expect(parseTokens(input)).toBe(value)
  })
})

describe('estimateTokens', () => {
  it('counts a CJK character as one token and four other characters as one', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('奇异值分解')).toBe(5)
    expect(estimateTokens('SVD!')).toBe(1)
    expect(estimateTokens('矩阵 SVD 分解，')).toBe(5 + 2)
  })
})
