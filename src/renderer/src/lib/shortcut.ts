// Electron accelerators for the mini window's global shortcut (D-079).

const MAC_SYMBOLS: Record<string, string> = { Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧' }

// "Alt+Space" reads "⌥Space" on macOS and stays "Alt+Space" on Windows.
export function formatAccelerator(accelerator: string, mac: boolean): string {
  if (!mac) return accelerator.replace('Control', 'Ctrl').replace('Super', 'Win')
  return accelerator
    .split('+')
    .map((part) => MAC_SYMBOLS[part] ?? part)
    .join('')
}

type KeyPress = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

// The key by its position (code), not the character it types: with ⌥ held, macOS turns letters into
// symbols. null until a non-modifier key comes with at least one modifier other than Shift, since a
// global shortcut without one would swallow ordinary typing in every app.
export function acceleratorOf(e: KeyPress, mac: boolean): string | null {
  const key = keyName(e.code)
  if (!key || !(e.metaKey || e.ctrlKey || e.altKey)) return null
  const modifiers = [
    e.metaKey && (mac ? 'Command' : 'Super'),
    e.ctrlKey && 'Control',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift'
  ].filter((m): m is string => Boolean(m))
  return [...modifiers, key].join('+')
}

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  if (code === 'Space') return 'Space'
  return null
}
