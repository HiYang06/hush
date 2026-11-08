import { app, BrowserWindow, globalShortcut, Menu, nativeImage, nativeTheme, screen, Tray } from 'electron'
import { readFileSync } from 'fs'
import trayMacPath from '../../build/tray-mac.png?asset'
import trayWinPath from '../../build/tray-win.png?asset'

const WIDTH = 640
// Just the header and an empty input box; the page reports its real height once it has drawn.
const INITIAL_HEIGHT = 168
const TOP_FRACTION = 0.2
const MAX_HEIGHT_FRACTION = 0.7

export type Mini = {
  toggle: () => void
  hide: () => void
  // Height of the page's content in CSS pixels.
  resize: (height: number) => void
  shortcut: () => { accelerator: string; registered: boolean }
  // False, and the old shortcut stays, when another app holds the new one.
  setShortcut: (accelerator: string) => boolean
  // Lets the settings page record a shortcut that is the current one, which would otherwise open the window.
  pauseShortcut: (paused: boolean) => void
}

export function createMini({
  accelerator,
  preload,
  isQuitting,
  load,
  openMain
}: {
  accelerator: string
  preload: string
  isQuitting: () => boolean
  // Same page and link guards as the main window.
  load: (win: BrowserWindow, mode: 'mini') => void
  openMain: () => void
}): Mini {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: WIDTH,
    height: INITIAL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // An NSPanel doesn't activate the app, so hiding it leaves the user in the app they were in, and the
    // main window isn't pulled to the front with it.
    type: isMac ? 'panel' : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191B' : '#F9F9F7',
    webPreferences: { preload, contextIsolation: true }
  })
  win.setAlwaysOnTop(true, 'floating')
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  load(win, 'mini')

  let maxHeight = Infinity
  let contentHeight = INITIAL_HEIGHT

  const fitHeight = (): void => {
    const height = Math.round(Math.min(maxHeight, contentHeight * win.webContents.getZoomFactor()))
    const bounds = win.getBounds()
    if (bounds.height !== height) win.setBounds({ ...bounds, height })
  }

  const show = (): void => {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    maxHeight = Math.round(workArea.height * MAX_HEIGHT_FRACTION)
    win.setBounds({
      x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
      y: Math.round(workArea.y + workArea.height * TOP_FRACTION),
      width: WIDTH,
      height: win.getBounds().height
    })
    fitHeight()
    win.show()
    win.focus()
    win.webContents.send('mini:shown', { maxHeight: maxHeight / win.webContents.getZoomFactor() })
  }

  const hide = (): void => {
    if (!win.isVisible()) return
    win.hide()
    win.webContents.send('mini:hidden', null)
  }

  const toggle = (): void => (win.isVisible() && win.isFocused() ? hide() : show())

  win.on('blur', hide)
  // ⌘W only puts it away; it closes for real when the app quits.
  win.on('close', (event) => {
    if (isQuitting()) return
    event.preventDefault()
    hide()
  })

  let current = accelerator
  let registered = globalShortcut.register(current, toggle)
  let paused = false

  const tray = new Tray(trayIcon(isMac))
  tray.setToolTip('Hush')
  const updateMenu = (): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        // registerAccelerator: false only shows the keys; the global shortcut above is what listens.
        { label: '小窗提问', accelerator: registered ? current : undefined, registerAccelerator: false, click: show },
        { label: '打开 Hush', click: openMain },
        { type: 'separator' },
        { label: '退出 Hush', click: () => app.quit() }
      ])
    )
  }
  updateMenu()
  // Windows' convention: a click opens the app, the right click shows the menu.
  if (!isMac) tray.on('click', openMain)

  return {
    toggle,
    hide,
    resize: (height) => {
      contentHeight = height
      fitHeight()
    },
    shortcut: () => ({ accelerator: current, registered }),
    setShortcut: (next) => {
      if (next === current && registered) return true
      if (registered) globalShortcut.unregister(current)
      if (!globalShortcut.register(next, toggle)) {
        registered = globalShortcut.register(current, toggle)
        return false
      }
      current = next
      registered = true
      updateMenu()
      return true
    },
    pauseShortcut: (pause) => {
      if (pause === paused) return
      paused = pause
      if (!registered) return
      if (pause) globalShortcut.unregister(current)
      else globalShortcut.register(current, toggle)
    }
  }
}

function trayIcon(isMac: boolean): Electron.NativeImage {
  if (!isMac) return nativeImage.createFromPath(trayWinPath)
  // Drawn at 2x for an 18pt menu bar icon; a template image is tinted by the system for light and dark.
  const icon = nativeImage.createFromBuffer(readFileSync(trayMacPath), { scaleFactor: 2 })
  icon.setTemplateImage(true)
  return icon
}

// Packaged builds only: in development the login item would be the bare Electron binary.
export function applyOpenAtLogin(on: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
}

// Started at login: wait in the menu bar without opening the main window.
export function openedAtLogin(): boolean {
  return process.platform === 'darwin' ? app.getLoginItemSettings().wasOpenedAtLogin : process.argv.includes('--hidden')
}
