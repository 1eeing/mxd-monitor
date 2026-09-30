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
  /**
   * 抓一份可读诊断。只涵盖 PeerConnection 侧；<video> 元素的状态由 PhoneApp
   * 读后合并，因为元素归它持有，不该把 DOM 引用传进 hook。
   */
  getDiagnostics: () => Promise<PhoneDiag>
}

/**
 * 诊断快照。刻意做成能直接回答「ICE 到底卡在哪」：
 *
 * 真机症状是 ice=checking / 0 收包，可能是
 *   a) 本端压根没发出候选（gathering 没完成）
 *   b) 发出去的是 .local，Safari 解析不了对方（mDNS 互操作问题）
 *   c) 候选正常但收不到对方的包（UDP 被拦/防火墙）
 * 这三种只有靠「本地候选 + 远端候选 + 每个候选对的 state」才能区分开，
 * 所以 stats 里非 succeeded 的候选对也要一并列出来。
 */
export interface PhoneDiag {
  signaling: boolean
  peerReady: boolean
  hasStream: boolean
  connectionState: string
  iceConnectionState: string
  iceGatheringState: string
  signalingState: string
  /** 本端发出的候选。地址是 .local 就说明被 mDNS 混淆了。 */
  localCandidates: string[]
  /** 收到的对方候选 */
  remoteCandidates: string[]
  /** 每个被尝试过的候选对及结果，failed 的也列出来 */
  candidatePairs: string[]
  /** 协商出的编解码器；null 表示还没协商出视频方向 */
  decoder: string | null
  /** 收包统计：bytesReceived 为 0 说明媒体根本没到，不是解码问题 */
  bytesReceived: number
  packetsReceived: number
  framesDecoded: number
  packetsLost: number
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
    // 这里绝不能清 pendingIceRef：PC 的 candidate 很可能先于 offer 到达
    // （offer 是 setLocalDescription 完成后才发的，onicecandidate 与它是并发的）。
    // 那些先到的候选就缓存在这里，等 offer 走完 setRemoteDescription 再补进去。
    // 清掉的话手机会一个对方候选都没有，ICE 停在 new，一个包也收不到。
    // 需要丢弃上一轮残留时由 teardownPeer 负责，它在连接拆除时才清。
    remoteSetRef.current = false

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
      // to:'pc' 显式写出来，不靠隐式约定。服务端现在无条件转发手机的 ice
      // （它只认 role，不采信客户端自报字段），这个字段当前是冗余的；
      // 但留着能让意图自明，也防止将来路由收紧时又静默丢候选。
      if (e.candidate) sendWs({ t: 'ice', to: 'pc', candidate: e.candidate.toJSON() })
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

  /**
   * 抓诊断快照。getStats 里 inbound-rtp 的 bytesReceived 是关键分水岭：
   * 为 0 说明媒体包压根没到（ICE/协商问题）；不为 0 但 framesDecoded 为 0
   * 才是解码问题；framesDecoded 在涨就是渲染/自动播放问题。
   */
  const getDiagnostics = useCallback(async (): Promise<PhoneDiag> => {
    const pc = pcRef.current
    const base: PhoneDiag = {
      signaling: wsRef.current?.readyState === WebSocket.OPEN,
      peerReady: channelRef.current?.readyState === 'open',
      hasStream: !!pc,
      connectionState: pc?.connectionState ?? 'none',
      iceConnectionState: pc?.iceConnectionState ?? 'none',
      iceGatheringState: pc?.iceGatheringState ?? 'none',
      signalingState: pc?.signalingState ?? 'none',
      localCandidates: [],
      remoteCandidates: [],
      candidatePairs: [],
      decoder: null,
      bytesReceived: 0,
      packetsReceived: 0,
      framesDecoded: 0,
      packetsLost: 0,
    }
    if (!pc) return base

    try {
      const stats = await pc.getStats()
      // 先把 candidate 收集成 id -> 可读地址的表，候选对才能翻译成「地址对地址」
      const byId = new Map<string, string>()
      stats.forEach((r) => {
        if (r.type === 'local-candidate') {
          byId.set(r.id, `${r.candidateType} ${r.address}:${r.port} ${r.protocol ?? ''}`.trim())
          base.localCandidates.push(byId.get(r.id)!)
        } else if (r.type === 'remote-candidate') {
          byId.set(r.id, `${r.candidateType} ${r.address}:${r.port} ${r.protocol ?? ''}`.trim())
          base.remoteCandidates.push(byId.get(r.id)!)
        }
      })
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          base.bytesReceived += r.bytesReceived ?? 0
          base.packetsReceived += r.packetsReceived ?? 0
          base.framesDecoded += r.framesDecoded ?? 0
          base.packetsLost += r.packetsLost ?? 0
        }
        if (r.type === 'codec' && r.id === r.inboundId) base.decoder = r.mimeType ?? null
        if (r.type === 'candidate-pair') {
          // failed / waiting 的也列出来：ICE 卡住时「试过哪些地址、为什么没成」
          // 才是关键信息，只报 succeeded 等于什么也没说
          const l = byId.get(r.localCandidateId) ?? r.localCandidateId ?? '?'
          const rr = byId.get(r.remoteCandidateId) ?? r.remoteCandidateId ?? '?'
          base.candidatePairs.push(`${r.state ?? '?'}${r.nominated ? ' (已选中)' : ''} [${l}] -> [${rr}]`)
        }
      })
      // 旧版/部分实现里 codec 不带 inboundId，退而求其次找实际用上的解码器
      if (!base.decoder) {
        stats.forEach((r) => {
          if (r.type === 'codec' && r.mimeType?.startsWith('video')) base.decoder = r.mimeType
        })
      }
    } catch (err) {
      base.connectionState = `getStats 失败: ${err instanceof Error ? err.message : String(err)}`
    }
    return base
  }, [])

  return { signaling, peerReady, stream, error, getDiagnostics }
}
