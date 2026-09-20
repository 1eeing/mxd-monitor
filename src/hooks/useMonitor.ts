import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  LogEntry,
  MatchedKeyword,
  MonitorStatus,
} from '../types'
import { ALARM_GRACE_FRAMES, DEFAULT_ALARM_AUDIO, MAX_LOG_ENTRIES } from '../config'
import { alarmPlayer } from '../audio/player'
import { detectImageData, initOcr } from '../ocr/engine'
import { captureFrame } from '../utils/frame'
import { findKeywordMatches } from '../utils/match'
import { getFile } from '../utils/blobStore'
import { useScreenCapture } from './useScreenCapture'

let logSeq = 0

export interface UseMonitor {
  status: MonitorStatus
  error: string | null
  logs: LogEntry[]
  hits: MatchedKeyword[]
  alarmActive: boolean
  engineInfo: string
  /** 最近一次识别出的文字（调试用，含置信度） */
  lastOcr: string
  isCapturing: boolean
  screenError: string | null
  videoRef: React.RefObject<HTMLVideoElement | null>
  start: () => Promise<void>
  stop: () => void
  manuallyStopAlarm: () => void
  /** 根据当前设置重新加载报警音频（设置变化时调用） */
  refreshAlarmSource: () => Promise<void>
}

export function useMonitor(settings: AppSettings): UseMonitor {
  const screen = useScreenCapture()
  const { videoRef } = screen
  const settingsRef = useRef(settings)

  const [status, setStatus] = useState<MonitorStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [hits, setHits] = useState<MatchedKeyword[]>([])
  const [alarmActive, setAlarmActive] = useState(false)
  const [engineInfo, setEngineInfo] = useState('')
  const [lastOcr, setLastOcr] = useState('')

  const busyRef = useRef(false)
  const missStreakRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const addLog = useCallback((kind: LogEntry['kind'], message: string) => {
    setLogs((prev) => {
      const entry: LogEntry = {
        id: `log-${Date.now()}-${logSeq++}`,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        kind,
        message,
      }
      const next = [...prev, entry]
      return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next
    })
  }, [])

  /** 把报警音源设为自定义音频或默认鸡叫 */
  const applyAlarmSource = useCallback(async () => {
    const s = settingsRef.current
    if (s.useCustomAudio && s.customAudioName) {
      const blob = await getFile(s.customAudioName)
      if (blob) {
        alarmPlayer.setSource(URL.createObjectURL(blob))
        return
      }
    }
    alarmPlayer.setSource(DEFAULT_ALARM_AUDIO)
  }, [])

  const tick = useCallback(async () => {
    if (busyRef.current) return
    const s = settingsRef.current
    const video = videoRef.current
    if (!video) return
    const frame = captureFrame(video, s.crop, s.crop.scale ?? 1)
    if (!frame) return

    busyRef.current = true
    try {
      const result = await detectImageData(frame)
      const matched = findKeywordMatches(
        result.lines.map((line) => ({ text: line.text, score: line.score })),
        s.keywords,
      )
      setHits(matched)
      // 调试信息：展示 OCR 实际读出的文字与置信度，帮助排查“为什么没命中”
      setLastOcr(
        result.lines
          .map((line) =>
            line.score > 0 ? `${line.text} ${Math.round(line.score * 100)}%` : line.text,
          )
          .join(' | ') || '（未识别到文字）',
      )

      if (matched.length > 0) {
        missStreakRef.current = 0
        if (!alarmPlayer.alarmOn) {
          const labels = matched.map((m) => m.rule.label).join('、')
          addLog('hit', `命中【${labels}】 ${matched[0]?.snippet ?? ''}`)
        }
        alarmPlayer.start()
        setAlarmActive(true)
      } else {
        missStreakRef.current += 1
        if (alarmPlayer.alarmOn && missStreakRef.current >= ALARM_GRACE_FRAMES) {
          alarmPlayer.stop()
          setAlarmActive(false)
          addLog('stop', '未再识别到关键字，已停止报警')
        }
      }
    } catch (err) {
      addLog('error', `识别失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busyRef.current = false
    }
  }, [addLog, videoRef])

  const start = useCallback(async () => {
    setError(null)
    setLogs([])
    setHits([])
    setLastOcr('')
    setStatus('initializing')
    addLog('info', '弹出窗口选择器，请选择冒险岛游戏窗口…')
    try {
      await screen.start()
      const s = settingsRef.current
      addLog(
        'info',
        `初始化 OCR 引擎（${s.backend === 'webgpu' ? 'WebGPU GPU 加速' : 'WASM CPU 回退'}）…`,
      )
      const info = await initOcr(s.backend)
      setEngineInfo(`${info.provider.toUpperCase()} · ${Math.round(info.elapsedMs)}ms`)
      await applyAlarmSource()
      addLog(
        'info',
        `OCR 就绪（${info.provider}，加载耗时 ${Math.round(info.elapsedMs)}ms），开始循环识别（间隔 ${settingsRef.current.ocrIntervalMs}ms）`,
      )
      setStatus('running')
    } catch (err) {
      screen.stop()
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setStatus('error')
      addLog('error', msg)
    }
  }, [addLog, applyAlarmSource, screen])

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    alarmPlayer.stop()
    setAlarmActive(false)
    busyRef.current = false
    missStreakRef.current = 0
    screen.stop()
    setStatus('idle')
    addLog('info', '已停止监控')
  }, [addLog, screen])

  const manuallyStopAlarm = useCallback(() => {
    alarmPlayer.stop()
    setAlarmActive(false)
    addLog('info', '手动停止报警')
  }, [addLog])

  // 运行期间管理循环定时器（间隔变化时重建）
  useEffect(() => {
    if (status !== 'running') return
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    timerRef.current = window.setInterval(tick, Math.max(300, settings.ocrIntervalMs))
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [status, settings.ocrIntervalMs, tick])

  // 组件卸载时清理
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      alarmPlayer.stop()
    },
    [],
  )

  return {
    status,
    error,
    logs,
    hits,
    alarmActive,
    engineInfo,
    lastOcr,
    isCapturing: screen.isCapturing,
    screenError: screen.error,
    videoRef,
    start,
    stop,
    manuallyStopAlarm,
    refreshAlarmSource: applyAlarmSource,
  }
}