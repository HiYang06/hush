// Gemini's rule: put away longer than this, the mini window opens on a new conversation (D-079).
export const MINI_IDLE_MS = 10 * 60_000

// hiddenAt: when the window was last put away, null if it never was since this conversation started.
export function shouldStartFresh(hiddenAt: number | null, now: number, streaming: boolean): boolean {
  return hiddenAt !== null && !streaming && now - hiddenAt > MINI_IDLE_MS
}
