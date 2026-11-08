// Note edits are saved 0.5s after typing stops (product.md §6). Anything the main process writes into a
// note (a clip, later AI and moves) must flush first, or this save would overwrite it with older text.
import type { NoteTarget } from '@shared/types'

const SAVE_DELAY_MS = 500

let pending: { target: NoteTarget; content: string; timer: ReturnType<typeof setTimeout> } | null = null

export function sameTarget(a: NoteTarget, b: NoteTarget): boolean {
  return a.scope === b.scope && a.scopeId === b.scopeId
}

export function scheduleNoteSave(target: NoteTarget, content: string): void {
  if (pending && !sameTarget(pending.target, target)) void flushNoteSave()
  if (pending) clearTimeout(pending.timer)
  pending = { target, content, timer: setTimeout(flushNoteSave, SAVE_DELAY_MS) }
}

export function hasPendingNoteSave(target: NoteTarget): boolean {
  return pending !== null && sameTarget(pending.target, target)
}

export function flushNoteSave(): Promise<void> {
  if (!pending) return Promise.resolve()
  const { target, content, timer } = pending
  clearTimeout(timer)
  pending = null
  return window.api.invoke('notes:save', target, content)
}

window.api.on('app:flush', () => {
  // A failed save still lets the window close; the error stays visible in the console.
  flushNoteSave().finally(() => window.api.invoke('app:flushed'))
})
