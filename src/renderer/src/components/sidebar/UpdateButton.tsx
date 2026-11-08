import React, { useEffect, useRef, useState } from 'react'
import type { UpdateStatus } from '@shared/types'
import { useAppStore } from '@renderer/stores/appStore'
import { UpdateArrowIcon } from '@renderer/components/common/Icons'

const DOT_STATES = new Set<UpdateStatus['state']>(['available', 'downloading', 'ready', 'manual'])

function Body({ status }: { status: UpdateStatus }): React.ReactElement {
  const { state, latest, percent, error } = status
  const notes = latest && (
    <button type="button" className="settings-link" onClick={() => void window.api.invoke('links:open', latest.url)}>
      更新内容 ↗
    </button>
  )
  switch (state) {
    case 'idle':
    case 'checking':
      return <p className="update-line">正在检查更新…</p>
    case 'latest':
      return <p className="update-line">已是最新版本</p>
    case 'available':
      return (
        <>
          <p className="update-line">
            有新版本 {latest?.version} {notes}
          </p>
          <button type="button" className="settings-btn primary" onClick={() => void window.api.invoke('updater:download')}>
            下载并更新
          </button>
        </>
      )
    case 'downloading':
      return (
        <>
          <p className="update-line">
            正在下载 {latest?.version}… {percent}%
          </p>
          <div className="update-progress">
            <div style={{ width: `${percent}%` }} />
          </div>
        </>
      )
    case 'ready':
      return (
        <>
          <p className="update-line">
            {latest?.version} 已下载好 {notes}
          </p>
          <button type="button" className="settings-btn primary" onClick={() => void window.api.invoke('updater:install')}>
            重启并更新
          </button>
        </>
      )
    case 'manual':
      return (
        <>
          <p className="update-line">
            有新版本 {latest?.version} {notes}
          </p>
          <p className="update-hint">{error}</p>
          <button
            type="button"
            className="settings-btn"
            onClick={() => latest && void window.api.invoke('links:open', latest.url)}
          >
            去下载页
          </button>
        </>
      )
    case 'failed':
      return (
        <>
          <p className="update-hint">{error}</p>
          <button
            type="button"
            className="settings-btn"
            onClick={() => void window.api.invoke(latest ? 'updater:download' : 'updater:check')}
          >
            重试
          </button>
        </>
      )
  }
}

export const UpdateButton: React.FC = () => {
  const status = useAppStore((s) => s.updateStatus)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  if (!status) return null
  const dot = DOT_STATES.has(status.state)

  const toggle = (): void => {
    const opening = !open
    setOpen(opening)
    // Opening is the 检查更新; main ignores it while downloading or once downloaded.
    if (opening && !dot) void window.api.invoke('updater:check')
  }

  return (
    <div className="update-anchor" ref={ref}>
      <button
        type="button"
        className="sidebar-settings-btn"
        onClick={toggle}
        title={dot ? '有新版本' : '检查更新'}
        aria-label={dot ? '有新版本' : '检查更新'}
        aria-expanded={open}
      >
        <UpdateArrowIcon size={15} />
        {dot && <span className="sidebar-settings-dot update-dot" />}
      </button>
      {open && (
        <div className="update-card" role="dialog" aria-label="更新">
          <p className="update-title">Hush {status.current}</p>
          <Body status={status} />
        </div>
      )}
    </div>
  )
}
