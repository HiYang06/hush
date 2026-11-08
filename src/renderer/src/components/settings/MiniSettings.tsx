import React, { useEffect, useState } from 'react'
import { isWindows } from '@renderer/lib/platform'
import { acceleratorOf, formatAccelerator } from '@renderer/lib/shortcut'
import { Check, Group, Row } from './SettingsView'

type State = { shortcut: string; registered: boolean; openAtLogin: boolean }

export const MiniSettings: React.FC<{ onChanged: (shortcut: string) => void }> = ({ onChanged }) => {
  const [state, setState] = useState<State | null>(null)
  const [recording, setRecording] = useState(false)
  const [taken, setTaken] = useState<string | null>(null)

  useEffect(() => {
    void window.api.invoke('miniSettings:get').then(setState)
  }, [])

  useEffect(() => {
    if (!recording) return
    void window.api.invoke('miniSettings:recording', true)
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      // Settings' own Esc (back to the conversation) waits until recording is over.
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const accelerator = acceleratorOf(e, !isWindows)
      if (!accelerator) return
      setRecording(false)
      void (async () => {
        // The old shortcut comes back first, so the new one isn't registered twice.
        await window.api.invoke('miniSettings:recording', false)
        if (await window.api.invoke('miniSettings:setShortcut', accelerator)) {
          setTaken(null)
          setState((s) => s && { ...s, shortcut: accelerator, registered: true })
          onChanged(accelerator)
        } else {
          setTaken(accelerator)
        }
      })()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      void window.api.invoke('miniSettings:recording', false)
    }
  }, [recording, onChanged])

  if (!state) return null
  const shown = formatAccelerator(state.shortcut, !isWindows)
  const problem = taken
    ? `${formatAccelerator(taken, !isWindows)} 被其他应用占用了，换一个`
    : state.registered
      ? null
      : `${shown} 被其他应用占用了，换一个`

  return (
    <>
      <header className="settings-header">
        <div>
          <h1 className="settings-title">小窗提问</h1>
          <p className="settings-subtitle">
            在任何应用里按快捷键，唤起一个浮在最上层的小窗提问；点别处或按 Esc 收起。收起 10 分钟以内再唤起，接着上一段对话；超过 10 分钟就开新对话。小窗里的对话会出现在左栏。
          </p>
        </div>
      </header>

      <Group title="快捷键">
        <Row label="唤起小窗">
          <button
            type="button"
            className={`settings-btn shortcut-recorder ${recording ? 'recording' : ''}`}
            onClick={() => setRecording(!recording)}
          >
            {recording ? '按下新的快捷键…' : shown}
          </button>
        </Row>
      </Group>
      {problem && <p className="settings-muted error project-prompt-hint">{problem}</p>}
      {recording ? (
        <p className="settings-muted project-prompt-hint">要带 {isWindows ? 'Ctrl、Alt 或 Win' : '⌘、⌃ 或 ⌥'}，按 Esc 取消。</p>
      ) : (
        // macOS lets two apps take the same shortcut, so a clash can't be detected there.
        !isWindows && (
          <p className="settings-muted project-prompt-hint">
            按了没反应时，可能是别的应用（比如 Raycast、ChatGPT）也用了这个快捷键，换一个就好。
          </p>
        )
      )}

      <Group title="启动">
        <Row label="开机时启动">
          <Check
            checked={state.openAtLogin}
            label={isWindows ? '在托盘里待命，不打开主窗口' : '在菜单栏待命，不打开主窗口'}
            onChange={(openAtLogin) => {
              setState({ ...state, openAtLogin })
              void window.api.invoke('miniSettings:setOpenAtLogin', openAtLogin)
            }}
          />
        </Row>
      </Group>
    </>
  )
}
