import { describe, expect, it } from 'vitest'
import { MINI_IDLE_MS, shouldStartFresh } from '../../src/renderer/src/lib/mini'

describe('mini window: continue or start fresh', () => {
  const now = 1_000_000_000

  it('continues within 10 minutes of being put away', () => {
    expect(shouldStartFresh(now - MINI_IDLE_MS, now, false)).toBe(false)
    expect(shouldStartFresh(now - 1000, now, false)).toBe(false)
  })

  it('starts fresh after 10 minutes', () => {
    expect(shouldStartFresh(now - MINI_IDLE_MS - 1, now, false)).toBe(true)
  })

  it('continues while the reply is still coming, however long it was away', () => {
    expect(shouldStartFresh(now - 3 * MINI_IDLE_MS, now, true)).toBe(false)
  })

  it('continues when it was never put away', () => {
    expect(shouldStartFresh(null, now, false)).toBe(false)
  })
})
