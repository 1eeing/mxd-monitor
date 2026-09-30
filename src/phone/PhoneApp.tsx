import { useCallback, useEffect, useRef, useState } from 'react'
import type { LanMessage } from '../lan/protocol'
import { usePhone } from './usePhone'
import type { PhoneState } from './usePhone'
import { usePhoneAlarm } from './usePhoneAlarm'

const STATUS_TEXT: Record<PhoneState['status'], string> = {
  idle: '监控未开始',
  initializing: '正在启动监控…',
  running: '监控运行中',
  error: '监控出错',
}

function formatTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export default function PhoneApp() {
  const [state, setState] = useState<PhoneState>({
    alarmActive: false,
    status: 'idle',
    stalled: false,
    capturing: false,
    hits: [],
    lastOcr: '',
    errors: [],
  })

  const onMessage = useCallback((msg: LanMessage) => {
    if (msg.t === 'sync') {
      setState((prev) => ({
        ...prev,
        alarmActive: msg.alarmActive,
        status: msg.status,
        stalled: msg.stalled,
        capturing: msg.capturing,
        hits: msg.hits,
        lastOcr: msg.lastOcr,
      }))
      return
    }
    if (msg.t === 'log') {
      // 只留最近 5 条：页面被系统回收再打开时，不至于被一堆旧日志淹没
      setState((prev) => ({
        ...prev,
        errors: [...prev.errors.slice(-4), `${formatTime(msg.at)} ${msg.message}`],
      }))
    }
  }, [])

  const link = usePhone(onMessage)
  const alarm = usePhoneAlarm()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioSyncedRef = useRef(false)
  /*
   * 视频起播这套逻辑的存在理由（不是自动播放被拦那么简单）：
   *
   * <video> 是 link.stream 变成非空时才被创建并赋 srcObject 的，此时页面可能
   * 还没被用户碰过（没有用户手势），Safari 会拒绝启动播放，表现为「已连接、
   * 也有视频元素、videoWidth 也有，但一片黑」。这个坑和接入顺序强相关：
   * 晚到的手机一连上画面就到了，必然被拦；手机先连时画面要等 PC 后续 addTrack
   * 才到，那时用户已被迫点过「开启报警声音」，页面已激活，autoPlay 反而生效。
   *
   * 但真机验证下来，主因其实是信令层把 ICE 候选丢了（bytes=0，媒体压根没到），
   * 播放层再怎么修都没用。所以这里保留为兜底：显式 play() + 常驻播放/暂停开关，
   * 任何时候点一下都能手动接管。
   */
  /** 自动播放被拒的流 */
  const [blockedStream, setBlockedStream] = useState<MediaStream | null>(null)
  /** 用户主动暂停的流 */
  const [pausedStream, setPausedStream] = useState<MediaStream | null>(null)
  /** 实际播放状态，取自 <video> 的 play/pause 事件，比自己记的更可靠 */
  const [playing, setPlaying] = useState(false)
  // 派生而非布尔 state：换流时自动失效，不用在 effect 里同步 setState 复位
  // （那会引发级联渲染）。同一个流反复重试时状态对象不变，也不会死循环。
  const playBlocked = link.stream !== null && blockedStream === link.stream
  const userPaused = link.stream !== null && pausedStream === link.stream

  const { ringing, setRinging, reload: reloadAudio } = alarm

  // 报警状态直接跟着远端走：手机端没有独立的「停止」按钮，
  // 条件解除后 PC 会停，手机跟着停，避免两边状态打架。
  useEffect(() => {
    setRinging(state.alarmActive)
  }, [state.alarmActive, setRinging])

  // 通道通了再拉一次报警音：挂载时 PC 可能还没把音频 PUT 上来，
  // 而 PC 是在 connect() 里就上传的，所以等到这一刻才刚好能拿到。
  useEffect(() => {
    if (!link.peerReady || audioSyncedRef.current) return
    audioSyncedRef.current = true
    void reloadAudio()
  }, [link.peerReady, reloadAudio])

  /**
   * 挂上流并显式起播。返回 Promise 而不是吞掉错误：被拒就说明需要用户手势，
   * 得把「点一下开始播放」这个按钮露出来。
   */
  const startPlayback = useCallback((): Promise<void> => {
    const el = videoRef.current
    const stream = link.stream
    if (!el || !stream) return Promise.resolve()
    el.srcObject = stream
    return el
      .play()
      .then(() => setBlockedStream(null))
      .catch(() => setBlockedStream(stream))
  }, [link.stream])

  /** 播放/暂停切换。任何时候点一下都能手动接管，Safari 自动播放不可靠时的兜底。 */
  const togglePlayback = useCallback((): void => {
    const el = videoRef.current
    const stream = link.stream
    if (!el || !stream) return
    if (el.paused) {
      setPausedStream(null)
      void startPlayback()
    } else {
      el.pause()
      setPausedStream(stream)
    }
  }, [link.stream, startPlayback])

  // srcObject 用命令式赋值（与 useScreenCapture 一致）：React 的 srcObject prop
  // 各版本行为不一致，直接设属性最稳。
  // 用户手动暂停过就别再自动起播（userPaused 是派生值，换流后自动为 false）。
  useEffect(() => {
    if (link.stream && !userPaused) void startPlayback()
  }, [link.stream, userPaused, startPlayback])

  // 播放状态以 <video> 的事件为准：Safari 可能不 reject play() 却不渲染，
  // 只有元素自己报告的 play/pause 才是真相。
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
    }
  }, [link.stream])

  // 音频解锁那一下是天然的用户手势，借它把被拦的视频播放再推一次
  useEffect(() => {
    if (alarm.unlocked && playBlocked) void startPlayback()
  }, [alarm.unlocked, playBlocked, startPlayback])

  /** 诊断文本。做成纯文本方便直接复制发回来。 */
  const [diagText, setDiagText] = useState('')

  const refreshDiag = useCallback(async (): Promise<string> => {
    const d = await link.getDiagnostics()
    const v = videoRef.current
    const list = (arr: string[]): string => (arr.length ? arr.join(' ; ') : '（无）')
    // readyState: 0=HAVE_NOTHING 1=HAVE_METADATA 2=HAVE_CURRENT_DATA 3=HAVE_ENOUGH_DATA
    const text = [
      `信令 signaling=${d.signaling} 通道 peerReady=${d.peerReady} 会话=${d.hasStream}`,
      `连接 connection=${d.connectionState} ice=${d.iceConnectionState} 收集=${d.iceGatheringState} sdp=${d.signalingState}`,
      `视频 video=${v ? `${v.videoWidth}x${v.videoHeight}` : '无元素'} readyState=${v?.readyState ?? 0} paused=${v?.paused ?? true}`,
      `编解码 decoder=${d.decoder ?? '无'}`,
      `收包 bytes=${d.bytesReceived} packets=${d.packetsReceived} framesDecoded=${d.framesDecoded} lost=${d.packetsLost}`,
      `本端候选: ${list(d.localCandidates)}`,
      `对方候选: ${list(d.remoteCandidates)}`,
      `候选对: ${list(d.candidatePairs)}`,
    ].join('\n')
    setDiagText(text)
    return text
  }, [link])

  const copyDiag = useCallback(async (): Promise<void> => {
    const text = await refreshDiag()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* iOS 非用户手势下常被拒，忽略：文本已经显示在页面上，可手动选中 */
    }
  }, [refreshDiag])

  return (
    <div className={`p-app${ringing ? ' ringing' : ''}`}>
      {/* 报警条：全屏顶部，靠颜色和文字，静音/振动状态下一眼可辨 */}
      {state.alarmActive && (
        <div className="p-alarm-bar">
          <span className="p-alarm-title">⚠ 报警中</span>
          <span className="p-alarm-hits">
            {state.hits.map((h) => h.label).join('、') || '检测到关键字'}
          </span>
        </div>
      )}

      <div className="p-status-row">
        <span className={`p-dot ${link.peerReady ? 'on' : 'off'}`} />
        {link.peerReady ? '已连接电脑' : link.signaling ? '正在连接电脑…' : '等待电脑服务…'}
      </div>

      <div className="p-status-text">
        {STATUS_TEXT[state.status]}
        {state.capturing ? ' · 画面共享中' : ''}
        {state.stalled ? ' · ⚠ 电脑端监控已失活' : ''}
      </div>

      {/* 视频：muted + playsInline 是 iOS 自动播放的前提，不能省 */}
      <div className="p-video-wrap">
        {link.stream ? (
          <video ref={videoRef} className="p-video" autoPlay muted playsInline />
        ) : (
          <div className="p-video-placeholder">
            {state.capturing ? '等待视频…' : '电脑未开始共享画面'}
          </div>
        )}

        {/* 常驻播放/暂停。Safari 的自动播放既可能 reject 也可能静默不渲染，
            给一个随时能点的开关比指望自动播放靠谱。 */}
        {link.stream && (
          <button
            type="button"
            className={`p-video-toggle${playing ? ' on' : ''}`}
            onClick={togglePlayback}
            aria-label={playing ? '暂停画面' : '播放画面'}
          >
            {playing ? '⏸' : '▶'}
          </button>
        )}
      </div>

      {playBlocked && (
        <div className="p-audio-box">
          <button type="button" className="p-unlock small" onClick={() => void startPlayback()}>
            ▶ 点一下开始播放画面
          </button>
          <div className="p-hint">
            手机浏览器要求先点一下才肯播放视频，点一次即可，之后会自动续上。也可以点画面右上角的 ▶。
          </div>
        </div>
      )}

      {state.hits.length > 0 && (
        <div className="p-hits">
          {state.hits.map((h) => (
            <div className="p-hit" key={h.label}>
              <span className="p-hit-label">{h.label}</span>
              <span className="p-hit-snippet">{h.snippet}</span>
            </div>
          ))}
        </div>
      )}

      {/* 音频解锁：iOS 上没这一步就永远不会有声音，必须做成显眼的大按钮 */}
      {(!alarm.unlocked || alarm.blockedReason) && (
        <div className="p-audio-box">
          <button
            type="button"
            className={alarm.unlocked ? 'p-unlock small' : 'p-unlock'}
            onClick={() => void alarm.unlock()}
          >
            {alarm.unlocked ? '🔊 恢复声音' : '🔊 点一下开启报警声音'}
          </button>
          <div className="p-hint">
            {alarm.blockedReason ?? 'iOS 要求先有一次点击才允许播放声音，点一次即可，之后会自动响。'}
          </div>
        </div>
      )}

      {link.error && <div className="p-error">{link.error}</div>}

      {state.errors.length > 0 && (
        <div className="p-errors">
          {state.errors.map((e, i) => (
            <div className="p-error-line" key={`${i}-${e}`}>
              {e}
            </div>
          ))}
        </div>
      )}

      {state.lastOcr && (
        <details className="p-ocr">
          <summary>电脑端识别到的文字</summary>
          <div>{state.lastOcr}</div>
        </details>
      )}

      {/*
        连接诊断。真机上的问题（同机 Chrome 复现不出来的那些）只能靠这份数据定位。
        默认收起，做成可复制的纯文本，用户把内容贴回来即可定位到具体环节：
        bytesReceived=0 是媒体包没到（ICE/协商），framesDecoded 不涨是解码，
        两者都在涨就只剩渲染/自动播放。
      */}
      <details className="p-diag">
        <summary>连接诊断（排查用）</summary>
        <div className="p-diag-actions">
          <button type="button" className="p-link" onClick={() => void refreshDiag()}>
            刷新诊断
          </button>
          <button type="button" className="p-link" onClick={() => void copyDiag()}>
            复制
          </button>
        </div>
        {diagText ? <pre className="p-diag-text">{diagText}</pre> : <div className="p-hint">点「刷新诊断」抓一份当前状态。</div>}
      </details>

      <div className="p-foot">
        <button type="button" className="p-link" onClick={() => void alarm.reload()}>
          重新拉取报警音
        </button>
      </div>
    </div>
  )
}
