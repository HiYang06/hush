// Draws chosen slides as page images for the model (D-077), with the same renderer the preview uses
// (D-056). The renderer builds HTML/SVG, not a canvas, so html-to-image rasterizes the result.
import pdfModuleUrl from 'pdfjs-dist/build/pdf.min.mjs?url'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { charCount, IMAGE_MAX_EDGE } from '@shared/files'
import { encode, type Encoded } from './media'

// Charts are ECharts on a canvas, whose entry animation runs about a second.
const CHART_ANIMATION_MS = 1_200

// A drawing showing less than this share of the slide's text lost part of the slide.
const COMPLETE_TEXT_SHARE = 0.5

// complete: false when the renderer left out much of the text. It does that for formulas beyond what it
// can draw, where PowerPoint's own picture of the text box is all that's left (D-077).
export type RenderedSlide = { image: Encoded; complete: boolean }

// The given slides (zip path → characters of text the slide shows), keyed by path. A slide that fails
// to draw is missing from the result; the caller falls back to its embedded pictures.
export async function renderSlides(data: ArrayBuffer, slides: Map<string, number>): Promise<Map<string, RenderedSlide>> {
  const rendered = new Map<string, RenderedSlide>()
  if (slides.size === 0) return rendered
  // Loaded on first use, like the preview: the renderer and its chart library are a few MB.
  const [{ parseZip, buildPresentation, renderSlide, RECOMMENDED_ZIP_LIMITS }, { toCanvas }] = await Promise.all([
    import('@aiden0z/pptx-renderer'),
    import('html-to-image')
  ])
  const presentation = buildPresentation(await parseZip(data, RECOMMENDED_ZIP_LIMITS))
  const scale = IMAGE_MAX_EDGE / Math.max(presentation.width, presentation.height)
  // Off screen but in the document, so styles are computed and images load.
  const host = document.createElement('div')
  host.style.cssText = 'position: fixed; left: -100000px; top: 0; pointer-events: none'
  document.body.appendChild(host)
  const mediaUrlCache = new Map<string, string>()
  try {
    for (const slide of presentation.slides) {
      const expectedChars = slides.get(slide.slidePath)
      if (expectedChars === undefined) continue
      const handle = renderSlide(presentation, slide, {
        mediaUrlCache,
        pdfjs: { moduleUrl: pdfModuleUrl, workerUrl: pdfWorkerUrl }
      })
      host.appendChild(handle.element)
      try {
        await handle.ready
        if (handle.element.querySelector('canvas')) await new Promise((r) => setTimeout(r, CHART_ANIMATION_MS))
        const canvas = await toCanvas(handle.element, {
          width: presentation.width,
          height: presentation.height,
          pixelRatio: scale,
          backgroundColor: '#ffffff',
          // The slide's fonts come from the system; embedding the app's own web fonts takes seconds a slide.
          skipFonts: true
        })
        const shownChars = charCount(handle.element.textContent ?? '')
        rendered.set(slide.slidePath, {
          image: await encode(canvas, 'image/jpeg'),
          complete: shownChars >= expectedChars * COMPLETE_TEXT_SHARE
        })
      } catch (err) {
        console.warn(`Slide ${slide.slidePath} could not be drawn; using its pictures instead`, err)
      } finally {
        handle.dispose()
        handle.element.remove()
      }
    }
  } finally {
    for (const url of mediaUrlCache.values()) URL.revokeObjectURL(url)
    host.remove()
  }
  return rendered
}
