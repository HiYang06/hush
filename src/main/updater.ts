import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
// Electron's fs treats an .asar file as a folder, so it can't delete the Hush.app a previous update left here.
import { promises as originalFs } from 'original-fs'
import { join } from 'path'
import type { UpdateStatus } from '@shared/types'

// Unsigned builds can't use electron-updater on macOS (Squirrel.Mac checks the signature), so this checks
// GitHub Releases itself and installs by replacing the app.
const LATEST_URL = 'https://api.github.com/repos/HiYang06/hush/releases/latest'
const CHECK_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000

export type ReleaseAsset = { name: string; browser_download_url: string; size: number; digest?: string | null }
export type Release = { tag_name: string; html_url: string; assets: ReleaseAsset[] }

export type Platform = 'darwin' | 'win32' | string

export type UpdaterDeps = {
  current: string
  platform: Platform
  fetch: typeof fetch
  // A fresh directory for this download; the updater empties it first.
  tempDir: string
  // macOS: the zip's .app, extracted into dir. Returns the .app's path.
  extract: (zipPath: string, dir: string) => Promise<string>
  // Why this copy can't replace itself (dev build, run from the dmg, read-only folder), or null.
  cannotInstall: () => string | null
  // Starts the replacement detached, then quits the app.
  install: (downloaded: string) => void
  emit: (status: UpdateStatus) => void
}

export type Updater = {
  status: () => UpdateStatus
  // background: a failure leaves the state as it was, so the icon never shows an error nobody asked for.
  check: (background?: boolean) => Promise<void>
  download: () => Promise<void>
  install: () => void
}

// Positive when a is newer. Release tags are plain x.y.z (with an optional leading v).
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const [pa, pb] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// Names come from electron-builder.yml: mac's zip keeps the default name, nsis sets Hush-<version>-setup.exe.
export function pickAsset(release: Release, platform: Platform): ReleaseAsset | null {
  const suffix = platform === 'darwin' ? '-arm64-mac.zip' : platform === 'win32' ? '-setup.exe' : null
  if (!suffix) return null
  return release.assets.find((a) => a.name.endsWith(suffix)) ?? null
}

function checkError(err: unknown): string {
  if (err instanceof Error && err.message.startsWith('HTTP ')) {
    return err.message === 'HTTP 403' || err.message === 'HTTP 429'
      ? 'GitHub 暂时拒绝了请求，过一会儿再试'
      : `GitHub 返回了错误（${err.message.slice(5)}）`
  }
  return '连不上 GitHub，请检查网络'
}

export function createUpdater(deps: UpdaterDeps): Updater {
  let status: UpdateStatus = { current: deps.current, state: 'idle', latest: null, percent: 0, error: null }
  let asset: ReleaseAsset | null = null
  let downloaded: string | null = null

  const set = (next: Partial<UpdateStatus>): void => {
    status = { ...status, ...next }
    deps.emit(status)
  }

  const upToDate = (): void => {
    asset = null
    set({ state: 'latest', latest: null })
  }

  const check = async (background = false): Promise<void> => {
    if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return
    const before = status
    set({ state: 'checking', error: null })
    try {
      const res = await deps.fetch(LATEST_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
      })
      // 404: the repository has no published release yet.
      if (res.status === 404) return upToDate()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const release = (await res.json()) as Release
      const version = release.tag_name.replace(/^v/, '')
      if (compareVersions(version, deps.current) <= 0) return upToDate()
      asset = pickAsset(release, deps.platform)
      const latest = { version, url: release.html_url }
      if (!asset) return set({ state: 'manual', latest, error: '这个版本没有适合这台电脑的安装包' })
      const reason = deps.cannotInstall()
      set(reason ? { state: 'manual', latest, error: reason } : { state: 'available', latest })
    } catch (err) {
      if (background) {
        status = before
        deps.emit(status)
      } else {
        // latest: null tells the window a retry means checking again, not downloading again.
        asset = null
        set({ state: 'failed', latest: null, error: checkError(err) })
      }
    }
  }

  const download = async (): Promise<void> => {
    if (status.state !== 'available' && !(status.state === 'failed' && asset)) return
    const target = asset!
    set({ state: 'downloading', percent: 0, error: null })
    try {
      await originalFs.rm(deps.tempDir, { recursive: true, force: true })
      await mkdir(deps.tempDir, { recursive: true })
      const file = join(deps.tempDir, target.name)
      const res = await deps.fetch(target.browser_download_url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || target.size
      const hash = createHash('sha256')
      const out = createWriteStream(file)
      let received = 0
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        hash.update(chunk)
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
        received += chunk.length
        const percent = Math.min(99, Math.floor((received / total) * 100))
        if (percent !== status.percent) set({ percent })
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
      const expected = target.digest?.replace(/^sha256:/, '')
      if (!expected || hash.digest('hex') !== expected) {
        set({ state: 'failed', error: '下载的文件校验不通过，请重试' })
        return
      }
      downloaded = deps.platform === 'darwin' ? await deps.extract(file, join(deps.tempDir, 'app')) : file
      set({ state: 'ready', percent: 100 })
    } catch {
      set({ state: 'failed', error: '下载没有完成，请检查网络后重试' })
    }
  }

  const install = (): void => {
    if (status.state !== 'ready' || !downloaded) return
    deps.install(downloaded)
  }

  return { status: () => status, check, download, install }
}
