import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aimScroll } from '../../src/renderer/src/lib/aimScroll'

let frames: Map<number, FrameRequestCallback>
let frameId: number
let documentEvents: EventTarget

beforeEach(() => {
  frames = new Map()
  frameId = 0
  documentEvents = new EventTarget()
  vi.stubGlobal('document', documentEvents)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => vi.unstubAllGlobals())

function paint(): void {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(0)
}

function fixture() {
  const scroller = Object.assign(new EventTarget(), { scrollTop: 0, scrollHeight: 8000 }) as HTMLElement
  const message = {
    style: { contentVisibility: '', containIntrinsicSize: '' },
    getBoundingClientRect: () => ({ height: 6000 })
  } as unknown as HTMLElement
  return { scroller, message }
}

describe('scroll aiming across deferred layout', () => {
  it('retains the real height while auto visibility takes over and corrects later layout changes', () => {
    const { scroller, message } = fixture()
    let target = 500
    const settled = vi.fn()
    aimScroll(scroller, message, () => target - scroller.scrollTop, { onSettled: settled })
    expect(message.style.contentVisibility).toBe('')
    expect(message.style.containIntrinsicSize).toBe('auto 6000px')
    paint()
    expect(settled).not.toHaveBeenCalled()
    target += 2400 // An intervening placeholder expands on the next paint.
    paint()
    paint()
    expect(scroller.scrollTop).toBe(target)
    expect(settled).not.toHaveBeenCalled()
    paint()
    expect(settled).toHaveBeenCalledOnce()
    expect(message.style.containIntrinsicSize).toBe('')
    expect(frames.size).toBe(0)
  })

  it('waits for layout height to settle even when the destination has not moved yet', () => {
    const { scroller, message } = fixture()
    const settled = vi.fn()
    let target = 500
    aimScroll(scroller, message, () => target - scroller.scrollTop, { onSettled: settled })
    paint()
    Object.defineProperty(scroller, 'scrollHeight', { value: 8100, configurable: true })
    paint()
    expect(settled).not.toHaveBeenCalled()
    target += 6000
    Object.defineProperty(scroller, 'scrollHeight', { value: 14100 })
    paint()
    paint()
    expect(settled).not.toHaveBeenCalled()
    paint()
    expect(settled).toHaveBeenCalledOnce()
    expect(scroller.scrollTop).toBe(target)
  })

  it.each(['wheel', 'pointerdown', 'keydown'])('lets %s interrupt correction without pulling the reader back', (type) => {
    const { scroller, message } = fixture()
    const settled = vi.fn()
    aimScroll(scroller, message, () => 3000 - scroller.scrollTop, { ease: 0.2, onSettled: settled })
    const events = type === 'wheel' ? scroller : documentEvents
    events.dispatchEvent(new Event(type))
    scroller.scrollTop = 120
    paint()
    expect(scroller.scrollTop).toBe(120)
    expect(settled).not.toHaveBeenCalled()
    expect(message.style.containIntrinsicSize).toBe('')
  })

  it('replaces an earlier aim and ignores its later effect cleanup', () => {
    const { scroller, message } = fixture()
    const oldSettled = vi.fn()
    const stop = aimScroll(scroller, message, () => 800 - scroller.scrollTop, { onSettled: oldSettled })
    aimScroll(scroller, message, () => 2000 - scroller.scrollTop)
    stop()
    expect(message.style.containIntrinsicSize).toBe('auto 6000px')
    paint()
    paint()
    paint()
    expect(scroller.scrollTop).toBe(2000)
    expect(oldSettled).not.toHaveBeenCalled()
  })

  it('finishes when the destination is constrained by the end of the conversation', () => {
    const { scroller, message } = fixture()
    let top = 0
    Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: (value: number) => { top = Math.min(1000, value) } })
    const settled = vi.fn()
    aimScroll(scroller, message, () => 1500 - scroller.scrollTop, { onSettled: settled })
    paint()
    paint()
    paint()
    expect(settled).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
  })
})
