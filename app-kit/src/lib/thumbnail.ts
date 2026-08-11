/**
 * Client-side image renditions for the chat bubble. Downscale a File via <canvas> to two WebP
 * blobs — a small inline thumbnail + a larger lightbox image. Doing it in the browser keeps the
 * resize off the (CPU-limited) Worker and needs no paid image service. Both renditions stay well
 * under ~250KB for screenshots — the band where reading a BLOB from D1/SQLite beats the
 * filesystem (see migrations/0003) — so they live in D1. WebP is ~30% smaller than JPEG and is
 * supported by all current browsers. Non-image files return null (rendered as a filename chip).
 */
export interface Renditions {
  thumb: Blob
  large: Blob
}

const THUMB_EDGE = 512 // inline bubble
const LARGE_EDGE = 2048 // lightbox; for typical screenshots this ≈ the original
const LARGE_MAX_BYTES = 256 * 1024 // keep `large` inside the D1 sweet spot

export async function makeRenditions(file: File): Promise<Renditions | null> {
  if (!file.type.startsWith('image/')) return null
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('image decode failed'))
      el.src = url
    })
    // Independent canvases → encode both renditions concurrently (this is on the Send-gated path).
    const [thumb, large] = await Promise.all([
      render(img, THUMB_EDGE, 0.8, Infinity),
      render(img, LARGE_EDGE, 0.82, LARGE_MAX_BYTES),
    ])
    return { thumb, large }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Draw `img` downscaled to fit `maxEdge`, encode WebP, and step quality down until ≤ maxBytes. */
async function render(img: HTMLImageElement, maxEdge: number, quality: number, maxBytes: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(img, 0, 0, w, h)

  let q = quality
  let blob = await toWebp(canvas, q)
  while (blob.size > maxBytes && q > 0.4) {
    q -= 0.12
    blob = await toWebp(canvas, q)
  }
  return blob
}

function toWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/webp', quality)
  })
}
