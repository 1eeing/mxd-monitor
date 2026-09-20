import { useRef, useState } from 'react'
import type { UseMonitor } from '../hooks/useMonitor'
import type { CropRegion } from '../types'


interface MonitorPanelProps {
  monitor: UseMonitor
  /** 当前识别区域（用于在画面上绘制轮廓；0~1 比例，相对被监控画面） */
  crop?: CropRegion
  /** 是否处于「框选识别区域」模式（在视频画面上按住拖动框出矩形） */
  cropSelecting?: boolean
  /** 框选松手后写回裁剪比例 */
  onCropChange?: (next: CropRegion) => void
  /** 框选完成/取消后退出圈选模式 */
  onCropSelectDone?: () => void
}

export function MonitorPanel({ monitor, crop, cropSelecting, onCropChange, onCropSelectDone }: MonitorPanelProps) {
  const {
    status,
    error,
    logs,
    hits,
    alarmActive,
    lastOcr,
    isCapturing,
    videoRef,
    start,
    stop,
    manuallyStopAlarm,
  } = monitor

  // —— 视频画面上框选识别区域 ——
  // 拖拽起点与实际尺寸（元素像素坐标，换算为 0~1 比例写回 settings.crop）
  const videoBoxRef = useRef<HTMLDivElement>(null)
  const [selStart, setSelStart] = useState<{ x: number; y: number } | null>(null)
  const [selEnd, setSelEnd] = useState<{ x: number; y: number } | null>(null)

  // 元素像素 → 0~1 比例（相对视频内容区域；若实际有留边会略有偏差，但足够精确）
  const toNorm = (px: number, max: number) => Math.min(1, Math.max(0, px / max))

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!cropSelecting) return
    e.preventDefault()
    const box = videoBoxRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    setSelStart({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    setSelEnd({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!cropSelecting || !selStart) return
    const box = videoBoxRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    setSelEnd({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const onPointerUp = () => {
    if (!cropSelecting || !selStart || !selEnd) return
    const box = videoBoxRef.current
    if (box) {
      const w = box.clientWidth
      const h = box.clientHeight
      if (w > 0 && h > 0) {
        const left = Math.min(selStart.x, selEnd.x)
        const top = Math.min(selStart.y, selEnd.y)
        const width = Math.abs(selEnd.x - selStart.x)
        const height = Math.abs(selEnd.y - selStart.y)
        if (width > 8 && height > 8) {
          // 至少 8px 才算有效框选，写回 0~1 比例
          const next: CropRegion = {
            ...(crop ?? { enabled: false, left: 0, top: 0, width: 1, height: 1, scale: 1 }),
            enabled: true,
            left: toNorm(left, w),
            top: toNorm(top, h),
            width: Math.min(1, toNorm(width, w)),
            height: Math.min(1, toNorm(height, h)),
          }
          onCropChange?.(next)
        }
      }
    }
    setSelStart(null)
    setSelEnd(null)
    onCropSelectDone?.()
  }

  const selectionRect =
    cropSelecting && selStart && selEnd
      ? {
          left: Math.min(selStart.x, selEnd.x),
          top: Math.min(selStart.y, selEnd.y),
          width: Math.abs(selEnd.x - selStart.x),
          height: Math.abs(selEnd.y - selStart.y),
        }
      : null

  // 已有识别区域按 0~1 比例换算成元素像素轮廓
  const cropOutline =
    crop?.enabled && videoBoxRef.current
      ? {
          left: crop.left * videoBoxRef.current.clientWidth,
          top: crop.top * videoBoxRef.current.clientHeight,
          width: crop.width * videoBoxRef.current.clientWidth,
          height: crop.height * videoBoxRef.current.clientHeight,
        }
      : null

  return (
    <div className="monitor-panel">
      <div className={`video-wrap${isCapturing ? ' capturing' : ''}`}>
        <video ref={videoRef} muted playsInline aria-label="屏幕共享预览" />

        {/* 识别区域轮廓（非圈选模式时只读展示） */}
        {cropOutline && !cropSelecting && (
          <div
            className="crop-overlay-cursor"
            style={{ left: cropOutline.left, top: cropOutline.top, width: cropOutline.width, height: cropOutline.height }}
          >
            <span className="crop-tag">识别区域</span>
          </div>
        )}

        {/* 框选图层：仅圈选模式下捕获指针；其余时间 pointer-events 关闭，不挡视频 */}
        <div
          ref={videoBoxRef}
          className={`crop-select-layer${cropSelecting ? ' active' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {selectionRect && (
            <div className="crop-select-rect" style={selectionRect}>
              <span className="crop-tag">松开完成框选</span>
            </div>
          )}
          {cropSelecting && !selectionRect && (
            <p className="crop-select-hint">在画面上按住并拖动，框出要识别的区域；松手即完成</p>
          )}
        </div>

        {status === 'idle' && (
          <div className="video-placeholder">
            <p>尚未开始监控</p>
            <p className="hint">点击下方「开始监控」，在弹出的窗口选择器中选择冒险岛游戏窗口</p>
          </div>
        )}
        {status === 'initializing' && (
          <div className="video-placeholder">
            <p>正在初始化 …</p>
            <p className="hint">加载 OCR 模型并进行首帧识别，请稍候</p>
          </div>
        )}
        {status === 'error' && (
          <div className="video-placeholder error">
            <p>❌ 启动失败</p>
            <p className="hint" title={error ?? ''}>
              {error ?? '未知错误'}
            </p>
          </div>
        )}
      </div>

      {status === 'running' && (
        <>
          <div className="hit-area">
            {hits.length > 0 ? (
              <ul className="hit-list">
                {hits.map((hit) => (
                  <li key={hit.rule.id} className="hit-item">
                    <span className="hit-label">{hit.rule.label}</span>
                    <span className="hit-snippet">{hit.snippet}</span>
                    <span className="hit-score">置信度 {(hit.score * 100).toFixed(0)}%</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hit-none">最近一次识别未命中关键字</p>
            )}
          </div>
          <div className="ocr-debug">
            <h3>最近识别结果</h3>
            <p className="ocr-lines">{lastOcr || '等待首帧识别…'}</p>
            {!lastOcr && (
              <p className="hint">
                若长时间无结果：确认关键字文字在画面可见区域；或在设置中启用「识别区域」在画面上框选以提高准确率
              </p>
            )}
          </div>
          <div className="controls">
            {alarmActive ? (
              <button className="btn danger" onClick={manuallyStopAlarm}>
                停止报警
              </button>
            ) : null}
            <button className="btn primary" onClick={stop}>
              ⏹ 停止监控
            </button>
          </div>
        </>
      )}

      {status === 'idle' && (
        <div className="controls">
          <button className="btn primary big" onClick={() => void start()}>
            ▶ 开始监控
          </button>
        </div>
      )}

      {status === 'error' && (
        <div className="controls">
          <button className="btn primary" onClick={() => void start()}>
            ↻ 重试
          </button>
        </div>
      )}

      <div className="log-area">
        <h3>运行日志</h3>
        <ul className="log-list">
          {logs.map((log) => (
            <li key={log.id} className={`log log-${log.kind}`}>
              <span className="log-time">{log.time}</span>
              <span className="log-msg">{log.message}</span>
            </li>
          ))}
          {logs.length === 0 && <li className="log log-info">尚无日志</li>}
        </ul>
      </div>
    </div>
  )
}
