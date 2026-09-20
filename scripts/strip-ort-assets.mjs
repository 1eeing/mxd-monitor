/**
 * 构建后清理：删除 vite 因 onnxruntime-web 内部 `new URL("...jsep.wasm", import.meta.url)`
 * 而顺带打进 dist/assets/ 的 28MB 孤儿 wasm（运行时从来不会用到它——ort 永远走
 * ort.env.wasm.wasmPaths 拉取，参见 src/ocr/engine.ts）。
 *
 * 若不删除，该文件会超过 EdgeOne Makers 免费版单文件 25MB 上限导致部署失败。
 *
 * 运行：node scripts/strip-ort-assets.mjs
 */
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const assetsDir = join(here, '..', 'dist', 'assets')

let removed = 0
for (const name of readdirSync(assetsDir)) {
  if (name.startsWith('ort-wasm-')) {
    const file = join(assetsDir, name)
    rmSync(file)
    removed += 1
    console.log(`removed ${name}`)
  }
}
console.log(removed > 0 ? `cleaned ${removed} ort asset(s)` : 'no ort assets found')