/**
 * 构建后处理（两步）：
 *
 * 1) 删除 vite 因 onnxruntime-web 内部 `new URL("...jsep.wasm", import.meta.url)`
 *    而顺带打进 dist/assets/ 的 28MB 孤儿 wasm（运行时不会用到它——ort 永远走
 *    ort.env.wasm.wasmPaths 拉取，参见 src/ocr/engine.ts）。不删除会超过
 *    EdgeOne Makers 免费版单文件 25MB 上限导致部署失败。
 *
 * 2) 把 onnxruntime-web dist 里的 wasm 运行时同步到 dist/onnx/。
 *    ⚠ 这一步是必须的，不是可选优化：onnxruntime-web 的主入口 ort.mjs 把
 *    wasmModuleFilename 硬编码成 ort-wasm-simd-threaded.jsep.mjs（JSEP 构建），
 *    也就是说 **CPU(wasm) 后端同样会去请求 .jsep.* 那两个文件**，并不会因为
 *    executionProviders 传 ['wasm'] 就改用非 jsep 的 ort-wasm-simd-threaded.wasm。
 *    只放非 jsep 那一对的话，WASM 回退会直接报
 *    「no available backend found. ERR: [wasm] Failed to fetch dynamically imported module」。
 *    （本仓库的 tests/video.test.mjs 就是靠这条断言把这个 bug 抓出来的。）
 *
 * 运行：node scripts/strip-ort-assets.mjs
 */
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const assetsDir = join(root, 'dist', 'assets')
const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist')
const outDir = join(root, 'dist', 'onnx')

let removed = 0
if (existsSync(assetsDir)) {
  for (const name of readdirSync(assetsDir)) {
    if (name.startsWith('ort-wasm-')) {
      rmSync(join(assetsDir, name))
      removed += 1
      console.log(`removed assets/${name}`)
    }
  }
}
console.log(removed > 0 ? `cleaned ${removed} ort asset(s)` : 'no ort assets found')

// ort 运行时清单：只保留 JSEP 一对。
// onnxruntime-web 主入口把文件名硬编码成 .jsep.*，非 jsep 的
// ort-wasm-simd-threaded.wasm（13.6MB）永远不会被请求——曾经放在
// public/onnx/ 里，纯粹是白占分发产物体积。
const WANTED = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']

if (!existsSync(ortDist)) {
  console.error(`找不到 onnxruntime-web dist：${ortDist}（依赖装了吗？）`)
  process.exit(1)
}

// 先清空，保证输出目录里不会残留上一版多出来的文件
if (existsSync(outDir)) {
  for (const name of readdirSync(outDir)) {
    if (name.startsWith('ort-wasm-') && !WANTED.includes(name)) {
      rmSync(join(outDir, name))
      console.log(`dropped stale onnx/${name}`)
    }
  }
}

let copied = 0
for (const name of WANTED) {
  const src = join(ortDist, name)
  if (!existsSync(src)) {
    console.error(`缺少 onnxruntime-web 运行时文件：${name}`)
    process.exit(1)
  }
  const dest = join(outDir, name)
  // 内容一致就跳过，避免每次构建都白拷 40MB
  if (existsSync(dest) && statSync(dest).size === statSync(src).size) continue
  copyFileSync(src, dest)
  copied += 1
  console.log(`onnx/${name}  ${(statSync(dest).size / 1024 / 1024).toFixed(2)}MB`)
}
console.log(copied > 0 ? `synced ${copied} ort runtime file(s)` : 'ort runtime already up to date')
