import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync } from 'fs'
import { writeFileSync } from 'original-fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@shared/types'
import { compareVersions, createUpdater, pickAsset, type Release, type UpdaterDeps } from '../src/main/updater'

const ZIP = Buffer.from('pretend zip')
const sha = (b: Buffer): string => `sha256:${createHash('sha256').update(b).digest('hex')}`

// An empty but valid asar: a pickle holding the header's size, then a pickle holding the header JSON.
function emptyAsar(): Buffer {
  const json = Buffer.from(JSON.stringify({ files: {} }))
  const header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4)
  header.writeUInt32LE(header.length - 4, 0)
  header.writeUInt32LE(json.length, 4)
  json.copy(header, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(header.length, 4)
  return Buffer.concat([size, header])
}

function release(tag: string, digest = sha(ZIP)): Release {
  return {
    tag_name: tag,
    html_url: `https://github.com/HiYang06/hush/releases/tag/${tag}`,
    assets: [
      { name: `Hush-${tag.slice(1)}-arm64.dmg`, browser_download_url: 'https://dl/dmg', size: 1 },
      { name: `Hush-${tag.slice(1)}-arm64-mac.zip`, browser_download_url: 'https://dl/zip', size: ZIP.length, digest },
      { name: `Hush-${tag.slice(1)}-setup.exe`, browser_download_url: 'https://dl/exe', size: ZIP.length, digest }
    ]
  }
}

// latest: what api.github.com answers (a Release, an HTTP status, or a network failure).
function setup(latest: Release | number | 'offline', over: Partial<UpdaterDeps> = {}) {
  const emitted: UpdateStatus[] = []
  const installed: string[] = []
  const fakeFetch = (async (url: string) => {
    if (url.startsWith('https://api.github.com')) {
      if (latest === 'offline') throw new TypeError('fetch failed')
      if (typeof latest === 'number') return new Response(null, { status: latest })
      return Response.json(latest)
    }
    return new Response(ZIP, { headers: { 'content-length': String(ZIP.length) } })
  }) as typeof fetch
  const updater = createUpdater({
    current: '0.1.0',
    platform: 'darwin',
    fetch: fakeFetch,
    tempDir: join(mkdtempSync(join(tmpdir(), 'hush-updater-')), 'dl'),
    extract: async (zip, dir) => {
      expect(readFileSync(zip)).toEqual(ZIP)
      return join(dir, 'Hush.app')
    },
    cannotInstall: () => null,
    install: (path) => installed.push(path),
    emit: (s) => emitted.push(s),
    ...over
  })
  return { updater, emitted, installed }
}

describe('compareVersions', () => {
  it('compares each number, not the text', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0)
  })

  it('puts a beta before its release and after the release before it', () => {
    expect(compareVersions('0.2.0', '0.2.0-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0-beta.1', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('v0.2.0-beta.2', '0.2.0-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0-beta.10', '0.2.0-beta.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0-beta.1', '0.2.0-beta.1')).toBe(0)
  })
})

describe('pickAsset', () => {
  it('takes the zip on macOS and the installer on Windows', () => {
    expect(pickAsset(release('v0.2.0'), 'darwin')?.name).toBe('Hush-0.2.0-arm64-mac.zip')
    expect(pickAsset(release('v0.2.0'), 'win32')?.name).toBe('Hush-0.2.0-setup.exe')
    expect(pickAsset(release('v0.2.0'), 'linux')).toBeNull()
  })
})

describe('updater', () => {
  it('is up to date when the release is not newer, or there is no release yet', async () => {
    for (const latest of [release('v0.1.0'), 404]) {
      const { updater } = setup(latest)
      await updater.check()
      expect(updater.status()).toMatchObject({ state: 'latest', latest: null })
    }
  })

  it('downloads, checks the hash, and installs what it extracted', async () => {
    const { updater, emitted, installed } = setup(release('v0.2.0'))
    await updater.check()
    expect(updater.status()).toMatchObject({ state: 'available', latest: { version: '0.2.0' } })
    await updater.download()
    expect(emitted.some((s) => s.state === 'downloading')).toBe(true)
    expect(updater.status()).toMatchObject({ state: 'ready', percent: 100 })
    updater.install()
    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatch(/Hush\.app$/)
  })

  // Electron's fs treats an .asar file as a folder, so clearing out the last update's Hush.app used to fail.
  it('downloads again over the Hush.app a previous update left behind', async () => {
    const tempDir = join(mkdtempSync(join(tmpdir(), 'hush-updater-')), 'dl')
    const resources = join(tempDir, 'app', 'Hush.app', 'Contents', 'Resources')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'app.asar'), emptyAsar())
    const { updater } = setup(release('v0.2.0'), { tempDir })
    await updater.check()
    await updater.download()
    expect(updater.status()).toMatchObject({ state: 'ready' })
  })

  it('refuses a download whose hash does not match', async () => {
    const { updater, installed } = setup(release('v0.2.0', 'sha256:00'))
    await updater.check()
    await updater.download()
    expect(updater.status()).toMatchObject({ state: 'failed', error: '下载的文件校验不通过，请重试' })
    expect(updater.status().latest).not.toBeNull()
    updater.install()
    expect(installed).toHaveLength(0)
  })

  it('sends the person to the download page when this copy cannot replace itself', async () => {
    const { updater } = setup(release('v0.2.0'), { cannotInstall: () => '开发版本不能自动安装' })
    await updater.check()
    expect(updater.status()).toMatchObject({ state: 'manual', error: '开发版本不能自动安装' })
    await updater.download()
    expect(updater.status().state).toBe('manual')
  })

  it('shows a failed check the person asked for, but not a background one', async () => {
    const asked = setup('offline')
    await asked.updater.check()
    expect(asked.updater.status()).toMatchObject({ state: 'failed', latest: null, error: '连不上 GitHub，请检查网络' })

    const background = setup(403)
    await background.updater.check(true)
    expect(background.updater.status().state).toBe('idle')
    await background.updater.check()
    expect(background.updater.status().error).toBe('GitHub 暂时拒绝了请求，过一会儿再试')
  })
})
