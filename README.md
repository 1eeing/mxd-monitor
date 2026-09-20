# 冒险岛监控（mxd-monitor）

一个纯浏览器运行的《冒险岛》屏幕监控工具：通过屏幕共享选择游戏窗口 → 定时 OCR 识别 →
正则匹配关键字 → 命中即播放报警音。

## 功能

- **窗口采集**：点击「开始监控」后调用 `getDisplayMedia`，在系统窗口选择器中选中冒险岛窗口即可
- **OCR 识别**：PaddleOCR PP-OCRv4 中文模型（`@gutenye/ocr-browser` + ONNX Runtime）
  - `webgpu`：GPU 加速（Chrome 113+，默认）
  - `wasm`：CPU 回退
  - 识别间隔可在页面设置（默认 1500ms）
- **关键字 / 正则**：多条规则，每条支持正则表达式（`i` 模式），任一命中即报警
- **报警**：命中期间循环播放报警音；连续 N 帧（默认 2 帧）未识别到关键字自动停止；可手动停止
- **设置面板**：识别间隔、引擎切换、关键字管理 + 正则测试、识别区域裁剪、报警音（默认内置鸡叫 / 自定义上传，IndexedDB 持久化）

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5173
```

其他命令：`npm run typecheck`（tsc -b）、`npm run build`、`npm run lint`、`npm run preview`。

## 目录结构

```
public/
  models/           # PP-OCRv4 中文检测/识别模型 + 字典（约 15MB）
  onnx/             # onnxruntime-web 的 wasm/mjs（本地托管，离线可用，见 scripts/copy-onnx-assets.mjs）
  audio/            # 内置鸡叫报警音（程序合成，见 scripts/generate-rooster.mjs）
src/
  ocr/engine.ts     # OCR 引擎封装（WebGPU/WASM）
  hooks/            # useScreenCapture（屏幕共享）、useMonitor（识别循环/报警）
  utils/            # 正则匹配、帧截取、IndexedDB 存储
  components/       # MonitorPanel、SettingsPanel
  vendor/           # js-clipper 转码副本（原包含非 UTF-8 字节，见 scripts/fix-js-clipper.mjs）
scripts/            # 鸡叫合成、js-clipper 修复、onnx 资源拷贝脚本
```

## 技术要点

- 模型来源：[gutenye/ocr](https://github.com/gutenye/ocr)（MIT）PP-OCRv4 中文模型（Apache-2.0），
  本地放置于 `public/models`
- `js-clipper` 原包 `clipper.js` 含非法 UTF-8 字节导致生产构建失败，已通过
  `scripts/fix-js-clipper.mjs` 转码为 `src/vendor/js-clipper/clipper.js` 并在 `vite.config.ts` 中别名引用
- onnxruntime-web 运行时会动态加载 `ort-wasm-simd-threaded.jsep.mjs` 等加载器：`scripts/copy-onnx-assets.mjs`
  负责把 `.mjs`/`.wasm` 同步到 `public/onnx`。dev 模式下 Vite 8 会给运行时动态 import 注入 `?import`
  查询，导致 public 文件被误拦截，已通过 `vite.config.ts` 的 `servePublicOnnxInDev` 中间件剥查询处理
- 冒烟：WebGPU 需要 Chrome 113+ 且 GPU 支持；若初始化失败可在设置中切换 WASM（已开启跨源隔离头）