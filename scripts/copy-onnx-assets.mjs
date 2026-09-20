/**
 * 将 onnxruntime-web 运行时所需的 wasm/mjs 拷贝到 public/onnx/（应用内本地托管，离线可用）。
 *
 * onnxruntime-web v1.30：
 * - WASM(CPU) 后端按 wasmPaths='/onnx/' 本地加载 ort-wasm-simd-threaded.mjs/.wasm；
 * - WebGPU(jsep) 的 ort-wasm-simd-threaded.jsep.*(28MB) 超过 EdgeOne Makers 免费版
 *   单文件 25MB 上限，改为从 npmmirror CDN 加载（见 src/ocr/engine.ts），不拷贝进站点。
 *
 * 运行：node scripts/copy-onnx-assets.mjs
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'node_modules', 'onnxruntime-web', 'dist')
const destDir = join(here, '..', 'public', 'onnx')

// 仅 WASM(CPU) 路径留一对 .mjs+.wasm；asyncify/jspi 特殊模式暂不需要
const files = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
]

mkdirSync(destDir, { recursive: true })
for (const file of files) {
  const src = join(srcDir, file)
  const dest = join(destDir, file)
  copyFileSync(src, dest)
  const size = (statSync(dest).size / 1024 / 1024).toFixed(1)
  console.log(`copied ${file} (${size} MB)`)
}
console.log('done')