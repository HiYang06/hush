import { describe, expect, it } from 'vitest'
import { acceleratorOf, formatAccelerator } from '../../src/renderer/src/lib/shortcut'

const press = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

describe('acceleratorOf', () => {
  it('builds an accelerator from the physical key', () => {
    expect(acceleratorOf(press('Space', { altKey: true }), true)).toBe('Alt+Space')
    expect(acceleratorOf(press('KeyK', { metaKey: true, shiftKey: true }), true)).toBe('Command+Shift+K')
    expect(acceleratorOf(press('Digit1', { ctrlKey: true, altKey: true }), true)).toBe('Control+Alt+1')
    expect(acceleratorOf(press('F5', { ctrlKey: true }), true)).toBe('Control+F5')
  })

  it('waits for a key, and for a modifier other than Shift', () => {
    expect(acceleratorOf(press('AltLeft', { altKey: true }), true)).toBeNull()
    expect(acceleratorOf(press('KeyA'), true)).toBeNull()
    expect(acceleratorOf(press('KeyA', { shiftKey: true }), true)).toBeNull()
    expect(acceleratorOf(press('Comma', { altKey: true }), true)).toBeNull()
  })

  it('names the Windows key Super on Windows', () => {
    expect(acceleratorOf(press('KeyK', { metaKey: true }), false)).toBe('Super+K')
  })
})

describe('formatAccelerator', () => {
  it('uses symbols on macOS only', () => {
    expect(formatAccelerator('Alt+Space', true)).toBe('⌥Space')
    expect(formatAccelerator('Command+Shift+K', true)).toBe('⌘⇧K')
    expect(formatAccelerator('Alt+Space', false)).toBe('Alt+Space')
    expect(formatAccelerator('Control+Super+K', false)).toBe('Ctrl+Win+K')
  })
})
