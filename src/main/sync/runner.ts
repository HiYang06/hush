// When sync runs: soon() waits for changes to settle (several in a row become one run), now() runs at
// once. Never two runs at a time: asked while running, it runs once more right after.
export type Runner = { soon: () => void; now: () => void; stop: () => void }

export function createRunner(run: () => Promise<void>, settleMs = 2000): Runner {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let again = false

  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const start = async (): Promise<void> => {
    clear()
    if (running) {
      again = true
      return
    }
    running = true
    try {
      await run()
    } finally {
      running = false
      if (again) {
        again = false
        void start()
      }
    }
  }

  return {
    soon: () => {
      clear()
      timer = setTimeout(start, settleMs)
    },
    now: () => void start(),
    stop: () => {
      clear()
      again = false
    }
  }
}
