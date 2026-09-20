/**
 * 修复 js-clipper 单文件编码：原包 clipper.js 含非法 UTF-8 字节（注释中的非 ASCII 字符），
 * 导致 rolldown/vite 生产构建解析失败。这里按 latin1 全部字节 1:1 转成合法 UTF-8，
 * 输出到 src/vendor/js-clipper/clipper.js（提交进仓库，避免每次改 node_modules）。
 *
 * 来源：js-clipper@1.0.0（Angus Johnson / Boost Software License）
 * 运行：node scripts/fix-js-clipper.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'node_modules', 'js-clipper', 'clipper.js')
const dest = join(here, '..', 'src', 'vendor', 'js-clipper', 'clipper.js')

const bytes = readFileSync(src)
const latin1 = new TextDecoder('latin1')
// Strict UTF-8 validate first
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
try {
  strictUtf8.decode(bytes)
  console.log('原文件已是合法 UTF-8，无需修复（直接拷贝）')
} catch {
  console.log('检测到非法 UTF-8 字节，按 latin1 全量转码…')
}
const content = latin1.decode(bytes)

const header =
  '// js-clipper v1.0.0 (Boost Software License) - 已由 scripts/fix-js-clipper.mjs 做 latin1->UTF-8 转码\n' +
  '// 原始文件来自 node_modules/js-clipper/clipper.js，仅修正编码，内容未做任何修改。\n'

mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, header + content)
console.log(`已写入 ${dest}（${(Buffer.byteLength(content) / 1024).toFixed(0)} KB）`)