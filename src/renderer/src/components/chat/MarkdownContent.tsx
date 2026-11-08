import React from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import remend from 'remend'
import 'katex/dist/katex.min.css'
import type { PluggableList } from 'unified'
import type { Mark, MarkCategory, NoteClipSource, ThreadSession, WebSource } from '@shared/types'
import { hushLinkMessageId } from '@shared/noteClips'
import { ContextMenu } from '@renderer/components/common/ContextMenu'
import { anchorToRange, offsetsToRange } from '@renderer/lib/anchors'
import { remarkCitations } from '@renderer/lib/citations'
import { clearMessage, decorationsAt, drawMessage } from '@renderer/lib/highlights'
import { gfmOptions, normalizeMathDelimiters, splitBlocks } from '@renderer/lib/markdownBlocks'
import type { MarkCardState } from '@renderer/stores/appStore'
import { ShikiCodeBlock } from './ShikiCodeBlock'
import { hostOf } from './WebActivity'

interface MarkdownContentProps {
  content: string
  // Set for an assistant reply, the only kind that carries marks, threads and clips.
  messageId?: string
  // A reply that went online: its [n] markers render as badges pointing at these.
  sources?: WebSource[]
  streaming?: boolean
  marks?: Mark[]
  categories?: MarkCategory[]
  threads?: ThreadSession[]
  clips?: NoteClipSource[]
  onSelectThread?: (threadId: string) => void
  onSelectMark?: (card: MarkCardState) => void
  onSelectClip?: (clip: NoteClipSource) => void
  onJumpToMessage?: (messageId: string) => void
}

const MarkdownContentView: React.FC<MarkdownContentProps> = ({
  content,
  messageId,
  sources,
  streaming = false,
  marks = [],
  categories = [],
  threads = [],
  clips = [],
  onSelectThread,
  onSelectMark,
  onSelectClip,
  onJumpToMessage
}) => {
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const [picker, setPicker] = React.useState<{ x: number; y: number; threads: ThreadSession[] } | null>(null)
  const remarkPlugins = React.useMemo(
    () => [[remarkGfm, gfmOptions], remarkMath, ...(sources?.length ? [remarkCitations(sources)] : [])] as PluggableList,
    [sources]
  )
  // While streaming, close the Markdown the model hasn't finished yet, so a half-written `**` or `$$` doesn't show.
  const blocks = React.useMemo(() => {
    const markdown = normalizeMathDelimiters(content)
    return splitBlocks(streaming ? remend(markdown) : markdown)
  }, [content, streaming])
  const components = React.useMemo<Components>(
    () => ({
      table: ({ children }) => (
        <div className="table-scroll-wrapper">
          <table>{children}</table>
        </div>
      ),
      a: ({ href, children }) => {
        if (href?.startsWith('hush://message/')) {
          const msgId = hushLinkMessageId(href)
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                onJumpToMessage?.(msgId)
              }}
            >
              {children}
            </a>
          )
        }
        // Empty for a link still being streamed (remend) or one urlTransform found unsafe.
        if (!href) return <a>{children}</a>
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      },
      code: ({ className, children, ...props }) => {
        const match = /language-(\w+)/.exec(className || '')
        const rawText = String(children).replace(/\n$/, '')
        const isBlock = Boolean(match) || String(children).includes('\n')

        if (isBlock) {
          return (
            <ShikiCodeBlock
              language={match?.[1] ?? 'text'}
              code={rawText}
              highlight={!streaming}
            />
          )
        }

        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      },
      pre: ({ children }) => <>{children}</>,
      sup: ({ className, children, ...props }) => {
        const n = Number((props as { 'data-cite'?: string })['data-cite'])
        const source = className === 'cite' ? sources?.find((s) => s.n === n) : undefined
        if (!source) return <sup className={className}>{children}</sup>
        return <Citation source={source} />
      }
    }),
    [streaming, sources, onJumpToMessage]
  )
  const decorated = Boolean(messageId) && !streaming && (marks.length > 0 || threads.length > 0 || clips.length > 0)

  React.useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !messageId || !decorated) return
    const draw = (): void => {
      const items = [
        ...marks.map((m) => ({
          decoration: {
            kind: 'mark' as const,
            id: m.id,
            color: categories.find((c) => c.id === m.categoryId)?.color ?? 'amber'
          },
          anchor: { quote: m.quote, start: m.startOffset, end: m.endOffset, prefix: m.prefix, suffix: m.suffix }
        })),
        ...threads.map((t) => ({
          decoration: { kind: 'thread' as const, id: t.id },
          anchor: {
            quote: t.anchorQuote,
            start: t.anchorStart,
            end: t.anchorEnd,
            prefix: t.anchorPrefix,
            suffix: t.anchorSuffix
          }
        }))
      ]
      drawMessage(messageId, [
        ...items.flatMap(({ decoration, anchor }) => {
          const range = anchorToRange(root, anchor)
          return range ? [{ range, decoration }] : []
        }),
        ...clips.flatMap((c) => {
          const range = offsetsToRange(root, c.start, c.end)
          return range ? [{ range, decoration: { kind: 'clip' as const, clip: c } }] : []
        })
      ])
    }
    draw()
    // Code highlighting finishes after this and swaps text nodes, which collapses ranges inside them.
    let frame = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(draw)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      clearMessage(messageId)
    }
  }, [messageId, decorated, content, marks, threads, clips, categories])

  const handleClick = (e: React.MouseEvent): void => {
    // Finishing a selection also clicks; that's for the toolbar, not for opening anything.
    if (!decorated || !window.getSelection()?.isCollapsed) return
    // Clicks in the portalled picker bubble here through React's tree.
    if (!rootRef.current?.contains(e.target as Node)) return
    const hits = decorationsAt(e.clientX, e.clientY)
    const hitThreads = threads
      .filter((t) => hits.some((d) => d.kind === 'thread' && d.id === t.id))
      .sort((a, b) => a.anchorStart - b.anchorStart)
    const mark = hits.flatMap((d) => (d.kind === 'mark' ? [d] : []))[0]
    if (hitThreads.length === 1) onSelectThread?.(hitThreads[0].id)
    else if (hitThreads.length > 1) setPicker({ x: e.clientX, y: e.clientY, threads: hitThreads })
    else if (mark) onSelectMark?.({ x: e.clientX, top: e.clientY - 12, bottom: e.clientY + 12, markId: mark.id })
    else {
      const clip = hits.flatMap((d) => (d.kind === 'clip' ? [d.clip] : []))[0]
      if (clip) onSelectClip?.(clip)
    }
  }

  // ::highlight() can't set a cursor, so the pointer follows a hit test.
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!decorated) return
    e.currentTarget.style.cursor = decorationsAt(e.clientX, e.clientY).length > 0 ? 'pointer' : ''
  }

  return (
    <>
      <div ref={rootRef} className="markdown-body" onClick={handleClick} onMouseMove={handleMouseMove}>
        {blocks.map((block, i) => (
          <React.Fragment key={i}>
            {i > 0 && '\n'}
            <MarkdownBlock source={block} remarkPlugins={remarkPlugins} components={components} />
          </React.Fragment>
        ))}
      </div>
      {/* In <body>: .message-item's content-visibility would clip a fixed menu and offset it, and
          inside .markdown-body its text would count toward anchor positions. */}
      {picker &&
        createPortal(
          <ContextMenu
            x={picker.x}
            y={picker.y}
            items={[
              { section: `这里有 ${picker.threads.length} 次追问` },
              ...picker.threads.map((t) => ({ label: t.title, onSelect: () => onSelectThread?.(t.id) }))
            ]}
            onClose={() => setPicker(null)}
          />,
          document.body
        )}
    </>
  )
}

const urlTransform = (url: string): string =>
  url.startsWith('hush://message/') ? url : defaultUrlTransform(url)

// Memoised so that while a reply streams, the blocks already finished aren't parsed and rendered again.
const MarkdownBlock = React.memo<{
  source: string
  remarkPlugins: PluggableList
  components: Components
}>(({ source, remarkPlugins, components }) => (
  <ReactMarkdown
    remarkPlugins={remarkPlugins}
    rehypePlugins={[rehypeKatex]}
    urlTransform={urlTransform}
    components={components}
  >
    {source}
  </ReactMarkdown>
))

// A cited source as a small badge: hover shows where it's from, a click opens it in the browser.
// data-anchor-skip keeps the number out of mark positions; data-url lets a clip turn it into a link.
// The card goes to <body>: .message-item's content-visibility clips anything that overflows it.
const Citation: React.FC<{ source: WebSource }> = ({ source }) => {
  const [at, setAt] = React.useState<DOMRect | null>(null)
  return (
    <sup className="cite" data-anchor-skip="" data-url={source.url} data-cite={source.n}>
      {/* A plain inline span, not a <button>: an inline-block would let a line break before the "。" after it. */}
      <span
        role="button"
        tabIndex={0}
        className="cite-badge"
        onMouseEnter={(e) => setAt(e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setAt(null)}
        onClick={() => window.api.invoke('links:open', source.url)}
      >
        {source.n}
      </span>
      {at &&
        createPortal(
          <div
            className="cite-card"
            role="tooltip"
            style={{ left: Math.min(at.left, window.innerWidth - 336), top: at.bottom + 6 }}
          >
            <div className="cite-card-title">{source.title}</div>
            <div className="cite-card-meta">
              {hostOf(source.url)}
              {source.date && ` · ${source.date}`}
            </div>
            {source.snippet && <div className="cite-card-snippet">{source.snippet}</div>}
          </div>,
          document.body
        )}
    </sup>
  )
}

export const MarkdownContent = React.memo(MarkdownContentView)
