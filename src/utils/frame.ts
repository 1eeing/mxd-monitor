import type { CropRegion } from '../types'

/** 复用的离屏 canvas，避免每帧创建 */
const canvas: HTMLCanvasElement = document.createElement('canvas')
const ctx = canvas.getContext('2d', { willReadFrequently: true })

/**
 * 从 video 当前帧截取 ImageData。
 * 未启用裁剪时裁剪整帧；启用时按 crop（0~1 比例）截取对应区域。
 * video 无画面时返回 null。
 */
export function captureFrame(
  video: HTMLVideoElement,
  crop: CropRegion,
  scale = 1,
): ImageData | null {
  if (!ctx) return null
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const useCrop = crop.enabled && crop.width > 0 && crop.height > 0
  const sx = useCrop ? clamp(crop.left, 0, 1 - crop.width) * vw : 0
  const sy = useCrop ? clamp(crop.top, 0, 1 - crop.height) * vh : 0
  const sw = useCrop ? crop.width * vw : vw
  const sh = useCrop ? crop.height * vh : vh

  // scale 用于可选降采样，默认 1（原尺寸）
  const outW = Math.max(1, Math.round(sw * scale))
  const outH = Math.max(1, Math.round(sh * scale))

  if (canvas.width !== outW) canvas.width = outW
  if (canvas.height !== outH) canvas.height = outH

  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH)
  return ctx.getImageData(0, 0, outW, outH)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}