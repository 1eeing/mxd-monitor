# 冒险岛监控（mxd-monitor）

一个纯浏览器运行的《冒险岛》屏幕监控工具：通过屏幕共享选择游戏窗口 → 定时 OCR 识别 →
正则匹配关键字 → 命中即播放报警音。

## 功能

- **窗口采集**：点击「开始监控」后调用 `getDisplayMedia`，在系统窗口选择器中选中冒险岛窗口即可
- **OCR 识别**：PaddleOCR PP-OCRv4 中文模型（`@gutenye/ocr-browser` + ONNX Runtime）
  - `webgpu`：GPU 加速（Chrome 113+，默认）
  - `wasm`：CPU 回退
  - 识别间隔可在页面设置（默认 1500ms）；启动时后台下载 OCR 资源，界面显示实时进度条
- **关键字 / 正则**：多条规则，每条支持正则表达式（`i` 模式），任一命中即报警；设置面板可实时测试命中
- **识别区域**：在视频画面上按住拖拽框选想监控的区域（保存为相对比例并自动扣除画面留边），只在框内识别以减少误报
- **报警**：命中期间循环播放报警音；连续 N 帧（默认 2 帧）未识别到关键字自动停止；可手动停止
- **设置面板**：识别间隔、引擎切换、关键字管理 + 正则测试、识别区域框选、报警音（默认 `/audio/sound.mp3` / 自定义上传，IndexedDB 持久化）

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
  onnx/             # onnxruntime-web CPU(WASM) 后端的 wasm/mjs（本地托管，见 scripts/copy-onnx-assets.mjs）
  audio/            # 默认报警音 sound.mp3（自行放入）
src/
  ocr/engine.ts     # OCR 引擎封装（WebGPU/WASM；进度回调见下）
  hooks/            # useScreenCapture（屏幕共享）、useMonitor（识别循环/报警/加载进度）
  utils/            # 正则匹配、帧截取、IndexedDB 存储
  components/       # MonitorPanel、SettingsPanel
  vendor/           # js-clipper 编码修复副本（原包含非法 UTF-8 字节，见 scripts/fix-js-clipper.mjs）
scripts/            # onnx 资源同步、js-clipper 编码修复、构建后瘦身脚本
```

## 技术要点

- 模型来源：[gutenye/ocr](https://github.com/gutenye/ocr)（MIT）PP-OCRv4 中文模型（Apache-2.0），
  本地放置于 `public/models`
- `js-clipper` 原包 `clipper.js` 含非法 UTF-8 字节导致生产构建失败，已通过
  `scripts/fix-js-clipper.mjs` 转码为 `src/vendor/js-clipper/clipper.js` 并在 `vite.config.ts` 中别名引用
- onnxruntime-web 运行时要依赖 wasm 文件：CPU(WASM) 后端从 `public/onnx` 本地加载
  （`scripts/copy-onnx-assets.mjs` 负责从 node_modules 同步 `.mjs`/`.wasm` 到该目录）；
  WebGPU(jsep) 后端的 `ort-wasm-simd-threaded.jsep.wasm` 超过 25MB，不可内联进站点
  （EdgeOne Makers 免费版有单文件大小上限），因此改为从 npmmirror CDN 加载，
  构建后由 `scripts/strip-ort-assets.mjs` 清掉误混入 `dist` 的 jsep 大文件
- 初始化时会拦截全局 `fetch` 统计 wasm/模型/字典的下载字节，折算成加载进度条显示
  （见 `src/ocr/engine.ts` 的 `trackDownloadProgress`）
- dev 模式下 Vite 8 会给运行时动态 import 注入 `?import` 查询，导致 public 文件被误拦截，
  已通过 `vite.config.ts` 的 `servePublicOnnxInDev` 中间件剥查询处理
- 冒烟：WebGPU 需要 Chrome 113+ 且 GPU 支持；若初始化失败可在设置中切换 WASM（已开启跨源隔离头）