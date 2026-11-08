// Renders build/icon.svg and build/icon-small.svg into build/icon.{png,icns,ico}, build/icon-tray.svg into the
// menu bar icon (build/tray-*.png), and build/icon-ios.svg into the iOS app's icon.
// Runs in Electron so the SVG is rasterized by Chromium; needs macOS for iconutil.
import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BUILD = join(import.meta.dirname, '../build')
const SMALL_MAX = 32

async function render(win, size, file = size <= SMALL_MAX ? 'icon-small.svg' : 'icon.svg') {
  const svg = readFileSync(join(BUILD, file))
  const src = 'data:image/svg+xml;base64,' + svg.toString('base64')
  const url = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = ${size}
      canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size})
      resolve(canvas.toDataURL('image/png'))
    }
    img.src = '${src}'
  })`)
  return Buffer.from(url.split(',')[1], 'base64')
}

// PNG-compressed entries, which Windows has read since Vista.
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  let offset = header.length
  pngs.forEach(([size, png], i) => {
    const entry = 6 + 16 * i
    header.writeUInt8(size % 256, entry)
    header.writeUInt8(size % 256, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...pngs.map(([, png]) => png)])
}

app.dock?.hide()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,<body></body>')

  const pngs = new Map()
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) pngs.set(size, await render(win, size))

  writeFileSync(join(BUILD, 'icon.png'), pngs.get(1024))

  const iconset = join(mkdtempSync(join(tmpdir(), 'hush-icon-')), 'icon.iconset')
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${size}x${size}.png`), pngs.get(size))
    writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), pngs.get(size * 2))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(BUILD, 'icon.icns')])
  rmSync(join(iconset, '..'), { recursive: true })

  writeFileSync(join(BUILD, 'icon.ico'), ico([16, 24, 32, 48, 64, 256].map((size) => [size, pngs.get(size)])))
  // Tray icons: 36px is the 18pt menu bar icon at 2x; Windows' tray takes the small colored icon.
  writeFileSync(join(BUILD, 'tray-mac.png'), await render(win, 36, 'icon-tray.svg'))
  writeFileSync(join(BUILD, 'tray-win.png'), pngs.get(32))
  writeFileSync(join(BUILD, '../ios/Hush/Assets.xcassets/AppIcon.appiconset/icon.png'), await render(win, 1024, 'icon-ios.svg'))
  app.quit()
})
