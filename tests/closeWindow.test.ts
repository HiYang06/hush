import { EventEmitter } from 'events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { closeAfterFlush } from '../src/main/closeWindow'

afterEach(() => vi.useRealTimers())

function setup(crashed = false) {
  vi.useFakeTimers()
  const win = Object.assign(new EventEmitter(), {
    webContents: { isCrashed: () => crashed, send: vi.fn() }
  })
  const finish = vi.fn(() => { win.emit('closed') })
  closeAfterFlush(win as unknown as BrowserWindow, finish)
  const event = { preventDefault: vi.fn() }
  return { win, finish, event }
}

it('forces a hung window closed after two seconds, without restarting the deadline on repeated close', () => {
  const { win, finish, event } = setup()
  win.emit('close', event)
  vi.advanceTimersByTime(1_000)
  win.emit('close', event)
  expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith('app:flush', null)
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(999)
  expect(finish).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(finish).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels the fallback when normal flushing destroys the window', () => {
  const { win, finish, event } = setup()
  win.emit('close', event)
  win.emit('closed')
  vi.advanceTimersByTime(2_000)
  expect(finish).not.toHaveBeenCalled()
})

it('lets an already crashed renderer close immediately', () => {
  const { win, event } = setup(true)
  win.emit('close', event)
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
