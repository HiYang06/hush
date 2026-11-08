import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { Api } from '@shared/types'

// A single generic invoke instead of one wrapper per method: only channels registered in main/ipc.ts answer,
// so this exposes nothing extra, and adding an endpoint never touches this file.
const api: Api = {
  platform: process.platform,
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  // Same idea for pushes from main: one generic subscriber, typed by IpcEvents.
  on: (channel, listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void =>
      listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  setZoomFactor: (factor: number) => {
    webFrame.setZoomFactor(factor)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error fallback when contextIsolation is disabled
  window.api = api
}
