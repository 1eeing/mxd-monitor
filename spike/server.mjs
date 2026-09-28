/**
 * WebRTC 局域网连通性 spike —— 一次性诊断工具,验完整个 spike/ 目录可删。
 *
 * 只回答三个问题:
 *   1. http://<内网IP>(非 secure context)下,RTCPeerConnection 能不能建连?
 *   2. 视频轨 + DataChannel 能不能真通?协商出什么 codec?收/发码率多少?
 *   3. 手机端没有用户手势时,报警音频能不能播出来?(iOS 关键风险)
 *
 * 刻意不引入 Vite:诊断工具每多一层栈就多一个变量。
 *
 * 用法:
 *   node spike/server.mjs            # 不加 COOP/COEP,模拟最"裸"的 http 场景
 *   node spike/server.mjs --coi      # 加上 COOP/COEP,验证正式站点的响应头不会打断 WebRTC
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 5199)
const HOST = process.env.HOST ?? '0.0.0.0'
const COOP = process.argv.includes('--coi')

// 白名单路由,不给路径穿越留口子
const ROUTES = {
  '/': join(here, 'index.html'),
  '/audio/sound.mp3': join(here, '..', 'public', 'audio', 'sound.mp3'),
}
const MIME = { '.html': 'text/html; charset=utf-8', '.mp3': 'audio/mpeg' }

const server = createServer(async (req, res) => {
  if (COOP) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  }
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const file = ROUTES[path]
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  try {
    const buf = await readFile(file)
    const ext = file.slice(file.lastIndexOf('.'))
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(buf)
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(String(err))
  }
})

// ---------- 信令 ----------
// 极简:一个 pc 端,多个 phone 端;pc 永远是 offerer(phone 永不 addTrack,所以没有 glare)
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

  if (role === 'pc') {
    if (pcSocket) send(pcSocket, { t: 'bye', why: '被另一个 PC 端顶替' })
    pcSocket = ws
    console.log('[pc] 已连接  ' + ua)
    send(ws, { t: 'ready', phones: [...phones.keys()] })
    for (const id of phones.keys()) send(ws, { t: 'peer', id, ua: 'rejoin' })
  } else {
    const id = `p${++seq}`
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
    switch (msg.t) {
      case 'offer':
        toPhone(msg.to, { t: 'offer', sdp: msg.sdp })
        break
      case 'answer':
        toPC({ t: 'answer', sdp: msg.sdp })
        break
      case 'ice':
        if (msg.to === 'pc') toPC({ t: 'ice', candidate: msg.candidate })
        else toPhone(msg.to, { t: 'ice', candidate: msg.candidate })
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

server.listen(PORT, HOST, () => {
  const lan = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) lan.push(ni.address)
    }
  }
  console.log('')
  console.log('  WebRTC spike 已启动' + (COOP ? '(带 COOP/COEP)' : '(无 COOP/COEP)'))
  console.log('  --------------------------------------------------')
  console.log(`  PC 端    : http://localhost:${PORT}/?role=pc`)
  for (const ip of lan) console.log(`  手机端   : http://${ip}:${PORT}/?role=phone`)
  console.log('  --------------------------------------------------')
  console.log('  1) 先在 PC 上开两个标签页,分别 role=pc / role=phone,验证代码本身通不通')
  console.log('  2) 再用手机访问手机端地址,验真实网络 + 真实 iOS/Android')
  console.log('  3) 每个页面点「复制报告」,把 JSON 贴回来')
  console.log('')
  if (lan.length === 0) console.log('  [!] 没找到内网网卡地址,手机可能连不上\n')
})
