/**
 * PC 侧局域网镜像：信令 + WebRTC + DataChannel 推送。
 *
 * 拓扑：PC 永远是 offerer，手机只收视频轨，所以不存在 offer 冲突（glare），
 * 不需要实现完整协商（perfect negotiation）那套「双方都能发起」的逻辑。
 *
 * 不配 iceServers：同局域网靠 host candidate 直连就够了。挂公网 STUN 会
 * 多一层外部依赖和不必要的隐私暴露，跨网本来也不是这个功能的目标。
 *
 * 首次协商只带 DataChannel，视频轨等连接建立后再挂——原因见 createPeer 里的注释。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { alarmPlayer } from '../audio/player'
import type { LogEntry, MatchedKeyword, MonitorStatus } from '../types'
import { LAST_OCR_MAX, LAN_CHANNEL, toLanHits } from './protocol'
import type { LanMessage } from './protocol'
import { lanAddressable, qrTargetReachable } from './qr'

/** 手机端页面路径 */
const PHONE_PATH = '/phone.html'

/**
 * 发送参数。真机实测：PC 标签页切后台时 Chrome 会把编码帧率压到约 1fps，
 * 但那种场景人本来就不看画面，报警靠 DataChannel 事件而不是视频。
 * 所以上限压得很低，把码率预算让给游戏。
 */
const VIDEO_TARGET_WIDTH = 640
const VIDEO_MAX_FPS = 3
const VIDEO_MAX_BITRATE = 300_000

/** 信令断开后的重连间隔；固定间隔即可，本地服务不会真的长挂 */
const RECONNECT_MS = 2000

/** 监控侧需要镜像出去的状态 */
export interface LanMirrorInput {
  alarmActive: boolean
  status: MonitorStatus
  stalled: boolean
  /** 是否正在采集。变化时负责挂上/摘掉视频轨 */
  capturing: boolean
  hits: MatchedKeyword[]
  /** OCR 调试文本，截断后转发给手机 */
  lastOcr: string
  logs: LogEntry[]
  /** 取当前采集流。用 getter 而非直接传值：采集流存在 ref 里，App 渲染时读它不合适 */
  getStream: () => MediaStream | null
}

export interface UseLanMirror {
  /** 用户是否开启了镜像 */
  active: boolean
  /** 已连接手机数 */
  phoneCount: number
  /** 信令是否已连上本地服务 */
  signaling: boolean
  /** 手机要打开的完整地址；null 表示当前页面地址手机访问不到 */
  phoneUrl: string | null
  /** phoneUrl 为 null 时的中文原因，可直接展示 */
  urlProblem: string | null
  /** 最近一次错误（中文，可直接展示） */
  error: string | null
  /** 报警音频是否已成功同步到服务端 */
  audioReady: boolean
  connect: () => void
  disconnect: () => void
  /** 把当前报警音源推送到服务端，供手机下载（设置变更后需再调一次） */
  refreshAudio: () => Promise<void>
}

interface PhonePeer {
  id: string
  pc: RTCPeerConnection
  channel: RTCDataChannel | null
  sender: RTCRtpSender | null
  /** remoteDescription 还没设好时先缓存 ICE，否则早期 candidate 会被丢掉 */
  pendingIce: RTCIceCandidateInit[]
  negotiating: boolean
  /** 协商进行中又来了 negotiationneeded：记下来，等这轮结束再补一次 */
  renegotiateQueued: boolean
}

export function useLanMirror(input: LanMirrorInput): UseLanMirror {
  const [active, setActive] = useState(false)
  const [phoneCount, setPhoneCount] = useState(0)
  const [signaling, setSignaling] = useState(false)
  /** 服务端通告的局域网地址（ready 消息里带来），二维码内容用它 */
  const [phoneUrls, setPhoneUrls] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [audioReady, setAudioReady] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const peersRef = useRef(new Map<string, PhonePeer>())
  const wantRef = useRef(false)
  const reconnectRef = useRef<number | null>(null)
  /** 当前采集流；新建立连接时要用它补挂视频 */
  const streamRef = useRef<MediaStream | null>(null)
  /** 最近一次全量状态，通道刚 open / 有手机刚连上时补发 */
  const syncRef = useRef<LanMessage | null>(null)
  /** 已经转发过的日志条数，避免重连后把旧日志再刷一遍 */
  const logCursorRef = useRef(0)

  const sendWs = useCallback((msg: Record<string, unknown>): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(msg))
    return true
  }, [])

  const broadcast = useCallback((msg: LanMessage) => {
    syncRef.current = msg
    const text = JSON.stringify(msg)
    for (const peer of peersRef.current.values()) {
      if (peer.channel?.readyState === 'open') peer.channel.send(text)
    }
  }, [])

  const dropPeer = useCallback((id: string) => {
    const peer = peersRef.current.get(id)
    if (!peer) return
    peersRef.current.delete(id)
    // close() 在已关闭时会抛，全部吞掉：清理路径不该成为新的报错来源
    try {
      peer.channel?.close()
    } catch {
      /* 忽略 */
    }
    try {
      peer.pc.close()
    } catch {
      /* 忽略 */
    }
    setPhoneCount(peersRef.current.size)
  }, [])

  /**
   * 把采集流挂到连接上（幂等）。addTrack 会触发 onnegotiationneeded 去发 offer。
   *
   * 只在 DataChannel 已 open 时才挂：也就是 ICE + DTLS 确实通了之后。
   * 这样不管接入顺序如何，首个 offer 都必然只有 DataChannel——
   * iOS Safari 对「首个 offer 就带视频轨」的协商会让 ICE 永远停在 checking，
   * 而 DataChannel open 必然意味着连接已建立，漏挂的情况由 channel.onopen 补。
   */
  const attachTrack = useCallback((peer: PhonePeer, stream: MediaStream) => {
    if (peer.sender) return
    if (peer.channel?.readyState !== 'open') return
    const track = stream.getVideoTracks()[0]
    if (!track) return
    const sender = peer.pc.addTrack(track, stream)
    peer.sender = sender
    // getParameters 是同步的（老版本 Chrome 才是 Promise，按规范实现即可）
    const params = sender.getParameters()
    params.encodings = params.encodings?.length ? params.encodings : [{}]
    const [enc] = params.encodings
    // 采集的是整个游戏窗口（可能 1080p/2K）。不缩放的话 300kbps 要塞 1080p，
    // 画面会糊成一团，远不如降到 640 宽清晰。scaleResolutionDownBy 必须是整数。
    const width = track.getSettings().width ?? 1920
    enc.scaleResolutionDownBy = Math.max(1, Math.ceil(width / VIDEO_TARGET_WIDTH))
    enc.maxFramerate = VIDEO_MAX_FPS
    enc.maxBitrate = VIDEO_MAX_BITRATE
    void sender.setParameters(params).catch((err: unknown) => {
      setError(`设置视频参数失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }, [])

  const ensureTrack = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    for (const peer of peersRef.current.values()) attachTrack(peer, stream)
  }, [attachTrack])

  /** 监控停止后摘掉视频轨，手机端才能回落到占位图而不是卡在最后一帧 */
  const detachTrack = useCallback((peer: PhonePeer) => {
    if (!peer.sender) return
    const { sender } = peer
    peer.sender = null
    try {
      peer.pc.removeTrack(sender)
    } catch {
      /* 忽略 */
    }
  }, [])

  const createPeer = useCallback(
    (id: string) => {
      const pc = new RTCPeerConnection({ iceServers: [] })
      const peer: PhonePeer = {
        id,
        pc,
        channel: null,
        sender: null,
        pendingIce: [],
        negotiating: false,
        renegotiateQueued: false,
      }
      peersRef.current.set(id, peer)
      setPhoneCount(peersRef.current.size)

      /**
       * 发一次 offer。
       *
       * 协商期间到来的 negotiationneeded 不能直接丢：addTrack 只要发生在
       * setLocalDescription 未完成时，那个事件就被吞掉且不会再补发，
       * 结果是视频轨永远协商不上（表现为手机端「已连接但没画面」）。
       * 所以记一个标记，这轮结束后补跑一次。
       */
      function negotiate(): void {
        if (peer.negotiating) {
          peer.renegotiateQueued = true
          return
        }
        peer.negotiating = true
        void pc
          .setLocalDescription()
          .then(() => {
            sendWs({ t: 'offer', to: id, sdp: pc.localDescription })
          })
          .catch((err: unknown) => {
            setError(`与手机协商失败：${err instanceof Error ? err.message : String(err)}`)
          })
          .finally(() => {
            peer.negotiating = false
            if (peer.renegotiateQueued) {
              peer.renegotiateQueued = false
              negotiate()
            }
          })
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) sendWs({ t: 'ice', to: id, candidate: e.candidate.toJSON() })
      }
      pc.onnegotiationneeded = negotiate
      pc.onconnectionstatechange = () => {
        // failed 基本等于对端走了（手机锁屏杀页面、断网）；closed 是我们自己 close 的
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(id)
      }

      const channel = pc.createDataChannel(LAN_CHANNEL)
      peer.channel = channel
      channel.onopen = () => {
        setError(null)
        // 补发全量状态：手机可能在监控已在报警时才连上
        if (syncRef.current) channel.send(JSON.stringify(syncRef.current))
        // 视频轨在连接建立之后才挂（见下方注释），这里是补挂的时机
        ensureTrack()
      }
      channel.onclose = () => {
        // 通道关了就不算连上了（iOS 回收页面时通道会静默关闭）。
        // 直接拆掉整条连接，手机重新打开页面会走正常流程建新连接；
        // 留着一条半死的连接只会让「已连接 1 台」变成假状态。
        dropPeer(id)
      }

      // 刻意不在这里挂视频轨。
      //
      // 真机（iOS Safari）实测：首次 offer 里就带视频轨时，ICE 永远停在
      // checking、一个包都收不到；首次 offer 只带 DataChannel 则完全正常。
      // 两种接入顺序因此走的是不同的首次协商内容：
      //   手机先连、PC 后开始监控 -> 首轮无视频，ICE 通 -> 补轨重协商 -> 有画面
      //   PC 先共享、手机后连     -> 首轮带视频，ICE 卡死（就是用户遇到的）
      // 根因在浏览器侧（Safari 对首轮含视频轨的协商疑似有特殊处理），
      // 但不必赌它——让两条顺序强制走同一条已被真机验证过的路径即可。
      // 代价只是画面晚一次重协商到达（几十毫秒），换来行为与顺序无关。
      // 视频轨改在 channel.onopen（ICE + DTLS 都已建立）后由 ensureTrack 挂上。
      return peer
    },
    [dropPeer, ensureTrack, sendWs],
  )

  const closeAll = useCallback(() => {
    for (const id of [...peersRef.current.keys()]) dropPeer(id)
    const ws = wsRef.current
    wsRef.current = null
    if (ws) {
      try {
        ws.close()
      } catch {
        /* 忽略 */
      }
    }
    setSignaling(false)
  }, [dropPeer])

  /**
   * 自身要通过定时器重连，用 ref 中转一下。
   * 直接在 useCallback 体内引用自己会在初始化期就取值（TDZ），
   * 交给 lint 也会报 "read while it is still being initialized"。
   */
  const openRef = useRef<(() => void) | null>(null)

  const openSignaling = useCallback(() => {
    if (wsRef.current) return
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${scheme}://${window.location.host}/rtc?role=pc`)
    wsRef.current = ws

    ws.onopen = () => {
      setSignaling(true)
      setError(null)
      ensureTrack()
    }
    ws.onclose = () => {
      setSignaling(false)
      if (wsRef.current === ws) wsRef.current = null
      if (wantRef.current) {
        reconnectRef.current = window.setTimeout(() => {
          reconnectRef.current = null
          openRef.current?.()
        }, RECONNECT_MS)
      }
    }
    ws.onerror = () => {
      // onerror 之后必定跟 onclose，重连逻辑统一在 onclose 处理，这里只提示
      setError('连不上局域网镜像服务：请确认已执行 npm run lan，且手机与本机在同一 WiFi')
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
          // 服务端会带上它自己看到的局域网地址：二维码内容必须用这个，
          // 而不是 location.hostname——PC 端为了能采集屏幕只能用 localhost 打开，
          // 那样推出来的二维码会是 localhost，手机扫了根本连不上。
          if (Array.isArray(msg.phoneUrls) && msg.phoneUrls.length > 0) {
            setPhoneUrls(msg.phoneUrls.map(String))
          }
          // 重连成功：重新协商所有还挂着的连接
          ensureTrack()
          break
        case 'peer': {
          const id = String(msg.id)
          if (!peersRef.current.has(id)) createPeer(id)
          break
        }
        case 'peer-leave':
          dropPeer(String(msg.id))
          break
        case 'bye':
          setError(`镜像服务被另一个 PC 页面占用（${String(msg.why ?? '未知原因')}），请关掉另一个页面`)
          break
        case 'answer': {
          const peer = peersRef.current.get(String(msg.from))
          if (!peer) return
          void peer.pc
            .setRemoteDescription(msg.sdp as RTCSessionDescriptionInit)
            .then(async () => {
              for (const c of peer.pendingIce.splice(0)) {
                await peer.pc.addIceCandidate(c).catch(() => undefined)
              }
            })
            .catch((err: unknown) => {
              setError(`设置手机应答失败：${err instanceof Error ? err.message : String(err)}`)
            })
          break
        }
        case 'ice': {
          const peer = peersRef.current.get(String(msg.from))
          const candidate = msg.candidate as RTCIceCandidateInit | undefined
          if (!peer || !candidate) return
          if (!peer.pc.remoteDescription) {
            peer.pendingIce.push(candidate)
            return
          }
          void peer.pc.addIceCandidate(candidate).catch(() => undefined)
          break
        }
        default:
          break
      }
    }
  }, [createPeer, dropPeer, ensureTrack])

  useEffect(() => {
    openRef.current = openSignaling
  }, [openSignaling])

  /**
   * 报警音频：PC 读当前音源（自定义 blob 或默认 mp3）PUT 给服务端，手机去取。
   * 两端本来就都连着同一个服务，借道 HTTP 比用 DataChannel 传二进制分片简单得多。
   */
  const refreshAudio = useCallback(async (): Promise<void> => {
    const src = alarmPlayer.source
    if (!src) {
      setAudioReady(false)
      return
    }
    try {
      const resp = await fetch(src)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const buf = await resp.arrayBuffer()
      if (buf.byteLength === 0) throw new Error('音频内容为空')
      const up = await fetch('/alarm-audio', {
        method: 'PUT',
        headers: { 'Content-Type': resp.headers.get('Content-Type') ?? 'audio/mpeg' },
        body: buf,
      })
      if (!up.ok) throw new Error(`HTTP ${up.status}`)
      setAudioReady(true)
    } catch (err) {
      setAudioReady(false)
      const why = err instanceof Error ? err.message : String(err)
      setError(
        `报警音频未能同步到手机（${why}）。` +
          (src.startsWith('/') ? `请确认 ${src} 存在，自定义音频可在设置里重新上传。` : '手机将退回默认提示音。'),
      )
    }
  }, [])

  const connect = useCallback(() => {
    wantRef.current = true
    setActive(true)
    setError(null)
    openSignaling()
    void refreshAudio()
  }, [openSignaling, refreshAudio])

  const disconnect = useCallback(() => {
    wantRef.current = false
    setActive(false)
    if (reconnectRef.current !== null) {
      window.clearTimeout(reconnectRef.current)
      reconnectRef.current = null
    }
    closeAll()
  }, [closeAll])

  // 状态变化 → 全量快照推给所有手机
  const { alarmActive, status, stalled, capturing, hits, lastOcr, logs, getStream } = input
  useEffect(() => {
    const text = lastOcr.length > LAST_OCR_MAX ? `${lastOcr.slice(0, LAST_OCR_MAX)}…` : lastOcr
    broadcast({
      t: 'sync',
      alarmActive,
      status,
      stalled,
      capturing,
      hits: toLanHits(hits),
      lastOcr: text,
      at: Date.now(),
    })
  }, [broadcast, alarmActive, status, stalled, capturing, hits, lastOcr])

  // 采集开始/停止 → 挂上/摘掉视频轨
  useEffect(() => {
    if (capturing) {
      const stream = getStream()
      streamRef.current = stream
      ensureTrack()
    } else {
      streamRef.current = null
      for (const peer of peersRef.current.values()) detachTrack(peer)
    }
  }, [capturing, getStream, ensureTrack, detachTrack])

  // 只转发新增的 error 日志，让手机能看到「为什么没报警」
  useEffect(() => {
    const prev = logCursorRef.current
    if (logs.length < prev) {
      // 监控重启会清空日志，此时全量重发
      logCursorRef.current = 0
      return
    }
    for (let i = prev; i < logs.length; i += 1) {
      const entry = logs[i]
      if (entry.kind !== 'error') continue
      broadcast({ t: 'log', kind: entry.kind, message: entry.message, at: Date.now() })
    }
    logCursorRef.current = logs.length
  }, [broadcast, logs])

  // 卸载（含 StrictMode 的双调用）必须收干净，否则会残留 PeerConnection 与 WebSocket
  useEffect(
    () => () => {
      wantRef.current = false
      if (reconnectRef.current !== null) window.clearTimeout(reconnectRef.current)
      closeAll()
    },
    [closeAll],
  )

  /**
   * 二维码内容优先用服务端通告的局域网地址。
   * 兜底才用 location.hostname——那种情况只可能是页面没经由本地服务打开，
   * 此时多半也连不上信令，UI 会另行报错。
   */
  const advertised = phoneUrls.filter((u) => /^https?:\/\//.test(u))
  const addr = lanAddressable()
  const phoneUrl =
    advertised[0] ??
    (addr.ok ? `${window.location.protocol}//${addr.host}${PHONE_PATH}` : null)

  // 只在最终拿去编码的地址上做可达性检查：localhost 时二维码是死链，必须拦住
  const reach = phoneUrl ? qrTargetReachable(phoneUrl) : null
  const problem = !phoneUrl
    ? '还没有可用的手机端地址，请确认 npm run lan 在运行'
    : reach && !reach.ok
      ? reach.reason
      : null

  return {
    active,
    phoneCount,
    signaling,
    phoneUrl: problem ? null : phoneUrl,
    urlProblem: problem,
    error,
    audioReady,
    connect,
    disconnect,
    refreshAudio,
  }
}
