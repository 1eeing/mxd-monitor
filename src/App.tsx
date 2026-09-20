import { useEffect, useState } from 'react'
import type { AppSettings, CropRegion } from './types'
import { loadSettings, saveSettings } from './settings'
import { useMonitor } from './hooks/useMonitor'
import { MonitorPanel } from './components/MonitorPanel'
import { SettingsPanel } from './components/SettingsPanel'

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  // 设置改为弹窗：默认关闭，点击头部「⚙ 设置」打开
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 「在画面上框选识别区域」模式：进入后关闭弹窗，回到监控画面按住拖动圈选
  const [cropSelecting, setCropSelecting] = useState(false)

  const monitor = useMonitor(settings)

  // 设置变化即持久化
  useEffect(() => {
    saveSettings(settings)
  }, [settings])

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
        <button
          type="button"
          className="btn ghost small"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙ 设置
        </button>
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
