/**
 * 打包成「双击即用」的绿色发布包，给没装 Node/npm 的人用。
 *
 * 产物结构（release/mxd-monitor/）：
 *   mxd-monitor.bat        启动入口，双击即可
 *   server/serve.mjs       局域网服务
 *   node_modules/ws/       唯一的运行时依赖（零依赖，148KB）
 *   dist/                  前端构建产物（含 OCR 模型与 ort 运行时）
 *   README.txt             给使用者的说明
 *
 * 关键点：**把 node.exe 一起复制进去**。这样对方机器不需要装 Node，
 * 也不需要 npm，bat 里直接调相对路径的 node.exe。
 *
 * 前置条件：先 npm run build（需要本机有完整开发环境）。
 *
 * 用法：npm run pack
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'release', 'mxd-monitor')
const DIST = join(ROOT, 'dist')

const fail = (msg) => {
  console.error(`\n[打包失败] ${msg}\n`)
  process.exit(1)
}

if (!existsSync(DIST) || !existsSync(join(DIST, 'index.html'))) {
  fail('dist/ 不存在或没有 index.html，请先执行 npm run build')
}

// node.exe 从当前运行的 node 解析，只取可执行文件本身（不含 npm/npx/corepack）
const nodeExe = process.execPath
if (!existsSync(nodeExe)) fail(`找不到 node 可执行文件：${nodeExe}`)

console.log('清理旧产物…')
rmSync(join(ROOT, 'release'), { recursive: true, force: true, maxRetries: 3 })
mkdirSync(OUT, { recursive: true })

console.log('复制前端产物 dist/ …')
cpSync(DIST, join(OUT, 'dist'), { recursive: true })

console.log('复制服务端…')
mkdirSync(join(OUT, 'server'), { recursive: true })
cpSync(join(ROOT, 'server', 'serve.mjs'), join(OUT, 'server', 'serve.mjs'))

// 运行时依赖：ws（MIT，零依赖）。刻意只拷这一个，不带整个 node_modules。
console.log('复制运行时依赖 ws…')
mkdirSync(join(OUT, 'node_modules'), { recursive: true })
cpSync(join(ROOT, 'node_modules', 'ws'), join(OUT, 'node_modules', 'ws'), {
  recursive: true,
  // ws 的 README/benchmark 对运行没用，省掉
  filter: (src) => !/(\.github|benchmark|benchmarks|package-lock)/.test(src),
})

console.log('复制 node.exe …')
cpSync(nodeExe, join(OUT, 'node.exe'))

const bat = `@echo off
chcp 65001 >nul
title 冒险岛监控 - 局域网镜像服务
cd /d "%~dp0"

REM ---------------------------------------------------------------
REM  如果双击后窗口一闪而过，多半是 node.exe 缺失或被杀毒软件隔离。
REM  换个目录解压再试，或把本目录加进杀毒软件白名单。
REM ---------------------------------------------------------------

if not exist "%~dp0node.exe" (
  echo [错误] 找不到 node.exe，发布包不完整，请重新解压。
  pause
  exit /b 1
)

echo 正在启动服务...
echo.
start "" "http://localhost:5199/"
REM 下一行的 server 路径含一个反斜杠。写在 JS 模板字符串里必须转义两次，
REM 否则会被 JS 当转义序列吃掉反斜杠，拼出坏路径（oxlint 会报 no-useless-escape）。
"%~dp0node.exe" "%~dp0server\\serve.mjs"

echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
`
writeFileSync(join(OUT, 'mxd-monitor.bat'), bat, 'utf8')

const readme = `冒险岛监控 · 局域网镜像（免安装版）
====================================

怎么启动
--------
双击 mxd-monitor.bat。会先弹出浏览器，然后这个黑窗口要一直开着。

怎么用
------
1. 电脑上打开 http://localhost:5199/
   ⚠ 必须是 localhost，不能换成 192.168.x.x —— 浏览器只在「安全上下文」
      下允许屏幕采集，用局域网 IP 打开会导致「开始监控」直接失败。
2. 点右上角「📱 连接手机」→「开启镜像」
3. 手机连同一个 WiFi，扫弹窗里的二维码
4. 手机上先点「🔊 开启报警声音」（iPhone 必须，否则永远没声音）
5. 电脑上点「▶ 开始监控」，选择游戏窗口
6. 手机 1~2 秒内出画面

常见问题
--------
Q: 杀毒软件报毒 / 双击没反应
A: node.exe 是便携运行时，常被误报。加白名单，或解压到 D:\\ 之类普通目录再试。

Q: 手机扫了二维码连不上
A: 1) 确认电脑和手机在同一个 WiFi
   2) 确认这个黑窗口还开着
   3) 确认 Windows 防火墙允许 node.exe 访问「专用网络」

Q: 关掉窗口服务就停了？
A: 是的，这个窗口是服务本体。要用就开着。

Q: 端口 5199 被占用
A: 用记事本打开 mxd-monitor.bat，把 5199 改成别的数字（4 处），
   同时把浏览器地址也改成对应端口。

Q: 页面显示的是旧版本
A: 强制刷新（Ctrl+F5）。HTML 已设置不缓存，通常不会出现。

数据说明
--------
本程序只在本机监听 5199 端口，不联网上报任何数据。
`
writeFileSync(join(OUT, 'README.txt'), readme, 'utf8')

// 关键：把 AGENTS.md 一起打进包里。opencode 默认会读项目根的 AGENTS.md，
// 所以对方解压后用 opencode 打开这个目录，agent 就自动知道怎么启动，
// 不需要在聊天里手写一大段提示词。
const agents = `# 冒险岛监控 · 局域网镜像（已编译发布包）

这是一个**已经构建完成的成品包**，不需要、也**不要**在这台机器上安装依赖或重新构建。

## 重要前提

- 这台机器**可能没有安装 Node.js / npm**。本包自带 \`node.exe\`，所有命令都用它。
- **禁止**执行 \`npm install\`、\`npm ci\`、\`npm run build\`、\`npm run pack\`。
  没有 npm，而且重新构建需要完整开发环境（TypeScript、Vite、模型文件），本包里没有这些。
- **禁止**修改 \`dist/\`。它是已构建的产物（含 OCR 模型和 onnxruntime 运行时），
  改了也无法重新生成。
- 这个包不是 git 仓库，也没有源码。不要试图"修复"构建问题。

## 启动服务

在 **Windows PowerShell** 里，从本目录执行：

\`\`\`powershell
Start-Process -FilePath ".\\node.exe" -ArgumentList ".\\server\\serve.mjs" -WorkingDirectory (Get-Location) -PassThru | Select-Object Id,ProcessName
\`\`\`

这会后台启动服务并返回 PID。**不要**用前台方式直接跑 \`.\\node.exe .\\server\\serve.mjs\`，
那会一直占着终端。

等 1~2 秒后验证服务活着：

\`\`\`powershell
Invoke-WebRequest -Uri "http://localhost:5199/" -UseBasicParsing | Select-Object StatusCode
\`\`\`

返回 200 即成功。然后告诉用户去打开 http://localhost:5199/ 。

也可以直接让用户双击 \`mxd-monitor.bat\` —— 效果一样（它会顺带开浏览器）。
如果用户已经在浏览器里了，优先用上面的 \`Start-Process\` 方式，这样你能拿到 PID 方便后续排查。

## 改端口

默认 5199。如果被占用：

\`\`\`powershell
$env:PORT = 5200
Start-Process -FilePath ".\\node.exe" -ArgumentList ".\\server\\serve.mjs" -WorkingDirectory (Get-Location)
\`\`\`

注意：端口改了之后，PC 端页面地址也要跟着改成 \`http://localhost:<新端口>/\`。

## 停止服务

\`\`\`powershell
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*mxd-monitor*" } | Stop-Process
\`\`\`

只杀本包起的进程，不要无差别 \`taskkill /IM node.exe\`（可能误杀用户其他 node 进程）。

## 它能做什么

PC 端（浏览器）：截取指定窗口画面，做 OCR 数字识别，监控数值并在超限时报警。
手机端：局域网内接收 PC 的实时画面、当前数值和报警状态，并播放报警音。

操作路径：PC 页面右上角「📱 连接手机」→ 开启镜像 → 扫二维码；
PC 点「▶ 开始监控」选择游戏窗口；手机端先点「🔊 开启报警声音」。

## 排障

| 现象 | 处理 |
|---|---|
| 杀毒软件报毒 | \`node.exe\` 是便携 Node 运行时，误报率高。让用户加白名单，或解压到普通目录（如 \`D:\\tools\\\`）再试 |
| 双击 bat 一闪而过 | 用上面的 \`Start-Process\` 方式跑，能看到真实报错 |
| 端口被占用 | 见「改端口」 |
| 手机连不上 | 电脑和手机要在同一 WiFi；Windows 防火墙需允许 \`node.exe\` 访问专用网络；确认服务进程还在 |
| PC 端「开始监控」失败 | 页面必须用 \`http://localhost:5199/\` 打开。浏览器只在安全上下文下允许屏幕采集，换成 \`192.168.x.x\` 打开必然失败 |
| 模型/ort 加载失败 | 确认 \`dist/models/\` 和 \`dist/onnx/\` 解压完整（杀毒软件可能删了 wasm 文件） |

## 数据与隐私

本程序只监听本机 5199 端口，不向任何外部服务上传数据。
`

writeFileSync(join(OUT, 'AGENTS.md'), agents, 'utf8')

// 统计体积，方便判断是否要再优化
let total = 0
const big = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else {
      const size = statSync(p).size
      total += size
      if (size > 3 * 1024 * 1024) big.push([p.slice(OUT.length + 1), size])
    }
  }
}
walk(OUT)

console.log('')
console.log('  打包完成')
console.log('  --------------------------------------------------')
console.log(`  产物目录 : release\\mxd-monitor\\`)
console.log(`  总体积   : ${(total / 1024 / 1024).toFixed(1)} MB`)
console.log('  启动方式 : 双击 mxd-monitor.bat')
console.log('  --------------------------------------------------')
if (big.length > 0) {
  console.log('  体积大头：')
  for (const [name, size] of big.sort((a, b) => b[1] - a[1])) {
    console.log(`    ${(size / 1024 / 1024).toFixed(1).padStart(6)} MB  ${name}`)
  }
  console.log('')
}
console.log('  压缩命令：')
console.log('    cd release && tar -czf mxd-monitor.tar.gz mxd-monitor')
console.log('')
