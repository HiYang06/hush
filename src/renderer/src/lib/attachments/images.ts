import { IMAGE_MAX_EDGE } from '@shared/files'

export type Encoded = { mime: string; data: Uint8Array<ArrayBuffer> }

function canvasBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encoding failed'))), mime, 0.85)
  )
}

export async function encode(canvas: HTMLCanvasElement, mime: string): Promise<Encoded> {
  return { mime, data: new Uint8Array(await (await canvasBlob(canvas, mime)).arrayBuffer()) }
}

// null when the image is small enough to send as is.
export async function downscale(data: Uint8Array<ArrayBuffer>, mime: string): Promise<Encoded | null> {
  const bitmap = await createImageBitmap(new Blob([data], { type: mime }))
  const scale = IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height)
  if (scale >= 1) {
    bitmap.close()
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  // PNG and GIF may be transparent, which JPEG would turn black.
  return encode(canvas, mime === 'image/jpeg' ? 'image/jpeg' : 'image/png')
}

