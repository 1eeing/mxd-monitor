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

  // srcObject 用命令式赋值（与 useScreenCapture 一致）：React 的 srcObject prop
  // 各版本行为不一致，直接设属性最稳。
  useEffect(() => {
    const el = videoRef.current
    if (el) el.srcObject = link.stream
  }, [link.stream])

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
      </div>

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

      <div className="p-foot">
        <button type="button" className="p-link" onClick={() => void alarm.reload()}>
          重新拉取报警音
        </button>
      </div>
    </div>
  )
}
