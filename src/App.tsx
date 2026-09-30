import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, CropRegion } from './types'
import { loadSettings, saveSettings } from './settings'
import { useMonitor } from './hooks/useMonitor'
import { useLanMirror } from './lan/useLanMirror'
import { LanMirrorModal } from './lan/LanMirrorModal'
import { MonitorPanel } from './components/MonitorPanel'
import { SettingsPanel } from './components/SettingsPanel'

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  // 设置改为弹窗：默认关闭，点击头部「⚙ 设置」打开
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 「在画面上框选识别区域」模式：进入后关闭弹窗，回到监控画面按住拖动圈选
  const [cropSelecting, setCropSelecting] = useState(false)
  // 局域网手机镜像：弹窗默认关闭
  const [lanOpen, setLanOpen] = useState(false)

  const monitor = useMonitor(settings)

  // getStream 用 ref 读采集流：采集流存在 useMonitor 的 ref 里，
  // 而 ref 的变化不会触发渲染，所以由 capturing 作为依赖来驱动。
  const mirror = useLanMirror({
    alarmActive: monitor.alarmActive,
    status: monitor.status,
    stalled: monitor.stalled,
    capturing: monitor.isCapturing,
    hits: monitor.hits,
    lastOcr: monitor.lastOcr,
    logs: monitor.logs,
    getStream: useCallback(() => monitor.streamRef.current, [monitor.streamRef]),
  })

  // 设置变化即持久化
  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // 报警音源变了（换自定义音频 / 清空）就重新同步给手机，否则手机还在放旧的。
  // 依赖里不能用 mirror 对象本身：它每次渲染都是新对象，会让这个 effect 每帧都跑。
  const { active: mirrorActive, refreshAudio } = mirror
  useEffect(() => {
    if (mirrorActive) void refreshAudio()
  }, [settings.useCustomAudio, settings.customAudioName, mirrorActive, refreshAudio])

  // 设置面板里点「框选识别区域」→ 关闭弹窗，进入画面上框选模式
  const handleStartCropSelect = (): void => {
    setSettingsOpen(false)
    setCropSelecting(true)
  }

  // 框选松手写回裁剪比例
  const handleCropChange = (next: CropRegion): void => {
    setSettings((s) => ({ ...s, crop: next }))
  }

  const handleCropSelectDone = (): void => {
    setCropSelecting(false)
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>🐔 冒险岛监控</h1>
        <div className="header-actions">
          <button
            type="button"
            className="btn ghost small"
            onClick={() => setLanOpen(true)}
          >
            📱 连接手机
            {mirror.phoneCount > 0 && <span className="header-badge">{mirror.phoneCount}</span>}
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙ 设置
          </button>
        </div>
      </header>

      <main className="app-main">
        {/* 监控面板是唯一常驻页面（不再有 tab 切换），<video> 始终挂载，避免黑屏、识别停摆 */}
        <MonitorPanel
          monitor={monitor}
          crop={settings.crop}
          cropSelecting={cropSelecting}
          onCropChange={handleCropChange}
          onCropSelectDone={handleCropSelectDone}
        />
      </main>

      {/* 局域网镜像弹窗（模态覆盖） */}
      {lanOpen && <LanMirrorModal mirror={mirror} onClose={() => setLanOpen(false)} />}

      {/* 设置弹窗（模态覆盖，关闭时卸载；不影响下方常驻的监控面板） */}
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <SettingsPanel
              settings={settings}
              onChange={setSettings}
              onStartCropSelect={handleStartCropSelect}
            />
            <div className="modal-footer">
              <button type="button" className="btn primary" onClick={() => setSettingsOpen(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
