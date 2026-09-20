/** OCR 计算后端 */
export type OcrBackend = 'webgpu' | 'wasm'

/** 一条关键字规则（pattern 为正则表达式） */
export interface KeywordRule {
  id: string
  label: string
  pattern: string
  enabled: boolean
}

/** 识别区域裁剪（0~1 的比例值，相对视频画面） */
export interface CropRegion {
  enabled: boolean
  /** 0~1，画面左上角 x 比例 */
  left: number
  /** 0~1，画面左上角 y 比例 */
  top: number
  /** 0~1，裁剪宽度比例 */
  width: number
  /** 0~1，裁剪高度比例 */
  height: number
  /** 识别前放大倍率（1~4）。放大后再识别，小字号文字更清晰、更准 */
  scale: number
}

/** 应用设置 */
export interface AppSettings {
  /** OCR 识别间隔，毫秒 */
  ocrIntervalMs: number
  backend: OcrBackend
  keywords: KeywordRule[]
  crop: CropRegion
  /** 是否使用自定义报警音频 */
  useCustomAudio: boolean
  /** 自定义音频文件名（IndexedDB 中存储的 key） */
  customAudioName: string
}

export type MonitorStatus = 'idle' | 'initializing' | 'running' | 'error'

export type LogKind = 'info' | 'hit' | 'stop' | 'error'

export interface LogEntry {
  id: string
  time: string
  kind: LogKind
  message: string
}

/** 命中的关键字及上下文 */
export interface MatchedKeyword {
  rule: KeywordRule
  /** 命中的原文片段 */
  snippet: string
  /** 该条识别行的平均置信度 */
  score: number
}