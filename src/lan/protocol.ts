import type { LogKind, MonitorStatus } from '../types'

/**
 * PC 与手机之间的 DataChannel 消息协议。
 *
 * 通道是 JSON 文本（不用二进制分帧）：报警事件体积很小，而报警音频走 HTTP 从本地
 * 服务端下载（见 useLanMirror 的 uploadAlarmAudio），没必要为它引入分片重组逻辑。
 *
 * 报警音频单独走 HTTP 的原因：自定义音频存在 IndexedDB 里，是 PC 私有的 blob，
 * DataChannel 传二进制要自己做分帧/重组/校验，而两端本来就都连着同一个本地服务，
 * 借道 HTTP 更简单也更稳。
 */

/** 命中的关键字（去掉规则详情，只传手机端显示需要的字段） */
export interface LanHit {
  /** 规则名称，如「被挤下线」 */
  label: string
  /** 命中的原文片段 */
  snippet: string
  /** 该行平均置信度 0~1 */
  score: number
}

/** OCR 调试文本的长度上限：手机屏幕窄，整段塞进去会挤掉其他信息 */
export const LAST_OCR_MAX = 300

/** DataChannel 通道名。两端必须一致，否则 ondatachannel 不会触发 */
export const LAN_CHANNEL = 'mxd'

/**
 * 全量状态同步，手机连上时以及每次状态变化时都发一次。
 *
 * 刻意只保留「状态」而没有「边沿」消息（不再有 alarm-on / alarm-off）：
 * DataChannel 本身可靠有序，边沿要么不丢要么全到，但一旦漏一次
 * （例如手机在重连窗口内漏收）状态就永久错位；全量快照没有这个问题，
 * 手机端只需自己 diff alarmActive 决定要不要鸣响。
 */
export type LanMessage =
  | {
      t: 'sync'
      alarmActive: boolean
      status: MonitorStatus
      stalled: boolean
      capturing: boolean
      hits: LanHit[]
      lastOcr: string
      at: number
    }
  /** 关键日志转发：只转发 error 级别，避免刷屏 */
  | { t: 'log'; kind: LogKind; message: string; at: number }

/** 手机端连接状态，用于 UI 显示 */
export type LanPhoneState = 'connecting' | 'connected' | 'disconnected' | 'failed'

/** PC 侧对外暴露的镜像状态 */
export interface LanMirrorState {
  /** 是否已连上本地信令服务 */
  signaling: boolean
  /** 已连接的手机数量 */
  phoneCount: number
  /** 最近一次连接的手机标识（短 id），用于 UI 展示 */
  phoneIds: string[]
  /** 最近一次错误（中文，可直接展示） */
  error: string | null
  /** 已推送给手机的报警音频是否就绪 */
  audioReady: boolean
}

/** 把 useMonitor 的 MatchedKeyword[] 压成协议要的形状，顺带截断超长片段 */
export function toLanHits(
  hits: ReadonlyArray<{ rule: { label: string }; snippet: string; score: number }>,
  maxSnippet = 60,
): LanHit[] {
  return hits.map((h) => ({
    label: h.rule.label,
    snippet: h.snippet.length > maxSnippet ? `${h.snippet.slice(0, maxSnippet)}…` : h.snippet,
    score: h.score,
  }))
}
