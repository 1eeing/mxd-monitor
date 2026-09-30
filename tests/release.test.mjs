/**
 * 验证 release 包「真的能脱离开发环境跑」。
 *
 * 做法：把 release/mxd-monitor 复制到一个临时目录（模拟别人的机器），
 * 然后只用包内自带的 node.exe 启动它，检查 dist 能被托管。
 * 关键是不能用本机 PATH 里的 node，否则测了个寂寞。
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'release', 'mxd-monitor')
const PORT = 5399
const BASE = `http://127.0.0.1:${PORT}`

// 没打过包就先打一个。这个测试要验的是「当前源码打出来的包能不能独立跑」，
// 所以现打现验，而不是去验一个可能已经过期的 release/ 目录。
if (!existsSync(join(PKG, 'node.exe'))) {
  console.log('release/ 不存在，先执行 npm run pack ...')
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pack.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('  ✗ 打包失败')
    process.exit(1)
  }
}

let pass = 0
let fail = 0
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✓ ${n}`) } else { fail += 1; console.log(`  ✗ ${n}${e ? `  -> ${e}` : ''}`) }
}

console.log(`发布包自检  (${PKG})`)

if (!existsSync(join(PKG, 'node.exe'))) {
  console.error('  ✗ 没有 release/mxd-monitor/node.exe，先跑 npm run pack')
  process.exit(1)
}

// 复制到临时目录：模拟「在别人电脑上解压」
const sandbox = mkdtempSync(join(tmpdir(), 'mxd-release-'))
const SANDBOXED = join(sandbox, 'mxd-monitor')
cpSync(PKG, SANDBOXED, { recursive: true })

ok('包内自带 node.exe', existsSync(join(SANDBOXED, 'node.exe')))
ok('包内自带 ws 依赖', existsSync(join(SANDBOXED, 'node_modules', 'ws', 'package.json')))
// AGENTS.md 是给「对方的 opencode」看的启动说明书，漏了就等于没打包
ok('包内含 AGENTS.md（opencode 会自动读）', existsSync(join(SANDBOXED, 'AGENTS.md')))
ok('AGENTS.md 说明了禁用 npm install', (() => {
  const t = readFileSync(join(SANDBOXED, 'AGENTS.md'), 'utf8')
  return t.includes('npm install') && t.includes('node.exe') && t.includes('localhost')
})())
ok('包内含双击启动的 bat', existsSync(join(SANDBOXED, 'mxd-monitor.bat')))
ok('包内含给使用者的 README', existsSync(join(SANDBOXED, 'README.txt')))
// bat 写在 JS 模板字符串里，server 路径里的反斜杠会被 JS 当转义吃掉，
// 生成出双击必坏的路径。必须逐字校验真正执行的那一行（不能整文件搜，
// 因为 REM 注释里也会出现路径字样）。
ok('bat 里的 server 路径反斜杠没被 JS 吃掉', (() => {
  const bat = readFileSync(join(SANDBOXED, 'mxd-monitor.bat'), 'utf8')
  const cmd = bat.split(/\r?\n/).find((l) => /^\s*"?%~dp0node\.exe"?\s+"/.test(l)) ?? ''
  return cmd.includes('server') && cmd.includes('serve.mjs') && /server\\serve\.mjs"/.test(cmd)
})(), (readFileSync(join(SANDBOXED, 'mxd-monitor.bat'), 'utf8').split(/\r?\n/).find((l) => /^\s*"?%~dp0node\.exe"?\s+"/.test(l)) ?? '').trim())
ok('包内没有 node_modules 里其他无关依赖', (() => {
  // 只该有 ws，不该把整个开发依赖树带进去
  const list = readdirSync(join(SANDBOXED, 'node_modules'))
  return list.length === 1 && list[0] === 'ws'
})(), '实际: ' + readdirSync(join(SANDBOXED, 'node_modules')).join(','))

// 清空 PATH，确保启动用的是包内 node.exe 而不是本机的
const env = { ...process.env, PORT: String(PORT), PATH: '' }
let srv = null
try {
  srv = spawn(join(SANDBOXED, 'node.exe'), [join(SANDBOXED, 'server', 'serve.mjs')], {
    cwd: SANDBOXED,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  srv.stdout.on('data', (d) => { log += d })
  srv.stderr.on('data', (d) => { log += d })

  let up = false
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 150))
    try { if ((await fetch(`${BASE}/`, { signal: AbortSignal.timeout(500) })).ok) { up = true; break } } catch {}
  }
  ok('包内 node.exe 能独立启动服务（PATH 已清空）', up, log.slice(-400))
  ok('启动日志里有手机端局域网地址', /phone\.html/.test(log), log.slice(-200))

  if (up) {
    const idx = await fetch(`${BASE}/`)
    ok('PC 页可访问', idx.status === 200)
    const ph = await fetch(`${BASE}/phone.html`)
    ok('手机页可访问', ph.status === 200 && (await ph.text()).includes('id="root"'))
    // OCR 运行时必须在包里，否则 WASM/WebGPU 后端都起不来
    const jsep = await fetch(`${BASE}/onnx/ort-wasm-simd-threaded.jsep.mjs`)
    ok('ort 运行时在包内', jsep.status === 200, String(jsep.status))
    const model = await fetch(`${BASE}/models/ch_PP-OCRv4_det_infer.onnx`, { method: 'HEAD' })
    ok('OCR 模型在包内', model.status === 200, String(model.status))
    // COOP/COEP 决定 WASM 后端能不能多线程
    ok('保留跨源隔离头', idx.headers.get('cross-origin-opener-policy') === 'same-origin')
  }
} finally {
  try { srv?.kill() } catch {}
  try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }) } catch {}
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
