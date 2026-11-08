import { app, BrowserWindow, Menu, nativeTheme, net, protocol, shell } from 'electron'
import { execFile, spawn } from 'child_process'
import { accessSync, constants, readdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import type Database from 'better-sqlite3'
import { openDb } from './db'
import { getFontSize, getMiniShortcut, getOpenAtLogin } from './db/repo/settings'
import { getFiles } from './db/repo/files'
import { createFileStore, type FileStore } from './files/store'
import { registerIpc } from './ipc'
import { applyOpenAtLogin, createMini, openedAtLogin } from './miniWindow'
import { createSyncService } from './sync/service'
import { createUpdater } from './updater'

// HUSH_SYNC_URL points a dev build at a local server (cd server && npm start).
const SYNC_URL = process.env.HUSH_SYNC_URL ?? 'https://hush.evildentist.uk'
const SYNC_CHECK_MS = 60_000
const UPDATE_FIRST_CHECK_MS = 10_000
const UPDATE_CHECK_MS = 6 * 60 * 60_000

function broadcast(channel: 'sync:status' | 'sync:applied' | 'updater:status', payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

// hush-file://<file id> serves an attachment to the window, which can't read files itself (CLAUDE.md).
const FILE_SCHEME = 'hush-file'
// fetch() is for the 附件 preview, which reads the raw bytes. The window's origin (file:// when packaged,
// localhost in dev) is never hush-file://, so every read is cross-origin and needs the CORS header.
protocol.registerSchemesAsPrivileged([
  { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

function serveFiles(db: Database.Database, files: FileStore): void {
  protocol.handle(FILE_SCHEME, async (request) => {
    const [file] = getFiles(db, [new URL(request.url).hostname])
    if (!file) return new Response(null, { status: 404 })
    try {
      await files.ensure(file)
    } catch {
      // The window asks files:ensure for the reason; an <img> can't read it from here anyway.
      return new Response(null, { status: 404 })
    }
    const res = await net.fetch(pathToFileURL(files.pathOf(file)).toString())
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: res.status, headers })
  })
}

// Hush.app, from .../Hush.app/Contents/MacOS/Hush.
const appBundle = (): string => resolve(app.getPath('exe'), '../../..')

function cannotInstall(): string | null {
  // A dev build's app is node_modules' Electron.app.
  if (!app.isPackaged) return '开发版本不能自动安装'
  if (process.platform !== 'darwin') return null
  const bundle = appBundle()
  // Run from the dmg, or moved by macOS to a random read-only folder because it was never dragged out.
  if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    return '先把 Hush 拖进「应用程序」文件夹，才能自动更新'
  }
  try {
    accessSync(dirname(bundle), constants.W_OK)
    accessSync(bundle, constants.W_OK)
  } catch {
    return 'Hush 所在的文件夹不能写入，没法自动替换'
  }
  return null
}

// ditto, not a zip library: Electron's frameworks are full of symlinks it keeps as they are.
async function extractApp(zipPath: string, dir: string): Promise<string> {
  await promisify(execFile)('ditto', ['-x', '-k', zipPath, dir])
  const name = readdirSync(dir).find((n) => n.endsWith('.app'))
  if (!name) throw new Error('No .app in the update')
  return join(dir, name)
}

// Waits for this process to exit, swaps the app, and puts the old one back if the copy fails.
const SWAP_SCRIPT = `pid=$1; new=$2; dest=$3; backup="$dest.old-update"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$backup"
if mv "$dest" "$backup"; then
  if ditto "$new" "$dest"; then rm -rf "$backup"; else rm -rf "$dest"; mv "$backup" "$dest"; fi
fi
open "$dest"`

function installUpdate(downloaded: string): void {
  const child =
    process.platform === 'darwin'
      ? spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'sh', String(process.pid), downloaded, appBundle()], {
          detached: true,
          stdio: 'ignore'
        })
      : // electron-builder's NSIS installer: silent, closes the running app, opens the new one when done.
        spawn(downloaded, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' })
  child.unref()
  app.quit()
}

// Set by ⌘Q; a window held open for flushing then finishes the quit instead of only closing.
let quitting = false

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

let currentDb: Database.Database | null = null
// The mini window lives as long as the app, hidden; this is the window the app is "open" in.
let mainWindow: BrowserWindow | null = null
const PRELOAD = join(__dirname, '../preload/index.js')

function load(win: BrowserWindow, mode: 'main' | 'mini'): void {
  // Links in AI answers are untrusted: only hand web/mail links to the OS, never file:// or app schemes.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  const query = mode === 'mini' ? { mode } : undefined
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${query ? `?mode=${mode}` : ''}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

function createWindow(db = currentDb): BrowserWindow {
  const isMac = process.platform === 'darwin'

  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 800,
    minHeight: 560,
    show: false,
    // On Windows the window draws its own minimize / maximize / close (WindowControls); 'hidden' keeps
    // the resizable frame and snapping, which a fully frameless window would lose.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 16, y: 15 } : undefined,
    // Must match --bg-primary in tokens.css, so the window shows paper before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191B' : '#F9F9F7',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true
    }
  })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.on('ready-to-show', () => {
    if (db) {
      const factor = getFontSize(db) / 16
      if (factor !== 1) win.webContents.setZoomFactor(factor)
    }
    win.show()
  })

  win.on('maximize', () => win.webContents.send('window:maximized', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized', false))

  // Note edits wait 0.5s in the window before saving, and an unload handler's save may never arrive,
  // so the close waits for the window to say it's done (app:flushed destroys it).
  win.on('close', (event) => {
    if (win.webContents.isCrashed()) return
    event.preventDefault()
    win.webContents.send('app:flush', null)
  })

  load(win, 'main')

  return win
}

// Windows starts a new process each time the shortcut is clicked (macOS brings the running app forward);
// two would share one database and both sync. exit, not quit: quit would still let whenReady below run.
if (!app.requestSingleInstanceLock()) app.exit(0)

// sessionId: a session to show, from the mini window's 在主窗口打开.
function openMain(sessionId: string | null = null): void {
  const existing = mainWindow
  const win = existing ?? createWindow()
  // A new window shows itself once it has painted.
  if (existing?.isMinimized()) existing.restore()
  existing?.show()
  // The mini window doesn't activate the app (it's a panel), so coming from it the app isn't frontmost yet.
  app.focus({ steal: true })
  if (!sessionId) return
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => win.webContents.send('session:open', sessionId))
  } else {
    win.webContents.send('session:open', sessionId)
  }
}

app.on('second-instance', () => openMain())

app.whenReady().then(() => {
  if (process.platform !== 'darwin') {
    // Without a menu, Ctrl+R / Ctrl+W / Ctrl+Shift+I stop reloading or closing the window; copy, paste and
    // undo don't depend on it outside macOS.
    Menu.setApplicationMenu(null)
  }
  // A packaged app gets its dock icon from build/icon.icns; in dev the dock would show Electron's.
  if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'))
  const db = openDb(join(app.getPath('userData'), 'hush.db'))
  currentDb = db
  // The store downloads through sync and sync uploads from the store; the arrow defers the lookup.
  const files = createFileStore(db, join(app.getPath('userData'), 'attachments'), (sha256) => sync.download(sha256))
  const sync = createSyncService({
    db,
    baseUrl: SYNC_URL,
    emitStatus: (status) => broadcast('sync:status', status),
    emitApplied: (applied) => broadcast('sync:applied', applied),
    readFile: files.read
  })
  serveFiles(db, files)
  const mini = createMini({
    accelerator: getMiniShortcut(db),
    preload: PRELOAD,
    isQuitting: () => quitting,
    load,
    openMain: () => openMain()
  })
  applyOpenAtLogin(getOpenAtLogin(db))
  const updater = createUpdater({
    current: app.getVersion(),
    platform: process.platform,
    fetch,
    tempDir: join(app.getPath('temp'), 'hush-update'),
    extract: extractApp,
    cannotInstall,
    install: installUpdate,
    emit: (status) => broadcast('updater:status', status)
  })
  registerIpc(db, files, sync, mini, updater, openMain, () => {
    mainWindow?.destroy()
    if (quitting) app.quit()
  })
  if (!openedAtLogin()) createWindow()
  sync.check()
  setInterval(sync.check, SYNC_CHECK_MS)
  app.on('browser-window-focus', sync.check)
  if (app.isPackaged) {
    setTimeout(() => updater.check(true), UPDATE_FIRST_CHECK_MS)
    setInterval(() => updater.check(true), UPDATE_CHECK_MS)
  }

  app.on('activate', () => {
    if (!mainWindow) createWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
})

// Closing the main window never quits: the mini window and the tray keep the app running, on Windows too.
// Quitting is ⌘Q or the tray menu's 退出 Hush.
app.on('window-all-closed', () => {})
