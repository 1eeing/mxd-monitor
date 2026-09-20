import { useCallback, useRef, useState } from 'react'

export interface ScreenCapture {
  videoRef: React.RefObject<HTMLVideoElement | null>
  isCapturing: boolean
  error: string | null
  /** 拉起系统级屏幕/窗口选择器，用户选定冒险岛窗口后开始采集 */
  start: () => Promise<void>
  stop: () => void
}

export function useScreenCapture(): ScreenCapture {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [isCapturing, setIsCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setIsCapturing(false)
  }, [])

  const start = useCallback(async () => {
    setError(null)
    try {
      // displaySurface: 'window' 让选择器优先展示窗口（用户仍可切换标签页/屏幕）
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'window', frameRate: 30 },
        audio: false,
      })
      streamRef.current = stream
      stream.getVideoTracks()[0]?.addEventListener('ended', stop)
      const el = videoRef.current
      if (el) {
        el.srcObject = stream
        void el.play().catch(() => {
          /* 静音播放失败可忽略 */
        })
      }
      setIsCapturing(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsCapturing(false)
    }
  }, [stop])

  return { videoRef, isCapturing, error, start, stop }
}