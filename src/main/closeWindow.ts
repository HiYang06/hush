import type { BrowserWindow } from 'electron'

// Give pending note saves a chance to finish, but a hung renderer must not prevent closing or quitting.
export function closeAfterFlush(win: BrowserWindow, finish: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  win.on('close', (event) => {
    if (win.webContents.isCrashed()) return
    event.preventDefault()
    if (timer !== undefined) return
    timer = setTimeout(finish, 2_000)
    win.webContents.send('app:flush', null)
  })
  win.on('closed', () => clearTimeout(timer))
}
