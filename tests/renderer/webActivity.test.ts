import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WebActivity as WebActivityData, WebStep } from '@shared/types'
import { WebActivity } from '../../src/renderer/src/components/chat/WebActivity'

const renderActivity = (steps: WebStep[], busy: boolean, sources: WebActivityData['sources'] = []): string =>
  renderToStaticMarkup(createElement(WebActivity, { web: { steps, sources }, busy }))

describe('project memory activity', () => {
  it('shows the current session lookup while a reply is running', () => {
    const steps: WebStep[] = [
      { type: 'session_search', query: '特征值' },
      { type: 'session_read', title: '线代 | 特征值分解', start: 2, end: 3 }
    ]
    expect(renderActivity(steps.slice(0, 1), true)).toContain('检索项目会话：特征值')
    const reading = renderActivity(steps, true)
    expect(reading).toContain('查阅《线代 | 特征值分解》第 2–3 轮')
    expect(reading).not.toContain('检索项目会话：特征值')
    expect(renderActivity([{ type: 'session_read', title: '线代', start: 2, end: 2 }], true))
      .toContain('查阅《线代》第 2 轮')
  })

  it('counts search and read calls together, rather than counting rounds', () => {
    const summary = renderActivity([
      { type: 'session_search', query: '特征值' },
      { type: 'session_read', title: '线代', start: 2, end: 5 },
      { type: 'session_search', query: '对角化' }
    ], false)
    expect(summary).toContain('查阅会话 3 次')
    expect(summary).not.toContain('个来源')
  })

  it('keeps web and document activity in a mixed lookup summary', () => {
    const summary = renderActivity([
      { type: 'search', query: 'eigenvalue' },
      { type: 'read', url: 'https://example.com' },
      { type: 'doc_search', file: '线代.pdf', query: '特征值' },
      { type: 'doc_read', file: '线代.pdf', start: 2, end: 3 },
      { type: 'session_read', title: '线代', start: 1, end: 3 }
    ], false, [{ n: 1, url: 'https://example.com', title: '线代', date: null, snippet: '' }])
    expect(summary).toContain('搜索 1 次 · 读了 1 个网页 · 检索文档 1 次 · 翻阅 2 页 · 查阅会话 1 次 · 1 个来源')
  })
})
