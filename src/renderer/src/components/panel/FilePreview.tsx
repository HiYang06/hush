import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import pdfModuleUrl from 'pdfjs-dist/build/pdf.min.mjs?url'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { fileKind, fileUrl, sentFileIds } from '@shared/files'
import type { FileRecord } from '@shared/types'
import { conversationIds, useAppStore } from '@renderer/stores/appStore'
import { FileCard, Lightbox } from '@renderer/components/chat/FileCard'
import { pdfjs } from '@renderer/lib/attachments/media'
import { withUnicodeSymbols } from '@renderer/lib/attachments/office'
import { errorText } from '@renderer/lib/errors'

async function loadFile(id: string): Promise<ArrayBuffer> {
  const res = await fetch(fileUrl(id))
  if (!res.ok) throw new Error(`File ${id} not found`)
  return res.arrayBuffer()
}

type ViewerProps = {
  file: FileRecord
  onPage: (page: number) => void
  onPageCount: (count: number) => void
  onError: () => void
}

// The page nearest the top third of the view, counted from 1.
function currentPage(scroller: HTMLElement, pages: HTMLCollection): number {
  const line = scroller.scrollTop + scroller.clientHeight / 3
  for (let i = 0; i < pages.length; i++) {
    const el = pages[i] as HTMLElement
    if (el.offsetTop + el.offsetHeight > line) return i + 1
  }
  return pages.length
}

const PdfPage: React.FC<{
  doc: PDFDocumentProxy
  pageNumber: number
  size: { width: number; height: number }
  width: number
  root: HTMLElement
}> = ({ doc, pageNumber, size, width, root }) => {
  const ref = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root,
      rootMargin: '100% 0px'
    })
    observer.observe(ref.current!)
    return () => observer.disconnect()
  }, [root])

  // Pages far from view are cleared: a 200-page handout drawn at retina size would take gigabytes.
  useEffect(() => {
    const el = ref.current!
    if (!near || width === 0) return
    const scale = width / size.width
    let cancelled = false
    let cancel = (): void => {}
    void (async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width * devicePixelRatio)
      canvas.height = Math.round(viewport.height * devicePixelRatio)
      const render = page.render({
        canvas,
        viewport: page.getViewport({ scale: scale * devicePixelRatio })
      })
      const textDiv = document.createElement('div')
      textDiv.className = 'textLayer'
      const text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport })
      cancel = () => {
        render.cancel()
        text.cancel()
      }
      try {
        await Promise.all([render.promise, text.render()])
      } catch (e) {
        if (e instanceof pdfjs.RenderingCancelledException || cancelled) return
        throw e
      }
      el.style.setProperty('--scale-factor', String(scale))
      el.replaceChildren(canvas, textDiv)
    })()
    return () => {
      cancelled = true
      cancel()
      el.replaceChildren()
    }
  }, [doc, pageNumber, size.width, width, near])

  return (
    <div
      ref={ref}
      className="pdf-page"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
    />
  )
}

const PdfViewer: React.FC<ViewerProps> = ({ file, onPage, onPageCount, onError }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pagesRef = useRef<HTMLDivElement | null>(null)
  const [doc, setDoc] = useState<{ proxy: PDFDocumentProxy; sizes: { width: number; height: number }[] } | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    let task: ReturnType<typeof pdfjs.getDocument> | null = null
    let cancelled = false
    void (async () => {
      task = pdfjs.getDocument({ data: await loadFile(file.id) })
      const proxy = await task.promise
      const sizes = []
      for (let i = 1; i <= proxy.numPages; i++) {
        const { width, height } = (await proxy.getPage(i)).getViewport({ scale: 1 })
        sizes.push({ width, height })
      }
      if (cancelled) return
      setDoc({ proxy, sizes })
      onPageCount(proxy.numPages)
    })().catch(() => !cancelled && onError())
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [file.id, onPageCount, onError])

  // Redrawn only once the panel stops being dragged; meanwhile the canvas just stretches.
  useEffect(() => {
    const el = pagesRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(([entry]) => {
      clearTimeout(timer)
      timer = setTimeout(() => setWidth(entry.contentRect.width), width === 0 ? 0 : 150)
    })
    observer.observe(el)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [doc, width])

  return (
    <div
      ref={scrollRef}
      className="file-preview-scroll"
      onScroll={(e) => pagesRef.current && onPage(currentPage(e.currentTarget, pagesRef.current.children))}
    >
      {doc && (
        <div ref={pagesRef} className="pdf-pages">
          {doc.sizes.map((size, i) => (
            <PdfPage key={i} doc={doc.proxy} pageNumber={i + 1} size={size} width={width} root={scrollRef.current!} />
          ))}
        </div>
      )}
    </div>
  )
}

const PptxViewer: React.FC<ViewerProps> = ({ file, onPage, onPageCount, onError }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    let viewer: { destroy: () => void } | null = null
    void (async () => {
      // Loaded on first use: the renderer and the charts it bundles are a few MB.
      const [{ PptxViewer, RECOMMENDED_ZIP_LIMITS }, data] = await Promise.all([
        import('@aiden0z/pptx-renderer'),
        loadFile(file.id).then(withUnicodeSymbols)
      ])
      const opened = await PptxViewer.open(data, containerRef.current!, {
        zipLimits: RECOMMENDED_ZIP_LIMITS,
        lazySlides: true,
        lazyMedia: true,
        listOptions: { windowed: true },
        scrollContainer: scrollRef.current!,
        // SmartArt is often stored as an EMF picture holding a PDF, which needs pdf.js to draw.
        pdfjs: { moduleUrl: pdfModuleUrl, workerUrl: pdfWorkerUrl },
        signal: abort.signal
      })
      if (abort.signal.aborted) return opened.destroy()
      viewer = opened
      onPageCount(opened.slideCount)
    })().catch(() => !abort.signal.aborted && onError())
    return () => {
      abort.abort()
      viewer?.destroy()
    }
  }, [file.id, onPageCount, onError])

  return (
    <div
      ref={scrollRef}
      className="file-preview-scroll"
      onScroll={(e) => containerRef.current && onPage(currentPage(e.currentTarget, containerRef.current.children))}
    >
      <div ref={containerRef} className="pptx-slides" />
    </div>
  )
}

const DocxViewer: React.FC<ViewerProps> = ({ file, onError }) => {
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [{ renderAsync }, data] = await Promise.all([import('docx-preview'), loadFile(file.id)])
      if (cancelled) return
      // One flowing column: the panel is far narrower than an A4 page.
      await renderAsync(data, bodyRef.current!, undefined, {
        inWrapper: false,
        ignoreWidth: true,
        ignoreHeight: true,
        breakPages: false,
        ignoreLastRenderedPageBreak: true
      })
    })().catch(() => !cancelled && onError())
    return () => {
      cancelled = true
    }
  }, [file.id, onError])

  return (
    <div className="file-preview-scroll">
      <div ref={bodyRef} className="docx-page" />
    </div>
  )
}

const TextViewer: React.FC<ViewerProps> = ({ file, onError }) => {
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadFile(file.id)
      .then((data) => !cancelled && setText(new TextDecoder().decode(data)))
      .catch(() => !cancelled && onError())
    return () => {
      cancelled = true
    }
  }, [file.id, onError])

  return (
    <div className="file-preview-scroll">
      <pre className="file-preview-text">{text}</pre>
    </div>
  )
}

const ImageViewer: React.FC<ViewerProps> = ({ file, onError }) => {
  const [zoomed, setZoomed] = useState(false)
  const frameRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    const frame = frameRef.current
    const img = imgRef.current
    if (!frame || !img) return

    // Cover the pane on both axes and keep the ratio. The longer side scrolls.
    const fit = (): void => {
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) return
      const width = frame.clientWidth
      const height = frame.clientHeight
      if (width === 0 || height === 0) return
      const scaleW = width / img.naturalWidth
      const scaleH = height / img.naturalHeight
      if (scaleH >= scaleW) {
        img.style.height = `${height}px`
        img.style.width = `${height * (img.naturalWidth / img.naturalHeight)}px`
      } else {
        img.style.width = `${width}px`
        img.style.height = `${width * (img.naturalHeight / img.naturalWidth)}px`
      }
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(frame)
    img.addEventListener('load', fit)
    return () => {
      observer.disconnect()
      img.removeEventListener('load', fit)
    }
  }, [file.id])

  return (
    <div className="file-preview-scroll file-preview-image-frame" ref={frameRef}>
      <img
        ref={imgRef}
        className="file-preview-image"
        src={fileUrl(file.id)}
        alt={file.name}
        onClick={() => setZoomed(true)}
        onError={onError}
      />
      {zoomed && <Lightbox file={file} onClose={() => setZoomed(false)} />}
    </div>
  )
}

const VIEWERS = { pdf: PdfViewer, pptx: PptxViewer, docx: DocxViewer, text: TextViewer, image: ImageViewer }

const FilePreview: React.FC<{ file: FileRecord; listCount: number; onBack: () => void }> = ({
  file,
  listCount,
  onBack
}) => {
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const onError = useMemo(() => () => setFailed(true), [])
  // A file synced from another device is downloaded first; null while that's going on.
  const [here, setHere] = useState<{ ok: true } | { ok: false; reason: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setHere(null)
    setFailed(false)
    window.api
      .invoke('files:ensure', file.id)
      .then(() => !cancelled && setHere({ ok: true }))
      .catch((err) => !cancelled && setHere({ ok: false, reason: errorText(err) }))
    return () => {
      cancelled = true
    }
  }, [file.id])
  const Viewer = VIEWERS[fileKind(file.mime)]

  const openExternally = (): void => void window.api.invoke('files:open', file.id)

  return (
    <div className="file-tab-container">
      <div className="thread-sub-bar">
        <button type="button" className="thread-list-switch-btn" onClick={onBack}>
          ‹ 全部附件 ({listCount})
        </button>
        <span className="file-preview-name" title={file.name}>
          {file.name}
        </span>
        {pageCount !== null && !failed && here?.ok && (
          <span className="file-preview-page">
            第 {page} / {pageCount} 页
          </span>
        )}
        <button type="button" className="thread-list-switch-btn" onClick={openExternally}>
          用系统应用打开
        </button>
      </div>
      {here === null ? (
        <div className="file-preview-failed">
          <span>正在下载…</span>
        </div>
      ) : !here.ok ? (
        <div className="file-preview-failed">
          <span>{here.reason}</span>
        </div>
      ) : failed ? (
        <div className="file-preview-failed">
          <span>这个文件没法预览</span>
          <button type="button" className="thread-list-switch-btn" onClick={openExternally}>
            用系统应用打开
          </button>
        </div>
      ) : (
        <Viewer file={file} onPage={setPage} onPageCount={setPageCount} onError={onError} />
      )}
    </div>
  )
}

export const FileTab: React.FC = () => {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const sessions = useAppStore((s) => s.sessions)
  const messages = useAppStore(useShallow((s) => s.messages.filter((m) => m.attachments.some((a) => a.type === 'file'))))
  const files = useAppStore((s) => s.files)
  const openFilePreview = useAppStore((s) => s.openFilePreview)

  const listed = useMemo(() => {
    const inConversation = conversationIds(sessions, (s) => s.id === activeSessionId)
    const ids = sentFileIds(messages.filter((m) => inConversation.has(m.sessionId)))
    return ids.flatMap((id) => files.filter((f) => f.id === id))
  }, [activeSessionId, sessions, messages, files])

  // A file still in the input box isn't listed yet, but can be previewed.
  const file = files.find((f) => f.id === activeFileId)
  if (file) {
    return <FilePreview key={file.id} file={file} listCount={listed.length} onBack={() => openFilePreview(null)} />
  }

  return (
    <div className="file-tab-container">
      <div className="thread-list-view">
        <div className="thread-list-label">本会话的附件 ({listed.length})</div>
        {listed.length === 0 && <div className="thread-list-empty">在对话里发过的图片、PDF、PPT 等文件会列在这里。</div>}
        <div className="file-tab-list">
          {listed.map((f) => (
            <FileCard key={f.id} file={f} />
          ))}
        </div>
      </div>
    </div>
  )
}
