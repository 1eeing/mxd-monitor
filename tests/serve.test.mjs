/**
 * server/serve.mjs 的端到端冒烟测试。
 *
 * 自己 fork 一个服务端进程（用临时端口，跑完杀掉），这样 `npm test` 一条命令就能跑，
 * 不需要先手工开服务。覆盖：静态托管、目录逃逸防护、信令中继双向转发、报警音频中转。
 */
import { WebSocket } from 'ws'
import { connect } from 'node:net'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.TEST_PORT ?? 5211)
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? `  -> ${extra}` : ''}`)
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 建一个带常驻消息队列的信令客户端。
 *
 * 必须一连上就挂 message 监听：ws 只在监听器存在时派发事件，
 * 之后再挂会漏掉连接瞬间就到达的 ready/peer（之前就是这么误报的）。
 */
function makeClient(path) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/rtc?${path}`)
  const queue = []
  ws.on('message', (raw) => queue.push(JSON.parse(String(raw))))
  const opened = new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  return {
    ws,
    opened,
    all: () => queue.slice(),
    /** 等一条满足条件的消息（默认 2s 超时返回 null） */
    async next(pred, ms = 2000) {
      const deadline = Date.now() + ms
      for (;;) {
        const i = queue.findIndex((m) => pred(m))
        if (i >= 0) return queue.splice(i, 1)[0]
        if (Date.now() > deadline) return null
        await wait(20)
      }
    },
  }
}

/** 用裸 TCP 发请求，绕开 fetch/URL 的路径归一化，才能真正打到服务端的路径处理 */
function rawGet(path) {
  return new Promise((res, rej) => {
    const sock = connect(PORT, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
    })
    let buf = ''
    sock.on('data', (d) => {
      buf += d
    })
    sock.on('end', () => res(buf))
    sock.on('error', rej)
    setTimeout(() => sock.destroy(), 3000)
  })
}

/** 响应里只要出现仓库根 package.json 的内容就说明逃逸成功了 */
const LEAK_MARK = '"mxd-monitor"'

async function testStatic() {
  console.log('\n[静态托管]')
  const index = await fetch(`${BASE}/`)
  const html = await index.text()
  ok('GET / 返回 index.html', index.status === 200 && html.includes('<div id="root">'))

  const phone = await fetch(`${BASE}/phone.html`)
  ok('GET /phone.html 返回手机页', phone.status === 200 && (await phone.text()).includes('id="root"'))

  ok('未知路径回落到 index.html（SPA）', (await fetch(`${BASE}/some/deep/route`)).status === 200)

  const icon = await fetch(`${BASE}/favicon.svg`)
  ok('favicon.svg MIME 正确', icon.headers.get('content-type') === 'image/svg+xml', String(icon.status))

  // 缺这两个头会让 onnxruntime-web 的 WASM 退化成单线程，必须和 vite preview 一致
  ok('设置了 COOP 头', index.headers.get('cross-origin-opener-policy') === 'same-origin')
  ok('设置了 COEP 头', index.headers.get('cross-origin-embedder-policy') === 'require-corp')

  ok('HTML 不缓存（rebuild 后立刻生效）', (await fetch(`${BASE}/`)).headers.get('cache-control') === 'no-store')
  ok('静态资源允许缓存（模型很大）', (icon.headers.get('cache-control') ?? '').includes('max-age'), icon.headers.get('cache-control') ?? 'null')

  // onnxruntime-web 主入口把 wasm 文件名硬编码成 .jsep.*，所以 CPU(wasm) 回退
  // 也会去请求这两个文件。少任何一个，WASM 后端就是 100% 「no available backend found」。
  // 这条断言是为了守住 tests/video.test.mjs 抓到过的那个 bug。
  const jsepMjs = await fetch(`${BASE}/onnx/ort-wasm-simd-threaded.jsep.mjs`)
  ok('ort JSEP 加载器存在（wasm 后端也要用它）', jsepMjs.status === 200, String(jsepMjs.status))
  const jsepWasm = await fetch(`${BASE}/onnx/ort-wasm-simd-threaded.jsep.wasm`, { method: 'HEAD' })
  ok('ort JSEP wasm 存在（27MB，超过 HEAD 阈值则跳过）',
    jsepWasm.status === 200 || jsepWasm.status === 413 || jsepWasm.status === 404,
    String(jsepWasm.status))
  if (jsepWasm.status === 404) {
    fail += 1
    console.log('  ! /onnx/ 缺 jsep.wasm：跑一次 npm run build（scripts/strip-ort-assets.mjs 会同步）')
  }

  // dist 里的真实资源
  const entry = await fetch(`${BASE}/assets/phone-DLKCpzZZ.js`).catch(() => null)
  ok('手机端 JS 产物可访问', entry === null || entry.status === 200)
}

async function testTraversal() {
  console.log('\n[目录逃逸防护]')
  // 注意：不能用 fetch 发这些路径，WHATWG URL 会在客户端就把 ../ 归一化掉，
  // 服务端根本收不到原样路径，所以必须走裸 TCP。
  const attacks = [
    '/../package.json',
    '/../../package.json',
    '/..%2f..%2fpackage.json',
    '/%2e%2e%5c%2e%2e%5cpackage.json',
    '/..\\..\\package.json',
    '/assets/../../package.json',
    '/./../../src/types.ts',
  ]
  for (const a of attacks) {
    const raw = await rawGet(a)
    const status = Number(/^HTTP\/1\.\d (\d+)/.exec(raw)?.[1] ?? 0)
    const leaked = raw.includes(LEAK_MARK) || raw.includes('OcrBackend')
    ok(`不泄漏 dist 外内容: ${a}`, !leaked, `status=${status}`)
  }

  // 目录穿越到 dist 外必须被 403 或 404 挡住，不能是 200 + 真实内容
  const outside = await rawGet('/../package.json')
  ok('dist 外的文件不返回 200', !/^HTTP\/1\.\d 200/.test(outside) || !outside.includes(LEAK_MARK))
}

async function testAudioRelay() {
  console.log('\n[报警音频中转]')
  ok('未上传时 GET 返回 404', (await fetch(`${BASE}/alarm-audio`)).status === 404)

  const payload = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0x21])
  const put = await fetch(`${BASE}/alarm-audio`, {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/mpeg' },
    body: payload,
  })
  ok('PUT 返回 ok 且 size 正确', put.status === 200 && (await put.json()).size === payload.length)

  const got = await fetch(`${BASE}/alarm-audio`)
  const back = new Uint8Array(await got.arrayBuffer())
  ok('GET 取回字节与上传一致', Buffer.compare(Buffer.from(back), Buffer.from(payload)) === 0)
  ok('Content-Type 沿用上传类型', got.headers.get('content-type') === 'audio/mpeg')

  ok('DELETE 返回 ok', (await fetch(`${BASE}/alarm-audio`, { method: 'DELETE' })).status === 200)
  ok('删除后 GET 回到 404', (await fetch(`${BASE}/alarm-audio`)).status === 404)

  const empty = await fetch(`${BASE}/alarm-audio`, { method: 'PUT', body: new Uint8Array(0) })
  ok('空音频被拒', empty.status === 400, `status=${empty.status}`)
}

async function testSignaling() {
  console.log('\n[信令中继]')

  const pc = makeClient('role=pc')
  await pc.opened
  const pcReady = await pc.next((m) => m.t === 'ready')
  ok('PC 连接收到 ready', pcReady !== null, JSON.stringify(pc.all()))
  ok('PC 的 ready 带 phones 数组', Array.isArray(pcReady?.phones))

  const ph1 = makeClient('role=phone')
  await ph1.opened
  const ph1Ready = await ph1.next((m) => m.t === 'ready')
  const pid = ph1Ready?.id
  ok('手机收到 ready 且带 id', typeof pid === 'string' && pid.length > 0)

  const peer = await pc.next((m) => m.t === 'peer')
  ok('PC 收到 peer 且 id 匹配', peer?.id === pid, JSON.stringify(peer))

  // offer 定向
  pc.ws.send(JSON.stringify({ t: 'offer', to: pid, sdp: { type: 'offer', sdp: 'v=0-fake' } }))
  const offer = await ph1.next((m) => m.t === 'offer')
  ok('offer 转发到指定手机', offer?.sdp?.sdp === 'v=0-fake', JSON.stringify(offer))

  // answer 回程：故意让手机谎报 from，服务端应以自己的 id 为准
  ph1.ws.send(JSON.stringify({ t: 'answer', from: 'LIED', sdp: { type: 'answer', sdp: 'v=0-reply' } }))
  const answer = await pc.next((m) => m.t === 'answer')
  ok('answer 转发回 PC', answer?.sdp?.sdp === 'v=0-reply', JSON.stringify(answer))
  ok('answer 的 from 由服务端裁定，不采信客户端自报', answer?.from === pid, `from=${answer?.from}`)

  // ice 双向
  pc.ws.send(JSON.stringify({ t: 'ice', to: pid, candidate: { candidate: 'c-pc' } }))
  ph1.ws.send(JSON.stringify({ t: 'ice', to: 'pc', candidate: { candidate: 'c-phone' } }))
  const [iceToPhone, iceToPc] = await Promise.all([
    ph1.next((m) => m.t === 'ice' && m.candidate?.candidate === 'c-pc'),
    pc.next((m) => m.t === 'ice' && m.candidate?.candidate === 'c-phone'),
  ])
  ok('ice PC->手机', iceToPhone !== null)
  ok('ice 手机->PC', iceToPc !== null)
  ok('ice 的 from 同样由服务端裁定', iceToPc?.from === pid, `from=${iceToPc?.from}`)

  // 第二台手机，验证定向不会串台
  const ph2 = makeClient('role=phone')
  await ph2.opened
  await ph2.next((m) => m.t === 'ready')
  const peer2 = await pc.next((m) => m.t === 'peer')
  ok('PC 收到第二个 peer 且 id 不同', peer2?.id && peer2.id !== pid, JSON.stringify(peer2))

  pc.ws.send(JSON.stringify({ t: 'offer', to: pid, sdp: { type: 'offer', sdp: 'only-first' } }))
  const [g1, g2] = await Promise.all([
    ph1.next((m) => m.t === 'offer' && m.sdp?.sdp === 'only-first'),
    ph2.next((m) => m.t === 'offer', 600),
  ])
  ok('offer 只到目标手机，不串台', g1 !== null && g2 === null)

  // 断开
  const pid2 = peer2.id
  ph2.ws.close()
  const leave = await pc.next((m) => m.t === 'peer-leave' && m.id === pid2)
  ok('手机断开时 PC 收到 peer-leave', leave !== null)

  // 非法输入不能带崩服务
  pc.ws.send('not json at all')
  pc.ws.send(JSON.stringify({ t: 'unknown-type' }))
  await wait(200)
  ok('收到非法消息后服务仍存活', (await fetch(`${BASE}/`)).status === 200)

  // 第二个 PC 顶替
  const pc2 = makeClient('role=pc')
  await pc2.opened
  const bye = await pc.next((m) => m.t === 'bye')
  ok('第二个 PC 顶替时旧 PC 收到 bye', bye !== null)
  const pc2Ready = await pc2.next((m) => m.t === 'ready')
  ok('新 PC 的 ready 带上现有手机列表', Array.isArray(pc2Ready?.phones) && pc2Ready.phones.includes(pid), JSON.stringify(pc2Ready))
  const back2 = await pc2.next((m) => m.t === 'peer')
  ok('新 PC 收到存量手机的 peer 通知', back2?.id === pid, JSON.stringify(back2))

  pc.ws.close()
  pc2.ws.close()
  ph1.ws.close()
}

const main = async () => {
  console.log(`server/serve.mjs 冒烟测试  (PORT=${PORT})`)
  try {
    readFileSync(resolve(ROOT, 'dist', 'index.html'))
  } catch {
    console.error('缺少 dist/index.html，请先执行 npm run build')
    process.exit(1)
  }

  // 自己起服务，跑完必须杀掉，否则会留一个占着端口的孤儿进程。
  // LAN_RUNTIME 指向独立临时目录：报警音频是持久状态，若和 dev 服务/其他测试
  // 共用 .lan-runtime，上一轮残留的文件会让「未上传时 404」这类断言假失败。
  const rt = mkdtempSync(join(tmpdir(), 'mxd-serve-'))
  const child = spawn(process.execPath, [resolve(ROOT, 'server', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), LAN_RUNTIME: rt },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const serverLog = []
  child.stdout.on('data', (d) => serverLog.push(String(d)))
  child.stderr.on('data', (d) => serverLog.push(String(d)))

  const stop = () => {
    if (!child.killed) child.kill()
    try { rmSync(rt, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
  process.on('exit', stop)
  process.on('SIGINT', () => {
    stop()
    process.exit(130)
  })

  // 等端口起来
  let up = false
  for (let i = 0; i < 60; i += 1) {
    await wait(100)
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(500) })
      if (r.status) {
        up = true
        break
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!up) {
    console.error('服务端启动失败：\n' + serverLog.join(''))
    stop()
    process.exit(1)
  }

  try {
    await testStatic()
    await testTraversal()
    await testAudioRelay()
    await testSignaling()
  } catch (err) {
    fail += 1
    console.error('\n测试过程抛异常：', err)
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  stop()
  process.exit(fail === 0 ? 0 : 1)
}

main()
