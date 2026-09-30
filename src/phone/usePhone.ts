/**
 * 手机端：接信令、收视频、收 DataChannel 事件。
 *
 * 与 PC 侧相反，手机永远是 answerer：收到 offer 才动。
 * 同一个 PeerConnection 要能连续吃下多次 offer（PC 在「开始监控 / 停止监控」时
 * 会通过 addTrack / removeTrack 触发重新协商），所以这里复用实例而不是每次新建，
 * 否则 ICE 连接会被反复重建，视频每改一次状态就闪断一次。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LanHit, LanMessage } from '../lan/protocol'
import type { MonitorStatus } from '../types'

const RECONNECT_MS = 2000

export interface PhoneLink {
  /** 与 PC 的信令是否已连通 */
  signaling: boolean
  /** WebRTC 通道是否已打通（收到过 offer 并应答成功） */
  peerReady: boolean
  /** 收到的远端视频流 */
  stream: MediaStream | null
  error: string | null
}

export interface PhoneState {
  alarmActive: boolean
  status: MonitorStatus
  stalled: boolean
  capturing: boolean
  hits: LanHit[]
  lastOcr: string
  /** PC 转发过来的错误日志 */
  errors: string[]
}

export function usePhone(onMessage: (msg: LanMessage) => void): PhoneLink {
  const [signaling, setSignaling] = useState(false)
  const [peerReady, setPeerReady] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const idRef = useRef<string | null>(null)
  const remoteSetRef = useRef(false)
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([])
  const wantRef = useRef(true)
  const reconnectRef = useRef<number | null>(null)
  const onMessageRef = useRef(onMessage)

  useEffect(() => {
    onMessageRef.current = onMessage
  })

  const sendWs = useCallback((msg: Record<string, unknown>): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(msg))
    return true
  }, [])

  const teardownPeer = useCallback(() => {
    channelRef.current = null
    const pc = pcRef.current
    pcRef.current = null
    remoteSetRef.current = false
    pendingIceRef.current = []
    setPeerReady(false)
    if (pc) {
      try {
        pc.close()
      } catch {
        /* 忽略 */
      }
    }
  }, [])

  const ensurePeer = useCallback((): RTCPeerConnection => {
    const existing = pcRef.current
    if (existing) return existing
    const pc = new RTCPeerConnection({ iceServers: [] })
    pcRef.current = pc
    remoteSetRef.current = false
    pendingIceRef.current = []

    pc.ontrack = (e) => {
      const s = e.streams[0] ?? new MediaStream([e.track])
      setStream(s)
      // PC 停止共享时走的是 removeTrack + 重协商：track 会「结束」但 stream 对象还在，
      // 于是 link.stream 一直非空，界面就停在黑屏的 <video> 上而不是回到占位提示。
      // 这里显式把空流转成 null，让 UI 回到「电脑未开始共享画面」。
      const dropIfEmpty = () => {
        if (s.getVideoTracks().length === 0) setStream(null)
      }
      s.addEventListener('removetrack', dropIfEmpty)
      e.track.addEventListener('ended', dropIfEmpty)
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) sendWs({ t: 'ice', from: idRef.current, candidate: e.candidate.toJSON() })
    }
    pc.ondatachannel = (e) => {
      const ch = e.channel
      channelRef.current = ch
      ch.onmessage = (ev: MessageEvent) => {
        let msg: LanMessage
        try {
          msg = JSON.parse(String(ev.data)) as LanMessage
        } catch {
          return
        }
        onMessageRef.current(msg)
      }
      ch.onclose = () => {
        // 手机页面被系统回收时通道会静默关掉；把「已连接」状态收回去，
        // 让界面提示需要重新扫码，而不是静静停在旧状态上
        channelRef.current = null
        setPeerReady(false)
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        teardownPeer()
        setStream(null)
      }
    }
    return pc
  }, [sendWs, teardownPeer])

  /** 自身要通过定时器重连，用 ref 中转，避免在初始化期引用自己（TDZ） */
  const openRef = useRef<(() => void) | null>(null)

  const openSignaling = useCallback(() => {
    if (wsRef.current) return
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${scheme}://${window.location.host}/rtc?role=phone`)
    wsRef.current = ws

    ws.onopen = () => {
      setSignaling(true)
      setError(null)
    }
    ws.onclose = () => {
      setSignaling(false)
      if (wsRef.current === ws) wsRef.current = null
      // iOS 长时间后台会掐掉页面级 WebSocket，回前台后要能自己接回来
      if (wantRef.current) {
        reconnectRef.current = window.setTimeout(() => {
          reconnectRef.current = null
          openRef.current?.()
        }, RECONNECT_MS)
      }
    }
    ws.onerror = () => {
      setError('连不上电脑上的镜像服务：请确认电脑上的服务还在运行、手机与电脑在同一个 WiFi')
    }
    ws.onmessage = (e: MessageEvent) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(e.data)) as Record<string, unknown>
      } catch {
        return
      }
      switch (msg.t) {
        case 'ready':
          idRef.current = String(msg.id ?? '')
          break
        case 'offer': {
          const pc = ensurePeer()
          void pc
            .setRemoteDescription(msg.sdp as RTCSessionDescriptionInit)
            .then(() => {
              remoteSetRef.current = true
              return pc.createAnswer()
            })
            .then((answer) => pc.setLocalDescription(answer))
            .then(() => {
              sendWs({ t: 'answer', from: idRef.current, sdp: pc.localDescription })
              setPeerReady(true)
            })
            .then(async () => {
              // 早期 candidate 是在 remoteDescription 就绪前到的，现在补进去
              for (const c of pendingIceRef.current.splice(0)) {
                await pc.addIceCandidate(c).catch(() => undefined)
              }
            })
            .catch((err: unknown) => {
              setError(`建立连接失败：${err instanceof Error ? err.message : String(err)}`)
            })
          break
        }
        case 'ice': {
          const candidate = msg.candidate as RTCIceCandidateInit | undefined
          if (!candidate) return
          if (!remoteSetRef.current) {
            pendingIceRef.current.push(candidate)
            return
          }
          const pc = pcRef.current
          if (pc) void pc.addIceCandidate(candidate).catch(() => undefined)
          break
        }
        default:
          break
      }
    }
  }, [ensurePeer, sendWs])

  useEffect(() => {
    openRef.current = openSignaling
  }, [openSignaling])

  useEffect(() => {
    // 每次挂载都要置回 true：StrictMode 会 mount→unmount→mount，
    // 第一次的清理把 wantRef 置成了 false，不复位的话之后就不会再重连了。
    wantRef.current = true
    openSignaling()
    return () => {
      wantRef.current = false
      if (reconnectRef.current !== null) {
        window.clearTimeout(reconnectRef.current)
        reconnectRef.current = null
      }
      teardownPeer()
      const ws = wsRef.current
      wsRef.current = null
      if (ws) {
        try {
          ws.close()
        } catch {
          /* 忽略 */
        }
      }
    }
  }, [openSignaling, teardownPeer])

  // 回到前台：信令多半已经断了，补一次重连（PC 端的 PeerConnection 通常还活着）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (!wsRef.current) openSignaling()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [openSignaling])

  return { signaling, peerReady, stream, error }
}
