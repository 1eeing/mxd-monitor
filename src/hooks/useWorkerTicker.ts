import { useEffect, useRef } from 'react'

export type TickerMode = 'worker' | 'fallback'

/**
 * 用 Worker 里的定时器驱动识别循环，绕开 Chrome 对隐藏页面主线程的定时器降频
 * （后台 5 分钟后 setInterval 被压到约每分钟一次，会整段错过几秒内出现的弹窗）。
 *
 * Worker 不可用时退回主线程 setInterval：仍会被降频，但不至于完全停摆。
 * 退回只发生一次，通过 onMode 回调上报，不做成 state（避免在 effect 里同步 setState）。
 */
export function useWorkerTicker(
  active: boolean,
  intervalMs: number,
  onTick: () => void,
  onMode?: (mode: TickerMode) => void,
): void {
  const onTickRef = useRef(onTick)
  const onModeRef = useRef(onMode)

  useEffect(() => {
    onTickRef.current = onTick
    onModeRef.current = onMode
  })

  useEffect(() => {
    if (!active) return
    const clamped = Math.max(300, intervalMs)
    let worker: Worker | null = null
    let fallbackTimer: number | null = null

    try {
      worker = new Worker(new URL('../workers/ticker.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.onmessage = (e: MessageEvent) => {
        if ((e.data as { type?: string } | null)?.type === 'tick') onTickRef.current()
      }
      worker.postMessage({ type: 'start', intervalMs: clamped })
      onModeRef.current?.('worker')
    } catch {
      worker = null
    }

    if (!worker) {
      fallbackTimer = window.setInterval(() => onTickRef.current(), clamped)
      onModeRef.current?.('fallback')
    }

    return () => {
      if (worker) {
        worker.postMessage({ type: 'stop' })
        worker.terminate()
      }
      if (fallbackTimer !== null) window.clearInterval(fallbackTimer)
    }
  }, [active, intervalMs])
}
