# Changelog

本文件记录 mxd-monitor（纯浏览器《冒险岛》监控，React + Vite + TypeScript + PP-OCRv4/onnxruntime-web）的变更。

## [未发布] — 2026-09-28

### 修复
- **修复后台漏报**：识别心跳改由 Web Worker 驱动，并补齐「监控失活」的可见性。
  - 根因：隐藏页面约 5 分钟后，主线程 `setInterval` 被 Chrome 限流至约每分钟一次
    （实测 300ms 间隔下后台仅 0.91Hz），数秒内出现的测谎弹窗被整段错过。
  - 心跳迁至 Web Worker（`hooks/useWorkerTicker` + `workers/ticker.worker`），
    实测后台 3.33Hz 不降频；Worker 创建失败时退回主线程并记录 error 日志，不再静默降级。
  - OCR 调用增加 15s 超时（`OCR_TIMEOUT_MS`）：ONNX 设备丢失后 `detect` 既不
    resolve 也不 reject，会将 `busyRef` 永久卡死且无任何痕迹。
  - 超时后不发起新识别，交由 90s 存活看门狗（`MONITOR_STALL_MS`）将「监控已失活」
    显示为红色横幅。
  - 新增画面冻结检测：`video.currentTime` 连续 3 帧不推进即告警，覆盖页面被浏览器
    冻结 / 共享源被最小化挂起的情况。
  - 报警音播放失败不再吞掉异常，改为 error 日志，避免界面显示「报警中」却毫无声音。
  - 手动停止 / 共享中断 / 重新开始时统一重置超时、失活与冻结计数。
  - 影响文件：`src/hooks/useMonitor.ts`、`src/hooks/useWorkerTicker.ts`(新)、
    `src/workers/ticker.worker.ts`(新)、`src/config.ts`、`src/audio/player.ts`、
    `src/components/MonitorPanel.tsx`、`src/index.css`（+310 / -34）

## [2026-09-20]

### 变更
- `0731205` feat: 设置改弹窗（主界面恒为监控画面）+ 画面上拖拽框选识别区 +
  默认报警音频 `sound.mp3`
- `35d2afa` fix: 修复屏幕共享被误停、圈选区域错位，优化报警与设置面板
- `e860f07` perf: WASM 大文件改国内 CDN 加载，解决 EdgeOne 免费版单文件 25MB 限制
- `d9d2c45` feat: 白色主题与设置文案层级，取消窗口选择回空闲状态，初始化显示加载进度条
- `8d1c1f7` chore: 移除无用鸡叫合成脚本，README 同步更新
