import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  LogEntry,
  MatchedKeyword,
  MonitorStatus,
} from '../types'
import { ALARM_GRACE_FRAMES, CUSTOM_ALARM_AUDIO_KEY, DEFAULT_ALARM_AUDIO, MAX_LOG_ENTRIES } from '../config'
import { alarmPlayer } from '../audio/player'
import { detectImageData, initOcr } from '../ocr/engine'
import { captureFrame } from '../utils/frame'
import { findKeywordMatches } from '../utils/match'
import { getFile } from '../utils/blobStore'
import { useScreenCapture } from './useScreenCapture'

let logSeq = 0

/** 采样帧亮度（0~255），用于黑屏检测 */
function frameBrightness(data: Uint8ClampedArray): number {
  if (data.length === 0) return 0
  let sum = 0
  let n = 0
  // 每隔若干像素采样一次，足够判断是否接近全黑
  for (let i = 0; i < data.length; i += 4 * 32) {
    sum += data[i] + data[i + 1] + data[i + 2]
    n += 3
  }
  return sum / n
}

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
  /** 初始化阶段的资源加载进度 0~100；非初始化状态为 null */
  loadProgress: number | null
  videoRef: React.RefObject<HTMLVideoElement | null>
  start: () => Promise<void>
  stop: () => void
  manuallyStopAlarm: () => void
  /** 根据当前设置重新加载报警音频（设置变化时调用） */
  refreshAlarmSource: () => Promise<void>
}

export function useMonitor(settings: AppSettings): UseMonitor {
  const [status, setStatus] = useState<MonitorStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [hits, setHits] = useState<MatchedKeyword[]>([])
  const [alarmActive, setAlarmActive] = useState(false)
  const [engineInfo, setEngineInfo] = useState('')
  const [lastOcr, setLastOcr] = useState('')
  const [loadProgress, setLoadProgress] = useState<number | null>(null)
  const settingsRef = useRef(settings)
  // 供稳定的回调读取最新 status
  const statusRef = useRef(status)

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  const busyRef = useRef(false)
  const missStreakRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  /** 报警是否正在响（与 alarmActive state 保持同步；停止判定以它为准，不受报警播放器内部状态影响） */
  const alarmActiveRef = useRef(false)

  /** 黑屏检测：连续若干帧接近全黑时提示（常见原因是游戏独占全屏导致采集不到画面） */
  const blackFramesRef = useRef(0)
  const blackWarnedRef = useRef(false)

  const setAlarm = useCallback((active: boolean) => {
    alarmActiveRef.current = active
    setAlarmActive(active)
  }, [])

  /** 手动停止报警后的锁存：直到连续 GRACE 帧无命中才解除，防止下一帧命中就自动重启 */
  const alarmSuppressedRef = useRef(false)

  /** 屏幕共享是否正由我们自己主动停止（避免 track ended 回调误判成用户中途关闭共享） */
  const screenSelfStopRef = useRef(false)

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

  // 屏幕共享被浏览器/系统主动结束（track ended）而非点击「停止监控」时，
  // 视为监控意外中断：停止报警、清理定时器、回到 idle
  const handleStreamEnded = useCallback(() => {
    if (screenSelfStopRef.current) return
    if (statusRef.current !== 'running') return
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    alarmPlayer.stop()
    setAlarm(false)
    setHits([])
    setLastOcr('')
    missStreakRef.current = 0
    alarmSuppressedRef.current = false
    setStatus('idle')
    setLoadProgress(null)
    addLog('info', '屏幕共享已结束，监控已停止')
  }, [addLog, setAlarm])

  const screen = useScreenCapture(handleStreamEnded)
  const { videoRef } = screen
  // 稳定的停止函数引用：卸载清理 effect 用它，避免把 screen 对象放进 deps
  //（screen 每次渲染都是新对象，放进去会让清理 effect 每次渲染都跑并误停共享）
  const screenStopRef = useRef(screen.stop)
  useEffect(() => {
    screenStopRef.current = screen.stop
  })

  /** 把报警音源设为自定义音频或默认鸡叫 */
  const applyAlarmSource = useCallback(async () => {
    const s = settingsRef.current
    if (s.useCustomAudio && s.customAudioName) {
      const blob = await getFile(CUSTOM_ALARM_AUDIO_KEY)
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
    // 无画面（共享未就绪 / 已结束 / 视频手势）视为一次「未命中」，
    // 让 miss 连击正常累计，报警仍能按容错帧数自动停止
    if (!frame) {
      missStreakRef.current += 1
      if (missStreakRef.current >= ALARM_GRACE_FRAMES) {
        alarmSuppressedRef.current = false
        if (alarmActiveRef.current) {
          alarmPlayer.stop()
          setAlarm(false)
          addLog('stop', '画面无内容，已停止报警')
        }
      }
      return
    }

    busyRef.current = true
    try {
      // 黑屏检测：连续 8 帧（默认间隔约 12s）接近全黑才提示一次，避免误报
      const bright = frameBrightness(frame.data)
      if (bright < 8) {
        blackFramesRef.current += 1
        if (blackFramesRef.current >= 8 && !blackWarnedRef.current) {
          blackWarnedRef.current = true
          addLog(
            'info',
            '⚠ 画面几乎全黑：如果选的是游戏窗口，多半是「独占全屏」让浏览器采集不到内容。请把游戏切成窗口化/无边框窗口再试。',
          )
        }
      } else {
        blackFramesRef.current = 0
        blackWarnedRef.current = false
      }
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
        // 手动停止报警后锁存：条件未解除前不自动重启
        if (alarmSuppressedRef.current) {
          return
        }
        if (!alarmPlayer.alarmOn) {
          const labels = matched.map((m) => m.rule.label).join('、')
          addLog('hit', `命中【${labels}】 ${matched[0]?.snippet ?? ''}`)
        }
        alarmPlayer.start()
        setAlarm(true)
      } else {
        missStreakRef.current += 1
        // 连续 N 帧未命中：停止报警并解除手动锁存（报警条件已解除，允许下次再报）
        if (missStreakRef.current >= ALARM_GRACE_FRAMES) {
          alarmSuppressedRef.current = false
          if (alarmActiveRef.current) {
            alarmPlayer.stop()
            setAlarm(false)
            addLog('stop', '未再识别到关键字，已停止报警')
          }
        }
      }
    } catch (err) {
      // 识别失败同样计入 miss 连击，避免异常把报警卡在「响个不停」状态
      missStreakRef.current += 1
      if (missStreakRef.current >= ALARM_GRACE_FRAMES) {
        alarmSuppressedRef.current = false
        if (alarmActiveRef.current) {
          alarmPlayer.stop()
          setAlarm(false)
        }
      }
      addLog('error', `识别失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busyRef.current = false
    }
  }, [addLog, setAlarm, videoRef])

  const start = useCallback(async () => {
    setError(null)
    setLogs([])
    setHits([])
    setLastOcr('')
    setStatus('initializing')
    setLoadProgress(0)
    addLog('info', '弹出窗口选择器，请选择冒险岛游戏窗口…')
    screenSelfStopRef.current = false
    alarmSuppressedRef.current = false
    missStreakRef.current = 0
    blackFramesRef.current = 0
    blackWarnedRef.current = false
    try {
      await screen.start()
      const s = settingsRef.current
      addLog(
        'info',
        `初始化 OCR 引擎（${s.backend === 'webgpu' ? 'WebGPU GPU 加速' : 'WASM CPU 回退'}）…`,
      )
      const info = await initOcr(s.backend, setLoadProgress)
      setLoadProgress(100)
      setEngineInfo(`${info.provider.toUpperCase()} · ${Math.round(info.elapsedMs)}ms`)
      await applyAlarmSource()
      // 防御：选完窗口后若共享在初始化期间就已经中断（例如选中了无法采集的独占全屏窗口），
      // 不要继续进入 running 假状态
      if (!screen.capturingRef.current) {
        throw new Error('屏幕共享未生效：选中的窗口无法被采集（多为独占全屏模式）。请将游戏切到窗口化/无边框窗口后重试')
      }
      addLog(
        'info',
        `OCR 就绪（${info.provider}，加载耗时 ${Math.round(info.elapsedMs)}ms），开始循环识别（间隔 ${settingsRef.current.ocrIntervalMs}ms）`,
      )
      setStatus('running')
    } catch (err) {
      screen.stop()
      setLoadProgress(null)
      const msg = err instanceof Error ? err.message : String(err)
      // 用户在窗口选择器里点了取消/关闭：不算失败，安静地回到「未选择」状态
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        setStatus('idle')
        addLog('info', '已取消选择，未开始监控')
        return
      }
      setError(msg)
      setStatus('error')
      addLog('error', msg)
    }
  }, [addLog, applyAlarmSource, screen])

  const stop = useCallback(() => {
    screenSelfStopRef.current = true
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    alarmPlayer.stop()
    setAlarm(false)
    busyRef.current = false
    missStreakRef.current = 0
    alarmSuppressedRef.current = false
    screen.stop()
    setStatus('idle')
    setLoadProgress(null)
    addLog('info', '已停止监控')
  }, [addLog, screen, setAlarm])

  const manuallyStopAlarm = useCallback(() => {
    alarmPlayer.stop()
    setAlarm(false)
    alarmSuppressedRef.current = true
    missStreakRef.current = 0
    addLog('info', '手动停止报警（关键字条件解除前不再自动报警）')
  }, [addLog, setAlarm])

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

  // 组件卸载时清理：定时器、报警音、屏幕共享 stream 一并释放
  // 只用空依赖：仅在真正卸载时执行一次，avoid 每次渲染误停采集
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      alarmPlayer.stop()
      screenStopRef.current()
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
    loadProgress,
    videoRef,
    start,
    stop,
    manuallyStopAlarm,
    refreshAlarmSource: applyAlarmSource,
  }
}