import { useCallback, useEffect, useRef, useState } from 'react'

export interface ScreenCapture {
  videoRef: React.RefObject<HTMLVideoElement | null>
  isCapturing: boolean
  /** 与 isCapturing 同步的 ref，可在回调/异步流程里读取实时值（state 是渲染时快照，有滞后） */
  capturingRef: React.MutableRefObject<boolean>
  error: string | null
  /** 拉起系统级屏幕/窗口选择器，用户选定冒险岛窗口后开始采集 */
  start: () => Promise<void>
  stop: () => void
}

export function useScreenCapture(onStreamEnded?: () => void): ScreenCapture {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const stopRef = useRef<() => void>(() => {})
  const [isCapturing, setIsCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const capturingRef = useRef(false)

  const setCapturing = useCallback((active: boolean) => {
    capturingRef.current = active
    setIsCapturing(active)
  }, [])

  // 用 ref 保存外部回调，避免每次渲染都重建 stop/handleEnded
  const onStreamEndedRef = useRef(onStreamEnded)
  useEffect(() => {
    onStreamEndedRef.current = onStreamEnded
  }, [onStreamEnded])

  const stop = useCallback(() => {
    stopRef.current()
    setCapturing(false)
  }, [setCapturing])

  const handleStreamEnded = useCallback(() => {
    stop()
    onStreamEndedRef.current?.()
  }, [stop])

  const start = useCallback(async () => {
    setError(null)
    // 重新开始前先释放上一次的 stream，避免 track 泄漏（麦克风/共享会持续绿点与内存占用）
    stop()
    try {
      // displaySurface: 'window' 让选择器优先展示窗口（用户仍可切换标签页/屏幕）
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'window', frameRate: 30 },
        audio: false,
      })
      streamRef.current = stream
      const track = stream.getVideoTracks()[0]
      stopRef.current = () => {
        track?.removeEventListener('ended', handleStreamEnded)
        stream.getTracks().forEach((track_) => track_.stop())
        streamRef.current = null
        if (videoRef.current) videoRef.current.srcObject = null
      }
      track?.addEventListener('ended', handleStreamEnded)
      const el = videoRef.current
      if (el) {
        el.srcObject = stream
        void el.play().catch(() => {
          /* 静音播放失败可忽略 */
        })
      }
      setCapturing(true)
    } catch (err) {
      stop()
      setError(err instanceof Error ? err.message : String(err))
      setCapturing(false)
    }
  }, [setCapturing, stop, handleStreamEnded])

  return { videoRef, isCapturing, capturingRef, error, start, stop }
}