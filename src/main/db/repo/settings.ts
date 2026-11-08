import type Database from 'better-sqlite3'

export const DEFAULT_FONT_SIZE = 16
export const MIN_FONT_SIZE = 12
export const MAX_FONT_SIZE = 24
export const DEFAULT_MINI_SHORTCUT = 'Alt+Space'

function getSetting(db: Database.Database, key: string): string | undefined {
  return db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export function getFontSize(db: Database.Database): number {
  const row = getSetting(db, 'font_size')
  if (row === undefined || row === null) return DEFAULT_FONT_SIZE
  const num = Number(row)
  if (!Number.isFinite(num) || num < MIN_FONT_SIZE || num > MAX_FONT_SIZE) {
    return DEFAULT_FONT_SIZE
  }
  return num
}

export function setFontSize(db: Database.Database, size: number): void {
  const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
  setSetting(db, 'font_size', String(clamped))
}

// An Electron accelerator, e.g. 'Alt+Space'.
export function getMiniShortcut(db: Database.Database): string {
  return getSetting(db, 'mini_shortcut') || DEFAULT_MINI_SHORTCUT
}

export function setMiniShortcut(db: Database.Database, accelerator: string): void {
  setSetting(db, 'mini_shortcut', accelerator)
}

export function getOpenAtLogin(db: Database.Database): boolean {
  return getSetting(db, 'open_at_login') !== '0'
}

export function setOpenAtLogin(db: Database.Database, on: boolean): void {
  setSetting(db, 'open_at_login', on ? '1' : '0')
}
