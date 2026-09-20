/**
 * 将 onnxruntime-web 运行时所需的 wasm/mjs 拷贝到 public/onnx/（应用内本地托管，离线可用）。
 *
 * onnxruntime-web v1.30 的 WebGPU(jsep)/WASM 后端会按 ort.env.wasm.wasmPaths('/onnx/')
 * 动态 import 对应的 .mjs 加载器并拉取 .wasm 二进制，因此两者都要拷贝。
 *
 * 运行：node scripts/copy-onnx-assets.mjs
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'node_modules', 'onnxruntime-web', 'dist')
const destDir = join(here, '..', 'public', 'onnx')

// WebGPU(jsep) 与 WASM 两条路径各一对 .mjs+.wasm；asyncify/jspi 特殊模式暂不需要
const files = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
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