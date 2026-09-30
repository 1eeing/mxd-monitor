import { useCallback, useEffect, useRef, useState } from 'react'

export interface ScreenCapture {
  videoRef: React.RefObject<HTMLVideoElement | null>
  isCapturing: boolean
  /** 与 isCapturing 同步的 ref，可在回调/异步流程里读取实时值（state 是渲染时快照，有滞后） */
  capturingRef: React.MutableRefObject<boolean>
  /**
   * 原始采集流。局域网镜像要把这条视频轨直接 addTrack 给手机，
   * 但 useMonitor 只把它喂给 <video> 和 OCR，不对外暴露。
   */
  streamRef: React.MutableRefObject<MediaStream | null>
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
    // getDisplayMedia 只在 secure context 里存在。局域网 http://192.168.x.x 不是
    // secure context，此时 navigator.mediaDevices 整个是 undefined，直接调用会抛
    // 「Cannot read properties of undefined」，用户完全看不懂。这里提前拦下来并说明原因。
    if (!navigator.mediaDevices?.getDisplayMedia) {
      const hint = window.isSecureContext
        ? '当前浏览器不支持屏幕共享，请换用 Chrome / Edge'
        : '当前页面不是安全上下文，浏览器禁用了屏幕采集。请通过 HTTPS 打开本页面（localhost 例外）'
      setError(hint)
      throw new Error(hint)
    }
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
      // 重新抛出，让调用方（useMonitor）区分「用户取消选择」与真正的启动失败
      throw err
    }
  }, [setCapturing, stop, handleStreamEnded])

  return { videoRef, isCapturing, capturingRef, streamRef, error, start, stop }
}