/**
 * 局域网镜像服务：静态托管 dist/ + WebRTC 信令中继 + 报警音频中转。
 *
 * 为什么必须本地跑、不能只靠 EdgeOne 那份静态站：
 * 线上是 HTTPS，而 HTTPS 页面不能连 ws://192.168.1.x（混合内容会被浏览器直接拦掉），
 * 本地服务又没有浏览器信任的证书，wss:// 同样连不上（WebSocket 对不受信证书是硬失败，
 * 连「继续访问」这种绕过都没有）。所以手机镜像只能在 HTTP 局域网下成立。
 *
 * 用法：
 *   npm run build && npm run lan
 */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const DIST = join(ROOT, 'dist')
// 运行时目录可用 LAN_RUNTIME 覆盖。默认放在项目里，但测试必须注入各自的临时目录：
// 报警音频是跨请求的持久状态，共用目录会让「未上传时返回 404」这类断言被上一轮残留污染。
const RUNTIME = process.env.LAN_RUNTIME ?? join(ROOT, '.lan-runtime')
const PORT = Number(process.env.PORT ?? 5199)
const HOST = process.env.HOST ?? '0.0.0.0'

/** 报警音频的中转位置。PC 写一次，手机来取，避免用 DataChannel 传二进制分片。 */
const ALARM_AUDIO = join(RUNTIME, 'alarm-audio.bin')
const ALARM_AUDIO_META = join(RUNTIME, 'alarm-audio.json')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.onnx': 'application/octet-stream',
}

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length })
  res.end(buf)
}

async function readBody(req, limitBytes) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limitBytes) throw new Error('请求体过大')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

// ---------- 报警音频中转 ----------
async function handleAlarmAudio(req, res) {
  if (req.method === 'PUT' || req.method === 'POST') {
    const buf = await readBody(req, 8 * 1024 * 1024)
    if (buf.length === 0) {
      sendJson(res, 400, { error: '空音频' })
      return
    }
    await mkdir(RUNTIME, { recursive: true })
    await writeFile(ALARM_AUDIO, buf)
    await writeFile(ALARM_AUDIO_META, JSON.stringify({ type: req.headers['content-type'] ?? 'audio/mpeg', size: buf.length }))
    sendJson(res, 200, { ok: true, size: buf.length })
    return
  }
  if (req.method === 'DELETE') {
    await writeFile(ALARM_AUDIO_META, JSON.stringify({ type: null, size: 0 }))
    sendJson(res, 200, { ok: true })
    return
  }
  // GET：手机端来取
  try {
    const meta = JSON.parse(await readFile(ALARM_AUDIO_META, 'utf8'))
    if (!meta.size) {
      sendJson(res, 404, { error: 'PC 尚未上传报警音频' })
      return
    }
    const buf = await readFile(ALARM_AUDIO)
    res.writeHead(200, { 'Content-Type': meta.type ?? 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
    res.end(buf)
  } catch {
    sendJson(res, 404, { error: 'PC 尚未上传报警音频' })
  }
}

// ---------- 静态托管 ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = decodeURIComponent(url.pathname)

  /**
   * 跨源隔离头：与 vite.config.ts 的 crossOriginIsolation 插件保持一致。
   * 少了它就没有 SharedArrayBuffer，onnxruntime-web 的 WASM 会退化成单线程，
   * 识别速度明显变慢（WebGPU 后端不受影响）。这个头会切到隔离模式，
   * 但本项目所有子资源都同源，不存在会被 require-corp 挡掉的跨源资源。
   */
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')

  if (path === '/alarm-audio') {
    try {
      await handleAlarmAudio(req, res)
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('仅支持 GET')
    return
  }

  // 路径归一化后必须仍在 dist 内，否则不给读
  const rel = normalize(path).replace(/^([/\\])+/, '')
  let file = resolve(DIST, rel)
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
    return
  }

  let info = null
  try {
    info = await stat(file)
    if (info.isDirectory()) {
      file = join(file, 'index.html')
      info = await stat(file)
    }
  } catch {
    info = null
  }
  // 单页应用：未知路径回落到 index.html，交给前端路由
  if (!info) {
    file = join(DIST, 'index.html')
    try {
      info = await stat(file)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('dist/index.html 不存在，请先执行 npm run build')
      return
    }
  }

  const ext = extname(file).toLowerCase()
  /**
   * 缓存策略：HTML 不缓存，保证 rebuild 后立刻拿到新的入口；
   * 其余资源（带 hash 的包、几十 MB 的模型）允许缓存，
   * 否则每次刷新都要重下模型。
   */
  const cacheControl = ext === '.html' ? 'no-store' : 'public, max-age=3600'
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).pipe(res)
})

// ---------- 信令 ----------
/**
 * 极简中继：一个 PC 端，多个手机端；PC 永远是 offerer。
 *
 * 手机端从不 addTrack（只收视频），所以不存在 offer 冲突（glare），
 * 不需要处理双方同时发起的协商碰撞。
 */
let pcSocket = null
const phones = new Map()
let seq = 0

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
}
const toPC = (msg) => send(pcSocket, msg)
const toPhone = (id, msg) => send(phones.get(id), msg)

const wss = new WebSocketServer({ server, path: '/rtc' })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/rtc', 'http://x')
  const role = url.searchParams.get('role') === 'pc' ? 'pc' : 'phone'
  const ua = (req.headers['user-agent'] ?? '').slice(0, 120)
  // 提到 connection 作用域：close 回调在下面注册，与 if/else 不同作用域，
  // 声明在分支里的话断开时会 ReferenceError 把整个服务带崩。
  let id = null

  if (role === 'pc') {
    if (pcSocket) send(pcSocket, { t: 'bye', why: '被另一个 PC 端顶替' })
    pcSocket = ws
    console.log(`[pc] 已连接  ${ua}`)
    send(ws, { t: 'ready', phones: [...phones.keys()], phoneUrls: phoneUrls() })
    for (const pid of phones.keys()) send(ws, { t: 'peer', id: pid, ua: 'rejoin' })
  } else {
    id = `p${++seq}`
    phones.set(id, ws)
    console.log(`[${id}] 已连接  ${ua}`)
    send(ws, { t: 'ready', id })
    toPC({ t: 'peer', id, ua })
  }

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    // from 一律用服务端记录的身份，不采信 msg.from：
    // 那是客户端自报字段，被顶替或串号时会话就错位了。
    if (role === 'phone') {
      switch (msg.t) {
        case 'answer':
          toPC({ t: 'answer', from: id, sdp: msg.sdp })
          break
        case 'ice':
          // 不看 msg.to：手机只有一个可能的去处，就是 PC。
          // 曾经要求 msg.to === 'pc'，而客户端压根没发这个字段，
          // 于是手机的候选被静默丢弃，表现为「已连接但收不到任何包」。
          toPC({ t: 'ice', from: id, candidate: msg.candidate })
          break
        default:
          break
      }
      return
    }
    // PC 侧：to 指向哪台手机由 PC 决定
    switch (msg.t) {
      case 'offer':
        toPhone(msg.to, { t: 'offer', sdp: msg.sdp })
        break
      case 'ice':
        toPhone(msg.to, { t: 'ice', candidate: msg.candidate })
        break
      default:
        break
    }
  })

  ws.on('close', () => {
    if (role === 'pc') {
      if (pcSocket === ws) pcSocket = null
      console.log('[pc] 已断开')
    } else {
      phones.delete(id)
      console.log(`[${id}] 已断开`)
      toPC({ t: 'peer-leave', id })
    }
  })
})

// 信令通道上的异常不能带崩服务，否则用户会突然发现「服务没了」而无从排查
process.on('uncaughtException', (err) => console.error('[!] uncaughtException:', err))
process.on('unhandledRejection', (err) => console.error('[!] unhandledRejection:', err))

/**
 * 列出本机内网 IPv4。
 * 优先 RFC1918 私网段并排除虚拟网卡常见的 10.x（VPN/WSL/Docker 会占掉一段），
 * 因为手机能连上的一定是路由器分配的那个网段，10.x 往往是 VPN 地址扫不通。
 */
function lanAddresses() {
  const all = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) all.push(ni.address)
    }
  }
  const priv = all.filter((ip) => /^192\.168\./.test(ip))
  const other = all.filter((ip) => !/^192\.168\./.test(ip))
  // 有 192.168.x 时只用它，否则退回其它非内网回环地址
  return priv.length > 0 ? priv : other
}

/** 手机端该扫的地址。二维码内容由它决定，与 PC 用什么地址打开本页无关。 */
function phoneUrls() {
  return lanAddresses().map((ip) => `http://${ip}:${PORT}/phone.html`)
}

server.listen(PORT, HOST, () => {
  const lan = lanAddresses()
  console.log('')
  console.log('  冒险岛监控 · 局域网镜像服务')
  console.log('  --------------------------------------------------')
  console.log(`  PC 端    : http://localhost:${PORT}/   ← 用这个开，屏幕采集需要 secure context`)
  for (const ip of lan) console.log(`  手机端   : http://${ip}:${PORT}/phone.html`)
  console.log('  --------------------------------------------------')
  console.log('  1) PC 上打开 localhost 那个地址，点「📱 连接手机」')
  console.log('  2) 手机连同一个 WiFi，扫二维码（内容是上面的局域网地址）')
  console.log('  ⚠ 浏览器只在 secure context 下允许屏幕采集，')
  console.log('    所以 PC 端别用局域网 IP 打开——那样 getDisplayMedia 直接是 undefined')
  console.log('')
  if (lan.length === 0) console.log('  [!] 没找到内网网卡地址，手机可能连不上\n')
})
