import { useState } from 'react'
import type { AppSettings, KeywordRule, MatchedKeyword } from '../types'
import { DEFAULT_ALARM_AUDIO } from '../config'
import { putFile, deleteFile, getFile } from '../utils/blobStore'
import { findKeywordMatches } from '../utils/match'
import type { OcrTextLine } from '../utils/match'

interface SettingsPanelProps {
  settings: AppSettings
  onChange: (next: AppSettings) => void
  onStartCropSelect: () => void
}

/** 自定义报警音频存入 IndexedDB 的 key（blobStore 本身不导出该常量，故在此局部声明） */
const CUSTOM_AUDIO_KEY = 'custom-alarm-audio'

export function SettingsPanel({ settings, onChange, onStartCropSelect }: SettingsPanelProps) {
  const update = (patch: Partial<AppSettings>): void => onChange({ ...settings, ...patch })

  // ---------- 关键字编辑 ----------
  const updateKeyword = (id: string, patch: Partial<KeywordRule>): void =>
    onChange({
      ...settings,
      keywords: settings.keywords.map((k) => (k.id === id ? { ...k, ...patch } : k)),
    })

  const addKeyword = (): void =>
    update({
      keywords: [
        ...settings.keywords,
        { id: String(Date.now()), label: '', pattern: '', enabled: true },
      ],
    })

  const removeKeyword = (id: string): void =>
    update({ keywords: settings.keywords.filter((k) => k.id !== id) })

  // 关键字测试：输入一段文本，实时看哪些规则会命中
  const [testText, setTestText] = useState('')
  const testLines: OcrTextLine[] = [{ text: testText, score: 100 }]
  const testMatches: MatchedKeyword[] = findKeywordMatches(testLines, settings.keywords)

  // ---------- 识别区域（画面上框选） ----------
  const toggleCropEnabled = (enabled: boolean): void =>
    update({ crop: { ...settings.crop, enabled } })

  const updateCropScale = (scale: number): void =>
    update({ crop: { ...settings.crop, scale } })

  // ---------- 报警音频 ----------
  const [testingAudio, setTestingAudio] = useState(false)
  const [customAudioTestUrl, setCustomAudioTestUrl] = useState('')

  const stopAudioTest = (): void => {
    setTestingAudio(false)
    setCustomAudioTestUrl('')
  }

  const testDefaultAudio = (): void => {
    const audio = new Audio(DEFAULT_ALARM_AUDIO)
    setTestingAudio(true)
    void audio.play().catch(stopAudioTest)
    audio.onended = stopAudioTest
    audio.onerror = stopAudioTest
  }

  const testCustomAudio = async (): Promise<void> => {
    const blob = await getFile(CUSTOM_AUDIO_KEY)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    setCustomAudioTestUrl(url)
    setTestingAudio(true)
    void audio.play().catch(stopAudioTest)
    audio.onended = () => {
      URL.revokeObjectURL(url)
      stopAudioTest()
    }
    audio.onerror = () => {
      URL.revokeObjectURL(url)
      stopAudioTest()
    }
  }

  const handleCustomAudioFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    await putFile(CUSTOM_AUDIO_KEY, file)
    update({ useCustomAudio: true, customAudioName: file.name })
  }

  const removeCustomAudio = async (): Promise<void> => {
    await deleteFile(CUSTOM_AUDIO_KEY)
    if (customAudioTestUrl) URL.revokeObjectURL(customAudioTestUrl)
    update({ useCustomAudio: false, customAudioName: '' })
  }

  const customAudioExists = settings.useCustomAudio && settings.customAudioName.length > 0

  return (
    <div className="settings-panel">
      {/* 识别区域 */}
      <section className="settings-section">
        <h2>🎯 识别区域</h2>
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.crop.enabled}
            onChange={(e) => toggleCropEnabled(e.target.checked)}
          />
          启用识别区域（只在画面左上区域内识别，减少误报、加快识别）
        </label>

        {settings.crop.enabled && (
          <div className="crop-settings">
            <button type="button" className="btn primary small" onClick={onStartCropSelect}>
              🖱 在画面上框选识别区域
            </button>
            <p className="hint">点击后关闭本弹窗，回到监控画面，按住鼠标左键在视频上拖拽框选；松手即生效。</p>
            <label className="row">
              <span>识别放大倍率</span>
              <select
                value={settings.crop.scale}
                onChange={(e) => updateCropScale(Number(e.target.value))}
              >
                <option value={1}>1×</option>
                <option value={2}>2×</option>
                <option value={3}>3×</option>
                <option value={4}>4×</option>
              </select>
              <span className="hint">倍率越高小字越清晰，但更耗性能</span>
            </label>
          </div>
        )}
      </section>

      {/* 关键字规则 */}
      <section className="settings-section">
        <h2>🔑 报警关键字</h2>
        <div className="keyword-list">
          {settings.keywords.map((rule) => (
            <div key={rule.id} className="keyword-row">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => updateKeyword(rule.id, { enabled: e.target.checked })}
                title={rule.enabled ? '启用' : '停用'}
              />
              <input
                type="text"
                className="kw-label"
                value={rule.label}
                placeholder="备注名"
                onChange={(e) => updateKeyword(rule.id, { label: e.target.value })}
              />
              <input
                type="text"
                className="kw-pattern"
                value={rule.pattern}
                placeholder="关键字或正则，如 稀有 或 ^组队邀请 $"
                onChange={(e) => updateKeyword(rule.id, { pattern: e.target.value })}
              />
              <button
                type="button"
                className="btn ghost small"
                onClick={() => removeKeyword(rule.id)}
                title="删除该规则"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn ghost small" onClick={addKeyword}>
          ＋ 添加关键字
        </button>

        <div className="test-area">
          <h3>测试</h3>
          <textarea
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder="粘贴一段 OCR 会识别到的文本，试一下哪些关键字会命中…"
            rows={3}
          />
          {testMatches.length > 0 ? (
            <div className="test-result hit">
              <p>✅ 命中 {testMatches.length} 条规则：</p>
              <ul>
                {testMatches.slice(0, 5).map((m) => (
                  <li key={m.rule.id}>
                    {m.rule.label || m.rule.pattern}
                    <span className="snippet">「{m.snippet}」</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="test-result clean">（没有命中）</p>
          )}
        </div>
      </section>

      {/* 报警音频 */}
      <section className="settings-section">
        <h2>🔔 报警音频</h2>

        <label className="radio-row">
          <input
            type="radio"
            name="alarm-audio"
            checked={!settings.useCustomAudio}
            onChange={() => update({ useCustomAudio: false, customAudioName: '' })}
          />
          使用默认音频（<code>{DEFAULT_ALARM_AUDIO}</code>）
          {!settings.useCustomAudio && (
            <button type="button" className="btn ghost tiny" onClick={testDefaultAudio}>
              {testingAudio ? '播放中…' : '▶ 试听'}
            </button>
          )}
        </label>

        <label className="radio-row">
          <input
            type="radio"
            name="alarm-audio"
            checked={settings.useCustomAudio}
            onChange={() => update({ useCustomAudio: true, customAudioName: settings.customAudioName })}
          />
          使用自定义音频
        </label>

        <div className="custom-audio">
          <label className="btn ghost small upload-btn">
            上传自定义音频
            <input
              type="file"
              accept="audio/*"
              style={{ display: 'none' }}
              onChange={(e) => void handleCustomAudioFile(e.target.files?.[0])}
            />
          </label>
          {customAudioExists && (
            <>
              <span className="custom-audio-name">{settings.customAudioName}</span>
              <button type="button" className="btn ghost tiny" onClick={() => void testCustomAudio()}>
                ▶ 试听
              </button>
              <button type="button" className="btn ghost tiny danger" onClick={() => void removeCustomAudio()}>
                删除
              </button>
            </>
          )}
          {!customAudioExists && settings.useCustomAudio && (
            <span className="hint">尚未上传自定义音频</span>
          )}
        </div>

        {testingAudio && !customAudioTestUrl && (
          <p className="hint">正在播放…</p>
        )}
      </section>
    </div>
  )
}
