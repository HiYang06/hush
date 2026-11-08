import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunner } from '../src/main/sync/runner'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// A run that stays in flight until the test lets it finish, like a sync waiting on the network.
function controlledRun(): { run: () => Promise<void>; finish: () => Promise<void>; count: () => number } {
  let runs = 0
  let release: (() => void) | null = null
  return {
    run: () => {
      runs++
      return new Promise<void>((resolve) => (release = resolve))
    },
    finish: async () => {
      release?.()
      release = null
      await vi.advanceTimersByTimeAsync(0)
    },
    count: () => runs
  }
}

describe('sync runner', () => {
  it('waits for changes to settle, so several in a row become one run', async () => {
    const c = controlledRun()
    const runner = createRunner(c.run, 2000)
    runner.soon()
    await vi.advanceTimersByTimeAsync(1500)
    runner.soon()
    await vi.advanceTimersByTimeAsync(1500)
    expect(c.count()).toBe(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(c.count()).toBe(1)
  })

  it('never runs twice at once, and runs once more after when asked meanwhile', async () => {
    const c = controlledRun()
    const runner = createRunner(c.run, 2000)
    runner.now()
    runner.now()
    runner.now()
    expect(c.count()).toBe(1)
    await c.finish()
    expect(c.count()).toBe(2)
    await c.finish()
    expect(c.count()).toBe(2)
  })

  it('runs at once when asked now, dropping a wait that was pending', async () => {
    const c = controlledRun()
    const runner = createRunner(c.run, 2000)
    runner.soon()
    runner.now()
    expect(c.count()).toBe(1)
    await c.finish()
    await vi.advanceTimersByTimeAsync(5000)
    expect(c.count()).toBe(1)
  })

  it('forgets pending runs when stopped (signing out)', async () => {
    const c = controlledRun()
    const runner = createRunner(c.run, 2000)
    runner.now()
    runner.now()
    runner.soon()
    runner.stop()
    await c.finish()
    await vi.advanceTimersByTimeAsync(5000)
    expect(c.count()).toBe(1)
  })
})
