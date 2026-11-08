export const isWindows = window.api.platform === 'win32'

// Prefix for shortcut hints: "⌘K" on macOS, "Ctrl+K" on Windows.
export const modKey = isWindows ? 'Ctrl+' : '⌘'

// On Windows the window buttons sit in the right panel's header, which then needs room for its four tabs.
export const rightPanelMinWidth = isWindows ? 470 : 300
