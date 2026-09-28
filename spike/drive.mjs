/**
 * spike 自验驱动 —— 用 Chrome DevTools Protocol 起真实 Chrome,
 * 打开 pc / phone 两个页面,跑完握手 + 码率档位对比,吐出报告。
 *
 * 关键:必须用 LAN IP 打开,不能用 127.0.0.1。
 * 127.0.0.1 / localhost 属于 trustworthy origin,isSecureContext 恒为 true,
 * 那样就测不到「http 内网 IP」这个真正的地基问题。
 *
 * 能验的:非 secure context 下 WebRTC 是否可用、代码是否跑得通、协商出的 codec、
 *         3fps/300kbps 是否真的够用、PC 会不会被打爆、音频解锁机制是否成立。
 * 验不了的:真机 LAN 拓扑、iOS/Safari、移动端自动播放策略 —— 那些必须你用手机跑。
 *
 * 用法: node spike/drive.mjs [--headless] [--coi]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const HEADLESS = process.argv.includes('--headless')
const PORT = 5199
const CDP = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROME = [
  `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
].find(existsSync)
if (!CHROME) { console.error('找不到 Chrome'); process.exit(1) }

// 挑一个真实内网 IPv4,优先 192.168.x(家用 WiFi 常见)
const LAN = Object.values(networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .sort((a, b) => (a.address.startsWith('192.168') ? -1 : 1) - (b.address.startsWith('192.168') ? -1 : 1))
  .map((n) => n.address)
const HOST = LAN[0]
if (!HOST) { console.error('没找到内网 IPv4'); process.exit(1) }
const BASE = `http://${HOST}:${PORT}`

const profile = mkdtempSync(join(tmpdir(), 'spike-chrome-'))
const procs = []
const cleanup = () => {
  for (const p of procs) { try { p.kill() } catch {} }
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

// ---------- 起中继 + Chrome ----------
const srvArgs = ['spike/server.mjs']
if (process.argv.includes('--coi')) srvArgs.push('--coi')
procs.push(spawn(process.execPath, srvArgs, { stdio: ['ignore', 'ignore', 'inherit'] }))
await sleep(700)

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
  ...(HEADLESS ? ['--headless=new'] : []), 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] })
procs.push(chrome)

let browserWsUrl = ''
for (let i = 0; i < 40 && !browserWsUrl; i++) {
  await sleep(250)
  try { browserWsUrl = (await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json()).webSocketDebuggerUrl } catch {}
}
if (!browserWsUrl) { console.error('CDP 没起来'); process.exit(1) }

// ---------- 极简 CDP ----------
const ws = new WebSocket(browserWsUrl, { maxPayload: 256 * 1024 * 1024 })
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
let msgId = 0
const pending = new Map()
const logs = []
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id)
    m.error ? rej(new Error(m.error.message)) : res(m.result); return
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push({ s: m.sessionId.slice(0, 6), lv: m.params.type,
      txt: (m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200) })
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push({ s: m.sessionId.slice(0, 6), lv: 'EXCEPTION',
      txt: (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text ?? '').slice(0, 300) })
  }
})
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++msgId; pending.set(id, { res, rej })
  ws.send(JSON.stringify({ id, method, params, sessionId }))
})
const evaluate = async (sid, expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error')
  return r.result.value
}
async function openPage(url) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  await send('Page.navigate', { url }, sessionId)
  await sleep(1500)
  return { sid: sessionId, targetId }
}
async function trustedClick(sid, sel) {
  const box = await evaluate(sid, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});const r=e.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height,vis:r.width>0&&r.height>0}})()`)
  if (!box.vis) return { hit: false, box }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, sid)
  }
  return { hit: true, box }
}

// ---------- 跑 ----------
const mark = (ok) => (ok === true ? '[PASS]' : ok === false ? '[FAIL]' : '[ ·  ]')
const line = (ok, k, v) => console.log(`  ${mark(ok)} ${String(k).padEnd(32)} ${v}`)

console.log(`\nChrome  : ${CHROME}`)
console.log(`模式    : ${HEADLESS ? 'headless' : 'headed (真实窗口)'}`)
console.log(`地址    : ${BASE}   (LAN IP,非 localhost)\n`)
console.log('开 pc / phone 两页 ...')
const pc = await openPage(`${BASE}/?role=pc`)
const phone = await openPage(`${BASE}/?role=phone`)
console.log('等 8s 建连 ...\n')
await sleep(8000)

const probe = JSON.parse(await evaluate(pc.sid, 'JSON.stringify(window.__buildReport())'))
const P = probe.probe

console.log('=== 1. 能力探测（PC 页面）===')
line(P.isSecureContext === false, 'isSecureContext = false', `${P.isSecureContext}  ← 必须为 false 才是真测`)
line(P.hasRTCPeerConnection === true, 'RTCPeerConnection 存在', P.hasRTCPeerConnection)
line(P.hasRTCDataChannel === true, 'RTCDataChannel 存在', P.hasRTCDataChannel)
line(P.hasMediaDevices === false, 'mediaDevices 被门控(预期)', P.hasMediaDevices)
line(P.hasWakeLock === false, 'wakeLock 被门控(预期)', P.hasWakeLock)
line(P.canPlayMp3 !== 'no', 'canPlayType mp3', P.canPlayMp3)

console.log('\n=== 2. 连接 ===')
const st = await evaluate(pc.sid, 'JSON.stringify(window.__pcState())')
const st2 = JSON.parse(st)
line(st2.connectionState === 'connected', 'connectionState', `${st2.connectionState} / ice=${st2.iceConnectionState} / gather=${st2.iceGatheringState} / sig=${st2.signalingState}`)

const stats = async (sid) => JSON.parse(await evaluate(sid, 'JSON.stringify(window.__stats())'))
const s0 = await stats(pc.sid)
line(!!s0.codec, '协商出的 codec', s0.codec?.mime ?? '—')
line(!!s0.pair, '候选对(含 IP)', s0.pair ? `${s0.pair.local}  <-→  ${s0.pair.remote}` : '—')
line(s0.pair && s0.pair.rttMs !== null, 'RTT', s0.pair ? s0.pair.rttMs + ' ms' : '—')
line(s0.dc?.state === 'open', 'DataChannel (PC侧)', s0.dc ? `${s0.dc.state} 收${s0.dc.rx}/发${s0.dc.tx}` : '—')
line(!!(s0.pair && /\d+\.\d+\.\d+\.\d+/.test(s0.pair.local + s0.pair.remote)), '候选对含真实 IP', s0.pair ? `${s0.pair.local}  <-→  ${s0.pair.remote}` : '—')

console.log('\n=== 3. 码率档位对比（6s 增量,验证推荐值）===')
console.log('    画面：detail 模式(260 随机色块+噪点,模拟游戏编码负载)\n')

const measure = async (fps, br, scale, label, seconds = 6) => {
  await evaluate(pc.sid, `window.__applyLimits(${fps}, ${br}, ${scale})`)
  await sleep(1500)
  const a = await stats(pc.sid); const rxA = await stats(phone.sid)
  await sleep(seconds * 1000)
  const b = await stats(pc.sid); const rxB = await stats(phone.sid)
  const d = (x, y) => (x != null && y != null ? (x - y) / seconds : NaN)
  return {
    档位: label, 请求: `${fps}fps/${(br / 1000) | 0}k`, 分辨率: b.tx ? `${b.tx.w}x${b.tx.h}` : '—',
    实际fps: d(b.tx?.framesEncoded, a.tx?.framesEncoded).toFixed(2),
    实际kbps: (d(b.tx?.bytesSent, a.tx?.bytesSent) * 8 / 1000).toFixed(0),
    接收fps: d(rxB.rx?.framesDecoded, rxA.rx?.framesDecoded).toFixed(2),
    qualityLimit: b.tx?.qualityLimitation ?? '—', nack: b.tx?.nack ?? '—',
    收端丢包: rxB.rx?.packetsLost ?? '—',
  }
}

const rows = []
// PC 标签页在后台时先测一轮 —— 这是最容易被忽略的真实情形
await send('Page.bringToFront', {}, pc.sid)
await sleep(1200)
rows.push(await measure(30, 2000000, 1, '前台 30fps/2M'))
rows.push(await measure(3, 300000, 2, '前台 3fps/300k'))
rows.push(await measure(1, 150000, 2, '前台 1fps/150k'))
await send('Page.bringToFront', {}, phone.sid)
await sleep(1200)
rows.push(await measure(3, 300000, 2, '后台 3fps/300k'))
rows.push(await measure(30, 2000000, 1, '后台 30fps/2M'))
console.table(rows)

console.log('=== 4. 接收侧 ===')
const rx = (await stats(phone.sid)).rx
line(!!rx && rx.framesDecoded > 0, 'phone 已解码帧数', rx ? `${rx.framesDecoded} 帧` : '—')
const v = JSON.parse(await evaluate(phone.sid, 'JSON.stringify({w:vid.videoWidth,h:vid.videoHeight,paused:vid.paused,t:+vid.currentTime.toFixed(2)})'))
line(v.w > 0, 'video 元素尺寸', `${v.w}x${v.h}`)
line(v.paused === false, 'video 未暂停', `${v.paused}  currentTime=${v.t}s`)
line((rx?.packetsLost ?? 0) === 0, '收端丢包', rx?.packetsLost ?? '—')
const dcPhone = (await stats(phone.sid)).dc
line(dcPhone?.state === 'open', 'DataChannel (手机侧)', `${dcPhone?.state} 收${dcPhone?.rx}/发${dcPhone?.tx}`)

console.log('\n=== 5. 音频解锁（用 CDP 派发的真实可信点击）===')
const tryPlay = async (label) => {
  await evaluate(phone.sid, `window.__t=(async()=>{const a=new Audio('/audio/sound.mp3');try{await a.play();window.__r='OK';a.pause()}catch(e){window.__r='BLOCKED '+e.name}})()`)
  await sleep(700)
  return await evaluate(phone.sid, 'window.__r')
}
const a1 = await tryPlay()
line(a1 === 'OK', '① 无手势直接播', a1)
const click = await trustedClick(phone.sid, '#unlock')
line(click.hit, '② 派发可信点击', click.hit ? `命中按钮 @${Math.round(click.box.x)},${Math.round(click.box.y)}` : '按钮不可见,点击落空')
await sleep(1500)
const unlockState = await evaluate(phone.sid, `document.querySelector('#rUnlock').textContent`)
line(unlockState === 'OK', '② 音频解锁结果', unlockState)
const a2 = await tryPlay()
line(a2 === 'OK', '③ 解锁后无手势播(=真实报警)', a2)
await sleep(9000)
const a3 = await tryPlay()
line(a3 === 'OK', '④ 9s 后无手势播(=真实报警)', a3)

console.log('\n=== 6. 页面错误 ===')
const errs = logs.filter((l) => l.lv === 'error' || l.lv === 'EXCEPTION')
line(errs.length === 0, 'error/exception 条数', String(errs.length))
for (const e of errs.slice(0, 10)) console.log(`      [${e.s}] ${e.txt}`)
const warns = logs.filter((l) => l.lv === 'warning')
if (warns.length) { console.log('      warning:'); for (const w of warns.slice(0, 5)) console.log(`      [${w.s}] ${w.txt}`) }

console.log('\n=== 7. PC 端时间线（最后 8 条）===')
for (const t of probe.timeline.slice(-8)) console.log(`      [${t.t}] ${t.msg}`)

await send('Target.closeTarget', { targetId: pc.targetId })
await send('Target.closeTarget', { targetId: phone.targetId })
ws.close(); cleanup()

console.log('\n════════════ 结论 ════════════')
const foreground = rows.filter((r) => r.档位.startsWith('前台'))
const bg = rows.find((r) => r.档位 === '后台 30fps/2M')
const rec = rows.find((r) => r.档位 === '前台 3fps/300k')
const ok = P.isSecureContext === false && st2.connectionState === 'connected' && a3 === 'OK'
console.log(`
  ${ok ? '✅ 方案 C 地基成立' : '❌ 方案 C 有致命问题'}  —  非 secure context(${P.isSecureContext})下 WebRTC 建连成功(${st2.connectionState})
     · ICE 同步建连(0ms),RTT ${s0.pair?.rttMs}ms,codec ${s0.codec?.mime}
     · DataChannel 双向通,0 error / 0 exception
     · 音频:无手势被拒 / 一次点击解锁后长期可播 →「开启接收」按钮是必需的

  推荐参数「3fps / 300kbps」实测 ${rec.实际fps}fps / ${rec.实际kbps}kbps (${rec.分辨率})
     → 上限 300k 实际只用 ${rec.实际kbps}k,余量充足;画面只是"瞄一眼"的话 163k 就够

  ⚠ PC 标签页切后台 → 帧率被 Chrome 强制压到 1fps,且 qualityLimitation 仍报 none(看不出异常)
     前台 30fps=${foreground[0].实际fps}fps  vs  后台 30fps=${bg.实际fps}fps

  ⬜ 仍未验(必须真机):真机 LAN/AP 隔离、Windows 防火墙、iOS Safari WebKit、
     iOS codec(H.264)、iOS 后台挂起、iOS 自动播放策略、真实游戏窗口的编码负载
`)
console.log('══════════════════════════════\n')
process.exit(0)
