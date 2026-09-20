import type { AppSettings } from './types'
import { DEFAULT_OCR_INTERVAL_MS } from './config'

const STORAGE_KEY = 'mxd-monitor.settings.v1'

export const DEFAULT_SETTINGS: AppSettings = {
  ocrIntervalMs: DEFAULT_OCR_INTERVAL_MS,
  backend: 'webgpu',
  keywords: [
    { id: 'k1', label: '测谎', pattern: '测谎小游戏开始', enabled: true },
    { id: 'k2', label: '断线', pattern: '与服务器连接发生错误', enabled: true },
    { id: 'k3', label: 'Boss 出现', pattern: '\\bboss\\b|BOSS', enabled: false },
    { id: 'k4', label: '强化成功', pattern: '强化成功', enabled: false },
  ],
  crop: { enabled: false, left: 0, top: 0, width: 1, height: 1, scale: 1 },
  useCustomAudio: false,
  customAudioName: '',
}

function isKeywordRule(value: unknown): value is AppSettings['keywords'][number] {
  if (typeof value !== 'object' || value === null) return false
  const rule = value as Record<string, unknown>
  return (
    typeof rule.id === 'string' &&
    typeof rule.label === 'string' &&
    typeof rule.pattern === 'string' &&
    typeof rule.enabled === 'boolean'
  )
}

function partialSettings(value: unknown): Partial<AppSettings> {
  if (typeof value !== 'object' || value === null) return {}
  return value as Partial<AppSettings>
}

/** 从 localStorage 读取并做类型校验，非法字段回落到默认值 */
export function loadSettings(): AppSettings {
  let loaded: unknown = null
  try {
    loaded = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
  } catch {
    loaded = null
  }
  const p = partialSettings(loaded)
  const settings: AppSettings = {
    ocrIntervalMs:
      typeof p.ocrIntervalMs === 'number' &&
      Number.isFinite(p.ocrIntervalMs) &&
      p.ocrIntervalMs >= 300
        ? Math.min(p.ocrIntervalMs, 30000)
        : DEFAULT_SETTINGS.ocrIntervalMs,
    backend: p.backend === 'wasm' ? 'wasm' : 'webgpu',
    keywords: Array.isArray(p.keywords)
      ? p.keywords.filter(isKeywordRule)
      : DEFAULT_SETTINGS.keywords,
    crop: { ...DEFAULT_SETTINGS.crop, ...p.crop },
    useCustomAudio: p.useCustomAudio === true,
    customAudioName: typeof p.customAudioName === 'string' ? p.customAudioName : '',
  }
  if (settings.keywords.length === 0) settings.keywords = DEFAULT_SETTINGS.keywords
  return settings
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage 不可用时静默降级
  }
}