// The only way out of the page: taps go to Swift, which owns navigation, sheets and the browser.
export type ToSwift =
  | { type: 'ready' }
  | { type: 'mark'; id: string }
  | { type: 'thread'; id: string }
  | { type: 'message'; id: string }
  | { type: 'session'; id: string }
  | { type: 'clip'; id: string; start: number; end: number }
  | { type: 'file'; id: string }
  | { type: 'note'; id: string; section: string | null }
  | { type: 'link'; url: string }

declare global {
  interface Window {
    webkit: { messageHandlers: { hush: { postMessage(message: ToSwift): void } } }
  }
}

export function post(message: ToSwift): void {
  window.webkit.messageHandlers.hush.postMessage(message)
}

// The desktop components reach the main process through window.api; here the one call they make,
// opening a link, goes to Swift instead.
window.api = {
  invoke: (channel: string, ...args: unknown[]) => {
    if (channel !== 'links:open') throw new Error(`Not available on iOS: ${channel}`)
    post({ type: 'link', url: String(args[0]) })
    return Promise.resolve()
  }
} as unknown as Window['api']
