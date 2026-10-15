import * as THREE from 'three'

export interface LabelStyle {
  width?: number
  height?: number
  background?: string
  color?: string
  accent?: string
  align?: CanvasTextAlign
  /** First line is drawn larger. */
  headline?: boolean
}

const cache = new Map<string, THREE.CanvasTexture>()

/** Render text lines into a cached CanvasTexture (sticker-style label). */
export function labelTexture(lines: string[], style: LabelStyle = {}): THREE.CanvasTexture {
  const { width = 512, height = 256, background = '#f2f2ee', color = '#15181c', accent, align = 'left', headline = true } =
    style
  const key = JSON.stringify([lines, width, height, background, color, accent, align, headline])
  const hit = cache.get(key)
  if (hit) return hit

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)
  if (accent) {
    ctx.fillStyle = accent
    ctx.fillRect(0, 0, width, height * 0.06)
  }

  const pad = width * 0.06
  const rows = Math.max(lines.length, 1)
  const base = Math.min(height / (rows + (headline ? 1.2 : 0.6)), width / 14)
  let y = pad + (accent ? height * 0.06 : 0)
  ctx.textAlign = align
  ctx.textBaseline = 'top'
  const x = align === 'center' ? width / 2 : align === 'right' ? width - pad : pad
  lines.forEach((line, i) => {
    const size = headline && i === 0 ? base * 1.35 : base
    ctx.font = `${headline && i === 0 ? 600 : 500} ${size}px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif`
    ctx.fillStyle = color
    ctx.globalAlpha = headline && i > 0 ? 0.78 : 1
    ctx.fillText(line, x, y, width - pad * 2)
    y += size * 1.25
  })
  ctx.globalAlpha = 1

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  cache.set(key, tex)
  return tex
}
