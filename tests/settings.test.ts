import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDb } from '../src/main/db'
import {
  DEFAULT_FONT_SIZE,
  getFontSize,
  getMiniShortcut,
  getOpenAtLogin,
  getWebSearch,
  setWebSearch,
  setFontSize,
  setMiniShortcut,
  setOpenAtLogin
} from '../src/main/db/repo/settings'

describe('settings repo', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('defaults to 16 when not set', () => {
    expect(getFontSize(db)).toBe(16)
    expect(DEFAULT_FONT_SIZE).toBe(16)
  })

  it('saves and reads font size', () => {
    setFontSize(db, 18)
    expect(getFontSize(db)).toBe(18)

    setFontSize(db, 14)
    expect(getFontSize(db)).toBe(14)
  })

  it('clamps invalid or out of range values', () => {
    setFontSize(db, 8)
    expect(getFontSize(db)).toBe(12)

    setFontSize(db, 32)
    expect(getFontSize(db)).toBe(24)
  })
})

describe('mini window settings', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('defaults to Alt+Space and opening at login', () => {
    expect(getMiniShortcut(db)).toBe('Alt+Space')
    expect(getOpenAtLogin(db)).toBe(true)
  })

  it('saves both', () => {
    setMiniShortcut(db, 'CommandOrControl+Shift+K')
    setOpenAtLogin(db, false)
    expect(getMiniShortcut(db)).toBe('CommandOrControl+Shift+K')
    expect(getOpenAtLogin(db)).toBe(false)
  })
})


it('keeps web search across database reopenings without queuing it for sync', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'hush-settings-')), 'hush.db')
  let db = openDb(path)
  expect(getWebSearch(db)).toBe(true)
  setWebSearch(db, false)
  db.close()
  db = openDb(path)
  expect(getWebSearch(db)).toBe(false)
  setWebSearch(db, true)
  expect(getWebSearch(db)).toBe(true)
  expect(db.prepare("SELECT * FROM sync_dirty WHERE tbl = 'settings' AND row_id = 'web_search'").all()).toEqual([])
  db.close()
})
