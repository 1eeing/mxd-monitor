/**
 * 「连接手机」弹窗：展示二维码、连接状态、报警音频同步状态。
 *
 * 二维码内容是手机页的完整地址，由 PC 页面自己生成（不依赖服务端打印到控制台），
 * 这样用户不用去翻终端输出来拼地址。
 */
import { useEffect, useMemo } from 'react'
import { buildQr } from '../lan/qr'
import type { UseLanMirror } from '../lan/useLanMirror'

export interface LanMirrorModalProps {
  mirror: UseLanMirror
  onClose: () => void
}

export function LanMirrorModal({ mirror, onClose }: LanMirrorModalProps) {
  const { active, phoneCount, signaling, phoneUrl, urlProblem, error, audioReady } = mirror

  // 二维码依赖地址，算一次就够；地址不会在弹窗打开期间变化
  const qr = useMemo(() => (phoneUrl ? buildQr(phoneUrl) : null), [phoneUrl])

  // 弹窗开着时按 Esc 关闭，和设置弹窗的行为保持一致
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal lan-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="lan-title">📱 连接手机</h3>

        {!active ? (
          <>
            <p className="hint">
              开启后，手机与本机连同一个 WiFi，用相机扫下面的二维码就能在手机上接收报警。
              视频会以低帧率低码率转发，不影响游戏。
            </p>
            <p className="hint">⚠ 需要先用 <code>npm run lan</code> 启动本地服务，手机才能扫到地址。</p>
            {!window.isSecureContext && (
              <div className="lan-warn">
                ⚠ 当前页面不是安全上下文，浏览器会禁用屏幕采集，「开始监控」会直接失败
                （<code>getDisplayMedia</code> 不存在）。请改用 <code>http://localhost:5199/</code> 打开本页；
                二维码里仍然是局域网地址，手机照扫不误。
              </div>
            )}
            <div className="modal-footer">
              <button type="button" className="btn ghost" onClick={onClose}>
                取消
              </button>
              <button type="button" className="btn primary" onClick={mirror.connect}>
                开启镜像
              </button>
            </div>
          </>
        ) : (
          <>
            {urlProblem ? (
              <div className="lan-warn">⚠ {urlProblem}</div>
            ) : qr ? (
              <div className="lan-qr-wrap">
                <svg
                  className="lan-qr"
                  viewBox={`0 0 ${qr.viewBox} ${qr.viewBox}`}
                  shapeRendering="crispEdges"
                  role="img"
                  aria-label="手机端地址二维码"
                >
                  <path d={qr.path} fill="currentColor" />
                </svg>
              </div>
            ) : (
              <div className="lan-warn">二维码生成失败：地址过长或内容不可编码</div>
            )}

            {phoneUrl && <div className="lan-url">{phoneUrl}</div>}

            <div className="lan-status">
              <span className={`lan-dot ${signaling ? 'on' : 'off'}`} />
              {signaling ? '已连上本地镜像服务' : '正在连接本地镜像服务…'}
            </div>
            <div className="lan-status">
              <span className={`lan-dot ${phoneCount > 0 ? 'on' : 'off'}`} />
              {phoneCount > 0 ? `已连接 ${phoneCount} 台手机` : '等待手机扫码…'}
            </div>
            <div className="lan-status">
              <span className={`lan-dot ${audioReady ? 'on' : 'off'}`} />
              {audioReady ? '报警音频已同步' : '报警音频未同步（手机会用默认提示音）'}
            </div>

            {error && <div className="lan-error">{error}</div>}

            <div className="hint">
              手机端需要保持这个页面在后台或锁屏状态下打开才能持续接收。若手机系统回收了页面，重新扫一次码即可。
            </div>

            <div className="modal-footer">
              <button type="button" className="btn ghost" onClick={() => void mirror.refreshAudio()}>
                重新同步音频
              </button>
              <button type="button" className="btn danger" onClick={mirror.disconnect}>
                关闭镜像
              </button>
              <button type="button" className="btn primary" onClick={onClose}>
                完成
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
