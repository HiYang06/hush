// Keep the measured fallback until auto visibility has rendered the destination. Restoring auto
// immediately after a forced layout can otherwise collapse a long reply back to its 160px estimate.
export function aimScroll(
  scroller: HTMLElement,
  message: HTMLElement,
  drift: () => number,
  { ease = 1, onSettled, onStop }: { ease?: number; onSettled?: () => void; onStop?: () => void } = {}
): () => void {
  aiming.get(scroller)?.()
  const visibility = message.style.contentVisibility
  const intrinsicSize = message.style.containIntrinsicSize
  message.style.contentVisibility = 'visible'
  message.style.containIntrinsicSize = `auto ${message.getBoundingClientRect().height}px`
  message.style.contentVisibility = visibility
  let raf = 0
  let frame = 0
  let still = 0
  let height = -1
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
    scroller.removeEventListener('wheel', stop)
    document.removeEventListener('pointerdown', stop)
    document.removeEventListener('keydown', stop)
    message.style.containIntrinsicSize = intrinsicSize
    if (aiming.get(scroller) === stop) aiming.delete(scroller)
    onStop?.()
  }
  const step = (): void => {
    const delta = drift()
    const before = scroller.scrollTop
    scroller.scrollTop += Math.abs(delta) < 4 ? delta : delta * ease
    const nextHeight = scroller.scrollHeight
    if (height === nextHeight && (Math.abs(delta) < 1 || Math.abs(scroller.scrollTop - before) < 1)) still++
    else still = 0
    height = nextHeight
    if (still < 2 && ++frame < 120) raf = requestAnimationFrame(step)
    else {
      stop()
      onSettled?.()
    }
  }
  scroller.addEventListener('wheel', stop, { passive: true })
  document.addEventListener('pointerdown', stop)
  document.addEventListener('keydown', stop)
  aiming.set(scroller, stop)
  // Aim before paint, but count stability only across rendered frames.
  scroller.scrollTop += drift() * ease
  raf = requestAnimationFrame(step)
  return stop
}

const aiming = new WeakMap<HTMLElement, () => void>()
