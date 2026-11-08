import React, { useEffect, useState } from 'react'

// Windows only (D-074): minimize / maximize / close drawn in the paper style instead of the system's.
// Coordinates sit on half pixels so the 1px strokes land on whole device pixels at 100% scale.
export const WindowControls: React.FC = () => {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => window.api.on('window:maximized', setMaximized), [])

  return (
    <div className="window-controls">
      <button type="button" className="window-control-btn" aria-label="最小化" onClick={() => void window.api.invoke('window:minimize')}>
        <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1">
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control-btn"
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => void window.api.invoke('window:toggleMaximize')}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="2.5" width="7" height="7" />
            <path d="M2.5 2.5v-2h7v7h-2" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-control-btn window-control-close"
        aria-label="关闭"
        onClick={() => void window.api.invoke('window:close')}
      >
        <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  )
}
