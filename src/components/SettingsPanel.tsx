import { useEffect, useRef, useState } from 'react'
import type { AppSettings, KeywordRule, MatchedKeyword } from '../types'
import { CUSTOM_ALARM_AUDIO_KEY, DEFAULT_ALARM_AUDIO } from '../config'
import { putFile, deleteFile, getFile } from '../utils/blobStore'
import { probePlayable } from '../audio/player'
import { findKeywordMatches } from '../utils/match'
import type { OcrTextLine } from '../utils/match'

interface SettingsPanelProps {
  settings: AppSettings
  onChange: (next: AppSettings) => void
  onStartCropSelect: () => void
}

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
  const [savingAudio, setSavingAudio] = useState(false)
  /** 报警音相关的问题（选不了文件 / 存不进去 / 播不了），就地显示而不是静默失败 */
  const [audioError, setAudioError] = useState<string | null>(null)
  // 保存当前试听中的 audio 元素与 blob URL，以便随时暂停/停止
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const previewUrlRef = useRef('')

  const stopAudioTest = (): void => {
    const audio = previewAudioRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
      audio.onended = null
      audio.onerror = null
      previewAudioRef.current = null
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = ''
    }
    setTestingAudio(false)
  }

  // 弹窗关闭/组件卸载时停止试听，避免残留播放
  useEffect(() => {
    return () => {
      const audio = previewAudioRef.current
      if (audio) audio.pause()
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  const testDefaultAudio = (): void => {
    if (testingAudio) {
      stopAudioTest()
      return
    }
    const audio = new Audio(DEFAULT_ALARM_AUDIO)
    previewAudioRef.current = audio
    setTestingAudio(true)
    void audio.play().catch(stopAudioTest)
    audio.onended = stopAudioTest
    audio.onerror = stopAudioTest
  }

  /**
   * 允许的扩展名。
   *
   * 不能只靠 accept="audio/*"：不少 ogg/opus 文件的 MIME 是 application/ogg 或空串
   * （改过名、从某些站点下的），Chrome 的 audio/* 过滤器会直接把它们从选择器里隐藏，
   * 用户看到的就是「打不开这个文件」。这里把扩展名显式列出来兜住。
   */
  const AUDIO_EXT = ['.mp3', '.ogg', '.oga', '.opus', '.wav', '.m4a', '.aac', '.flac', '.webm']

  /** 报警音体积上限：只需要几秒声音，10MB 足够；超大文件写 IndexedDB 容易触发配额失败 */
  const MAX_AUDIO_BYTES = 10 * 1024 * 1024

  const testCustomAudio = async (): Promise<void> => {
    if (testingAudio) {
      stopAudioTest()
      return
    }
    setAudioError(null)
    try {
      const blob = await getFile(CUSTOM_ALARM_AUDIO_KEY)
      if (!blob) {
        setAudioError('找不到已保存的自定义音频，请重新上传')
        return
      }
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      previewAudioRef.current = audio
      previewUrlRef.current = url
      setTestingAudio(true)
      // 之前这里只 stopAudioTest，把「为什么播不了」整个吞掉：
      // 编码不支持、文件损坏、blob 丢失，用户看到的只有「按了没反应」。
      audio.onended = stopAudioTest
      audio.onerror = () => {
        stopAudioTest()
        setAudioError('这个音频无法播放：文件可能已损坏，或浏览器不支持其编码格式')
      }
      await audio.play()
    } catch (err) {
      stopAudioTest()
      setAudioError(`试听失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleCustomAudioFile = async (file: File | undefined, input: HTMLInputElement): Promise<void> => {
    // 先清空 input.value：同一个文件重选时 change 事件不会触发，
    // 用户「再选一次修复」会毫无反应，只能刷新页面。
    input.value = ''
    if (!file) return

    const lower = file.name.toLowerCase()
    if (!AUDIO_EXT.some((ext) => lower.endsWith(ext))) {
      setAudioError(`不支持的文件类型：${file.name}。请选择 ${AUDIO_EXT.join(' / ')}`)
      return
    }
    if (file.size > MAX_AUDIO_BYTES) {
      setAudioError(
        `文件太大（${(file.size / 1024 / 1024).toFixed(1)}MB）。报警音只需要几秒，请压缩到 ${MAX_AUDIO_BYTES / 1024 / 1024}MB 以内`,
      )
      return
    }

    setSavingAudio(true)
    setAudioError(null)
    try {
      // 存库之前先确认浏览器真能解码。Chrome 不会为无法解码的文件抛错，
      // 只会触发 onerror——不预检的话，坏文件会被正常保存并选中，
      // 直到某次报警才哑掉，那时已经查不出是哪个文件的问题了。
      const probe = await probePlayable(file)
      if (!probe.ok) {
        setAudioError(`无法播放「${file.name}」：${probe.reason}。请换一个浏览器能直接播放的音频文件`)
        return
      }
      await putFile(CUSTOM_ALARM_AUDIO_KEY, file)
      update({ useCustomAudio: true, customAudioName: file.name })
    } catch (err) {
      // 之前整条链路是 void 调用的，putFile 失败（配额超限、隐私模式禁用 IndexedDB）
      // 会变成一个没人接的 rejection：界面毫无反馈，用户只看到「点了没反应」。
      setAudioError(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSavingAudio(false)
    }
  }

  const removeCustomAudio = async (): Promise<void> => {
    stopAudioTest()
    setAudioError(null)
    try {
      await deleteFile(CUSTOM_ALARM_AUDIO_KEY)
    } catch (err) {
      setAudioError(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
    update({ useCustomAudio: false, customAudioName: '' })
  }

  const customAudioExists = settings.useCustomAudio && settings.customAudioName.length > 0

  return (
    <div className="settings-panel">
      {/* 识别参数：间隔 + 计算引擎 */}
      <section className="settings-section">
        <h2>⚙️ 识别参数</h2>
        <label className="row">
          <span className="field-label">识别间隔</span>
          <input
            type="range"
            min={300}
            max={5000}
            step={100}
            value={settings.ocrIntervalMs}
            onChange={(e) => update({ ocrIntervalMs: Number(e.target.value) })}
          />
          <span className="field-value">{(settings.ocrIntervalMs / 1000).toFixed(1)}s</span>
          <span className="hint">每次截图并 OCR 的间隔，越小越灵敏、越耗性能</span>
        </label>

        <div className="row">
          <span className="field-label">计算引擎</span>
          <label className="radio-row">
            <input
              type="radio"
              name="ocr-backend"
              checked={settings.backend === 'webgpu'}
              onChange={() => update({ backend: 'webgpu' })}
            />
            GPU 计算（WebGPU）
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="ocr-backend"
              checked={settings.backend === 'wasm'}
              onChange={() => update({ backend: 'wasm' })}
            />
            CPU 计算（WASM）
          </label>
        </div>
        <p className="hint">
          GPU 需要 Chrome 113+ 且显卡支持；若 WebGPU 初始化失败，切到 CPU 计算即可。修改后下次「开始监控」生效。
        </p>
      </section>

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
              <span className="field-label">识别放大倍率</span>
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
            onChange={() => {
              setAudioError(null)
              stopAudioTest()
              update({ useCustomAudio: false, customAudioName: '' })
            }}
          />
          使用默认音频（<code>{DEFAULT_ALARM_AUDIO}</code>）
          {!settings.useCustomAudio && (
            <button type="button" className="btn ghost tiny" onClick={testDefaultAudio}>
              {testingAudio ? '⏹ 停止试听' : '▶ 试听'}
            </button>
          )}
        </label>

        <label className="radio-row">
          <input
            type="radio"
            name="alarm-audio"
            checked={settings.useCustomAudio}
            onChange={() => {
              setAudioError(null)
              update({ useCustomAudio: true, customAudioName: settings.customAudioName })
            }}
          />
          使用自定义音频
        </label>

        <div className="custom-audio">
          <label className="btn ghost small upload-btn">
            {savingAudio ? '正在检查…' : '上传自定义音频'}
            <input
              type="file"
              /* 显式列出扩展名：只写 audio/* 时，MIME 为 application/ogg 或空的
                 ogg/opus 文件会在选择器里被隐藏，用户反馈就是「打不开」 */
              accept={`audio/*,${AUDIO_EXT.join(',')}`}
              style={{ display: 'none' }}
              onChange={(e) => {
                const input = e.target
                const file = input.files?.[0]
                void handleCustomAudioFile(file, input)
              }}
            />
          </label>
          {customAudioExists && (
            <>
              <span className="custom-audio-name">{settings.customAudioName}</span>
              <button type="button" className="btn ghost tiny" onClick={() => void testCustomAudio()}>
                {testingAudio ? '⏹ 停止试听' : '▶ 试听'}
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

        {audioError && <p className="hint audio-error">{audioError}</p>}

        {testingAudio && (
          <p className="hint">正在播放…（再次点击「停止试听」可停止）</p>
        )}
      </section>
    </div>
  )
}
