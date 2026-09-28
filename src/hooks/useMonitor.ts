import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  LogEntry,
  MatchedKeyword,
  MonitorStatus,
} from '../types'
import { ALARM_GRACE_FRAMES, CUSTOM_ALARM_AUDIO_KEY, DEFAULT_ALARM_AUDIO, MAX_LOG_ENTRIES, MONITOR_STALL_MS, OCR_TIMEOUT_MS } from '../config'
import { alarmPlayer } from '../audio/player'
import { detectImageData, initOcr } from '../ocr/engine'
import { captureFrame } from '../utils/frame'
import { findKeywordMatches } from '../utils/match'
import { getFile } from '../utils/blobStore'
import { useScreenCapture } from './useScreenCapture'
import { useWorkerTicker } from './useWorkerTicker'
import type { TickerMode } from './useWorkerTicker'

let logSeq = 0

/** 识别超时的哨兵错误：与普通识别失败区分处理 */
class OcrTimeoutError extends Error {
  constructor(ms: number) {
    super(`识别超时（${Math.round(ms / 1000)}s 内没有返回结果）`)
    this.name = 'OcrTimeoutError'
  }
}

/**
 * 给识别调用加超时上限。
 * ONNX Runtime 在 WebGPU 设备丢失等情况下可能既不 resolve 也不 reject，
 * 没有这个上限的话 await 会永远挂住，识别循环从此停摆且不留任何痕迹。
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new OcrTimeoutError(ms)), ms)
    p.then(
      (v) => { window.clearTimeout(timer); resolve(v) },
      (e) => { window.clearTimeout(timer); reject(e) },
    )
  })
}

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
  /** 监控已失活：超过阈值没有成功识别过一帧，界面需明确提示 */
  stalled: boolean
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

  /**
   * 识别调用是否仍在进行中。识别超时时**不**清零：
   * 引擎既然没有按时返回，就不应再往同一个 session 上叠加新的 detect，
   * 否则可能并发调用把引擎状态搞得更糟。此时由存活看门狗提示用户重启监控。
   * 普通识别失败（reject）会清零，允许下一帧重试。
   */
  const detectInFlightRef = useRef(false)

  /** 最近一次成功识别出结果的时间戳，用于存活判定 */
  const lastOkAtRef = useRef(0)
  const [stalled, setStalled] = useState(false)
  const stallWarnedRef = useRef(false)

  /**
   * 画面冻结检测：看 video.currentTime 是否在推进。
   * 页面被浏览器冻结/挂起时，定时器停了、画面也停在最后一帧，OCR 会反复识别同一张图，
   * 看起来「在跑」其实早就漏了。currentTime 不推进比像素比对可靠——
   * 游戏站着不动时画面本来就不变，比对像素会误报。
   */
  const lastVideoTimeRef = useRef(-1)
  const stuckFramesRef = useRef(0)
  const stuckWarnedRef = useRef(false)

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

  /** 心跳定时器来源：Worker 驱动可抗后台降频；退回主线程则仍可能被降频 */
  const reportTickerMode = useCallback(
    (mode: TickerMode) => {
      addLog(
        mode === 'worker' ? 'info' : 'error',
        mode === 'worker'
          ? '识别心跳已交由 Worker 驱动，页面切到后台也不会被浏览器降频'
          : '无法创建 Worker，识别心跳退回主线程定时器：页面切到后台会被浏览器降频到约每分钟一次，可能漏报',
      )
    },
    [addLog],
  )

  // 屏幕共享被浏览器/系统主动结束（track ended）而非点击「停止监控」时，
  // 视为监控意外中断：停止报警、回到 idle（识别心跳随 status 变化由 useWorkerTicker 停掉）
  const handleStreamEnded = useCallback(() => {
    if (screenSelfStopRef.current) return
    if (statusRef.current !== 'running') return
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
    // 上一次识别超时未归零：引擎已卡死，不再发起新的识别（避免并发调用），
    // 交给存活看门狗把「监控已失活」明确显示出来
    if (detectInFlightRef.current) return
    const s = settingsRef.current
    const video = videoRef.current
    if (!video) return

    // 画面是否还在推进（后台被冻结时会停住）
    const t = video.currentTime
    if (t === lastVideoTimeRef.current) {
      stuckFramesRef.current += 1
      if (stuckFramesRef.current >= 3 && !stuckWarnedRef.current) {
        stuckWarnedRef.current = true
        addLog(
          'error',
          '采集画面已停止推进：共享窗口可能还在，但浏览器已暂停解码该画面，OCR 反复识别的是同一帧，会漏报。请把本页切到前台，或确认窗口没有被最小化。',
        )
      }
    } else {
      stuckFramesRef.current = 0
      if (stuckWarnedRef.current) stuckWarnedRef.current = false
      lastVideoTimeRef.current = t
    }

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
    detectInFlightRef.current = true
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
      const result = await withTimeout(detectImageData(frame), OCR_TIMEOUT_MS)
      // 只有正常返回才允许下一帧继续识别
      detectInFlightRef.current = false
      lastOkAtRef.current = Date.now()
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
        // 播放失败必须留痕：否则界面上显示「报警中」但一点声音都没有，且毫无线索
        void alarmPlayer.start().catch((err: unknown) => {
          addLog(
            'error',
            `报警音播放失败：${err instanceof Error ? `${err.name}（${err.message}）` : String(err)}。请检查浏览器是否拦截了自动播放、系统音量与音频输出设备。`,
          )
        })
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
      // 超时说明引擎卡死，保持 detectInFlight 让循环停下来，由看门狗暴露问题；
      // 普通失败视为偶发，清零后允许下一帧重试
      if (!(err instanceof OcrTimeoutError)) detectInFlightRef.current = false
      // 识别失败同样计入 miss 连击，避免异常把报警卡在「响个不停」状态
      missStreakRef.current += 1
      if (missStreakRef.current >= ALARM_GRACE_FRAMES) {
        alarmSuppressedRef.current = false
        if (alarmActiveRef.current) {
          alarmPlayer.stop()
          setAlarm(false)
        }
      }
      if (err instanceof OcrTimeoutError) {
        addLog(
          'error',
          'OCR 引擎无响应：单帧识别超时（可能发生了 GPU 设备丢失或驱动重置）。监控已停止识别，请「停止监控」后重新开始。',
        )
      } else {
        addLog('error', `识别失败：${err instanceof Error ? err.message : String(err)}`)
      }
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
    detectInFlightRef.current = false
    stallWarnedRef.current = false
    lastOkAtRef.current = Date.now()
    lastVideoTimeRef.current = -1
    stuckFramesRef.current = 0
    stuckWarnedRef.current = false
    setStalled(false)
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
    alarmPlayer.stop()
    setAlarm(false)
    busyRef.current = false
    missStreakRef.current = 0
    alarmSuppressedRef.current = false
    detectInFlightRef.current = false
    setStalled(false)
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

  /**
   * 识别循环的心跳改由 Worker 驱动（见 hooks/useWorkerTicker）。
   * 主线程 setInterval 在页面隐藏约 5 分钟后会被 Chrome 压到约每分钟一次，
   * 几秒内出现的测谎弹窗会被整段错过；Worker 定时器不受该限制。
   */
  useWorkerTicker(status === 'running', settings.ocrIntervalMs, tick, reportTickerMode)

  // 存活看门狗：定时器被浏览器冻结、画面取不到、引擎卡死等情况下，
  // tick 可能既不成功也不报错。界面必须能区分「正在监控」和「其实已经不动了」。
  useEffect(() => {
    if (status !== 'running') return
    const id = window.setInterval(() => {
      const isStalled = Date.now() - lastOkAtRef.current > MONITOR_STALL_MS
      setStalled((prev) => (prev === isStalled ? prev : isStalled))
      if (isStalled && !stallWarnedRef.current) {
        stallWarnedRef.current = true
        addLog(
          'error',
          `已超过 ${Math.round(MONITOR_STALL_MS / 1000)} 秒没有成功识别一帧，监控已失活，后续不会报警。请「停止监控」后重新开始。`,
        )
      }
    }, 5_000)
    return () => window.clearInterval(id)
  }, [status, addLog])

  // 页面切后台时浏览器会大幅降频识别循环，必须让用户知道会漏报
  useEffect(() => {
    if (status !== 'running') return
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        addLog(
          'info',
          '页面已切到后台。识别心跳由 Worker 驱动，不会被降频；但浏览器若冻结本页面（内存紧张时）仍会中断识别，若上方出现「监控已失活」请把本页切回前台。',
        )
      } else {
        lastOkAtRef.current = Date.now()
        stallWarnedRef.current = false
        addLog('info', '页面已回到前台')
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [status, addLog])

  // 组件卸载时清理：报警音、屏幕共享 stream 一并释放（心跳 Worker 由 useWorkerTicker 的 effect 清理）
  useEffect(
    () => () => {
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
    stalled,
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