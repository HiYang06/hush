import React from 'react'
import { useAppStore } from '@renderer/stores/appStore'
import { Group, Row } from './SettingsView'

const PRESETS = [14, 15, 16, 17, 18, 20, 22]

export const ReadingSettings: React.FC = () => {
  const fontSize = useAppStore((s) => s.fontSize)
  const setFontSize = useAppStore((s) => s.setFontSize)
  const resetFontSize = useAppStore((s) => s.resetFontSize)

  return (
    <>
      <header className="settings-header">
        <div>
          <h1 className="settings-title">阅读排版</h1>
          <p className="settings-subtitle">
            调整界面与正文字号大小，侧栏与排版等比例缩放以适应不同显示屏。支持快捷键 ⌘+ / ⌘-（Windows 上为 Ctrl+ / Ctrl-），⌘0 恢复默认。
          </p>
        </div>
      </header>

      <Group
        title="字号大小"
        actions={
          fontSize !== 16 && (
            <button type="button" className="settings-link" onClick={resetFontSize}>
              恢复默认 (16px)
            </button>
          )
        }
      >
        <Row label="界面与字号">
          <div className="font-size-control">
            <button
              type="button"
              className="settings-btn font-size-step-btn"
              disabled={fontSize <= 12}
              onClick={() => setFontSize(fontSize - 1)}
              aria-label="缩小字号"
            >
              −
            </button>
            <input
              type="range"
              min={12}
              max={24}
              step={1}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              className="font-size-slider"
              aria-label="字号大小滑动条"
            />
            <button
              type="button"
              className="settings-btn font-size-step-btn"
              disabled={fontSize >= 24}
              onClick={() => setFontSize(fontSize + 1)}
              aria-label="放大字号"
            >
              +
            </button>
            <span className="font-size-display num">{fontSize}px</span>
          </div>
        </Row>
        <div className="font-size-presets-row">
          <span className="settings-row-label">常用预设</span>
          <div className="font-size-presets">
            {PRESETS.map((size) => (
              <button
                key={size}
                type="button"
                className={`font-size-preset-btn ${fontSize === size ? 'active' : ''}`}
                onClick={() => setFontSize(size)}
              >
                {size}px{size === 16 ? ' (默认)' : ''}
              </button>
            ))}
          </div>
        </div>
      </Group>

      <Group title="排版预览">
        <div className="font-size-preview-card">
          <div className="markdown-body">
            <h3>学习新知识的阅读体验</h3>
            <p>
              Hush 的原则是干净、轻、阅读优先。排版、滚动和流式输出都按照长时间沉浸阅读的舒适度来设计。
            </p>
            <p>
              正文支持中西文混排，代码使用 JetBrains Mono：<code>const reading = enjoy(hush);</code>
            </p>
          </div>
        </div>
      </Group>
    </>
  )
}
