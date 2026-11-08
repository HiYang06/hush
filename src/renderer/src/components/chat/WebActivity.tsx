import React, { useState } from 'react'
import type { WebActivity as WebActivityData, WebStep } from '@shared/types'

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

function stepText(step: WebStep): string {
  switch (step.type) {
    case 'search':
      return `搜索：${step.query}`
    case 'read':
      return `阅读：${hostOf(step.url)}`
    case 'doc_search':
      return `检索《${step.file}》：${step.query}`
    case 'doc_read':
      return `翻阅《${step.file}》第 ${step.start === step.end ? step.start : `${step.start}–${step.end}`} 页`
  }
}

function count(steps: WebStep[], type: WebStep['type']): number {
  return steps.filter((s) => s.type === type).length
}

// What a reply looked up, online or in attached documents: the current step while it works, then one
// line that opens to the list.
export const WebActivity: React.FC<{ web: WebActivityData; busy: boolean }> = ({ web, busy }) => {
  const [expanded, setExpanded] = useState(false)
  const last = web.steps[web.steps.length - 1]

  if (busy && last) {
    return (
      <div className="status-thinking-live-header web-live">
        <span>{stepText(last)}</span>
      </div>
    )
  }

  const searches = count(web.steps, 'search')
  const reads = count(web.steps, 'read')
  const docSearches = count(web.steps, 'doc_search')
  const docPages = web.steps.reduce((n, s) => (s.type === 'doc_read' ? n + s.end - s.start + 1 : n), 0)
  const summary = [
    searches > 0 && `搜索 ${searches} 次`,
    reads > 0 && `读了 ${reads} 个网页`,
    docSearches > 0 && `检索文档 ${docSearches} 次`,
    docPages > 0 && `翻阅 ${docPages} 页`,
    (searches > 0 || reads > 0) && `${web.sources.length} 个来源`
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div>
      <button type="button" className="thinking-done-toggle" onClick={() => setExpanded((prev) => !prev)}>
        <span>{summary}</span>
        <span className={`thinking-done-chevron ${expanded ? 'expanded' : ''}`}>›</span>
      </button>
      {expanded && (
        <div className="web-activity-detail">
          <ul className="web-steps">
            {web.steps.map((step, i) => (
              <li key={i}>{stepText(step)}</li>
            ))}
          </ul>
          {web.sources.length > 0 && (
          <ol className="web-sources">
            {web.sources.map((source) => (
              <li key={source.n}>
                <span className="web-source-n">{source.n}</span>
                <button type="button" className="web-source-link" onClick={() => window.api.invoke('links:open', source.url)}>
                  {source.title}
                </button>
                <span className="web-source-meta">
                  {hostOf(source.url)}
                  {source.date && ` · ${source.date}`}
                </span>
              </li>
            ))}
          </ol>
          )}
        </div>
      )}
    </div>
  )
}
