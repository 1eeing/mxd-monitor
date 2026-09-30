/**
 * 浏览器端冒烟测试：用 Chrome DevTools Protocol 驱动真实 Chrome 跑一遍。
 *
 * 覆盖 Node 侧测不到的部分：
 * - qrcode 是 CJS 包，Vite 的具名导出互操作在浏览器里可能拿到 undefined
 *   （构建不报错、运行才炸），必须真在浏览器里点一次「开启镜像」看二维码出不出来；
 * - React 弹窗挂载、PC 页与手机页的 WebSocket / DataChannel 是否真的连上；
 * - 页面有没有 console 报错或未捕获异常。
 *
 * 视频链路（真采集 → WebRTC → 手机渲染）由 tests/video.test.mjs 单独覆盖。
 *
 * 用法：node tests/browser.test.mjs
 */
import { spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Cdp,
  Page,
  createReporter,
  installCleanup,
  lanIp,
  launchChrome,
  waitForCdp,
  waitForHttp,
} from './lib/cdp.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.TEST_PORT ?? 5212)
const BASE = `http://127.0.0.1:${PORT}`
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333)

const LAN_IP = process.env.TEST_LAN_IP ?? lanIp()
const BASE_LAN = LAN_IP ? `http://${LAN_IP}:${PORT}` : null

const { ok, finish } = createReporter('浏览器冒烟测试')


const main = async () => {
  console.log(`浏览器冒烟测试  (${BASE}, Chrome CDP :${CDP_PORT})`)

  const server = spawn(process.execPath, [join(ROOT, 'server', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  })

  const { cleanup: cleanupChrome } = launchChrome({ cdpPort: CDP_PORT, args: ['--disable-gpu'] })
  const cleanup = installCleanup(cleanupChrome, () => {
    try {
      server.kill()
    } catch {}
  })

  // 等服务端和 Chrome 都就绪
  await waitForHttp(`${BASE}/`)
  const wsUrl = await waitForCdp(CDP_PORT)
  if (!wsUrl) {
    console.error('Chrome 调试端口没起来')
    cleanup()
    process.exit(1)
  }

  try {
    const cdp = await Cdp.attach(wsUrl)

    console.log('\n[PC 页面用 localhost 打开：应拒绝给二维码]')
    // PC 端必须用 localhost 打开才有 secure context（否则 getDisplayMedia 不存在），
    // 所以这里验证的是相反的命题：localhost 打开也必须能给出可扫的二维码，
    // 内容由服务端 ready 消息里的局域网地址决定，而不是 location.hostname。
    const loopPage = await Page.open(cdp, `${BASE}/`, 'pc-loopback')
    await loopPage.waitFor(
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('连接手机'))`, 15000,
    )
    ok('PC 页渲染出「📱 连接手机」按钮', (await loopPage.clickText('button', '连接手机')) === true)
    ok('点开弹窗', (await loopPage.waitFor(
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('开启镜像'))`, 5000)) === true)
    await loopPage.clickText('button', '开启镜像')
    const loopQrUrl = await loopPage.waitFor(`document.querySelector('.lan-url')?.textContent || ''`, 10000)
    ok(
      'localhost 打开时二维码内容是局域网地址（不是 localhost）',
      /\/phone\.html$/.test(String(loopQrUrl)) && !String(loopQrUrl).includes('127.0.0.1'),
      String(loopQrUrl),
    )
    ok('localhost 打开时也能渲染二维码', (await loopPage.eval(`!!document.querySelector('svg.lan-qr')`)) === true)

    if (!BASE_LAN) {
      console.log('\n(!) 没找到内网 IPv4，跳过二维码渲染检查（可用 TEST_LAN_IP 指定）')
    }

    console.log('\n[PC 页面用局域网 IP 打开：二维码与手机连通]')
    const pageBase = BASE_LAN ?? BASE
    const pc = await Page.open(cdp, `${pageBase}/`, 'pc')
    const hasButton = await pc.waitFor(
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('连接手机'))`,
      15000,
    )
    ok('PC 页渲染出「📱 连接手机」按钮', hasButton === true)

    console.log('\n[二维码（CJS 互操作的关键验证）]')
    ok('点开弹窗', (await pc.clickText('button', '连接手机')) === true)
    ok('弹窗里有「开启镜像」', (await pc.waitFor(
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('开启镜像'))`, 5000)) === true)
    ok('点「开启镜像」', (await pc.clickText('button', '开启镜像')) === true)

    if (BASE_LAN) {
      const qr = await pc.waitFor(
        `(() => { const s = document.querySelector('svg.lan-qr'); return s ? (s.querySelector('path')?.getAttribute('d') || '').length : 0 })()`,
        10000,
      )
      ok('二维码 SVG 渲染出来了（qrcode 的 CJS 具名导出在浏览器里可用）', typeof qr === 'number' && qr > 200, `path 长度=${qr}`)

      // viewBox 形如 "0 0 37 37"，取第三段才是边长（整体 Number() 会得到 NaN）
      const size = await pc.eval(`document.querySelector('svg.lan-qr')?.getAttribute('viewBox') ?? null`)
      const side = size === null ? NaN : Number(String(size).trim().split(/\s+/)[2])
      ok('二维码 viewBox = 边长 + 2×静区（29+8=37）', side === 37, `viewBox=${size}`)

      const box = await pc.eval(
        `(() => { const s = document.querySelector('svg.lan-qr'); if (!s) return null; const r = s.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) })()`,
      )
      ok('二维码有实际渲染尺寸（手机能扫）', typeof box === 'string' && box.startsWith('2') && box.includes('x2'), String(box))

      const urlText = await pc.eval(`document.querySelector('.lan-url')?.textContent || ''`)
      ok('弹窗显示手机端地址', urlText.includes('phone.html') && urlText.includes(String(PORT)), urlText)
      // 关键不变式：不管 PC 用哪个地址打开，弹窗里的地址都必须是局域网 IP。
      // 之前它取自 location.hostname，PC 端为了 secure context 只能用 localhost 打开，
      // 于是二维码变成死链——这正是 tests/video.test.mjs 逼出来的改动。
      ok(
        '二维码地址是局域网 IP 而非页面 host',
        !/localhost|127\.0\.0\.1/.test(urlText) && /^\s*https?:\/\/\d+\.\d+\.\d+\.\d+/.test(urlText),
        urlText,
      )
    }

    const signaled = await pc.waitFor(
      `[...document.querySelectorAll('.lan-status')].some(e => e.textContent.includes('已连上本地镜像服务'))`,
      8000,
    )
    ok('PC 页面信令连上本地服务', signaled === true)

    console.log('\n[手机页面 + DataChannel]')
    const ph = await Page.open(cdp, `${pageBase}/phone.html`, 'phone')
    const mounted = await ph.waitFor(`!!document.querySelector('.p-app')`, 10000)
    ok('手机页挂载成功', mounted === true)
    ok('手机页显示等待状态', (await ph.eval(`document.querySelector('.p-status-row')?.textContent || ''`)).includes('电脑'))

    // DataChannel 通了以后，PC 侧 phoneCount 会变成 1
    const connected = await pc.waitFor(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('连接手机')); return b?.querySelector('.header-badge')?.textContent === '1' })()`,
      15000,
    )
    ok('PC 侧看到 1 台手机已连接（信令 + PeerConnection 建立）', connected === true)

    const phLinked = await ph.waitFor(
      `document.querySelector('.p-status-row')?.textContent?.includes('已连接电脑')`, 15000,
    )
    ok('手机侧显示「已连接电脑」', phLinked === true)

    // 监控没开，状态应同步为「监控未开始」——证明 sync 消息真的过了 DataChannel
    const synced = await ph.waitFor(
      `document.querySelector('.p-status-text')?.textContent?.includes('监控未开始')`, 10000,
    )
    ok('手机收到 DataChannel 全量状态（监控未开始）', synced === true)

    // 音频解锁按钮必须在（iOS 上没它就没声音）
    const unlockBtn = await ph.eval(`document.querySelector('.p-unlock')?.textContent || ''`)
    ok('手机页有显眼的音频解锁按钮', unlockBtn.includes('开启报警声音'), unlockBtn)

    // DataChannel 上没有媒体轨：监控没开就不该有视频
    ok('监控未开时手机不显示视频占位以外的内容', (await ph.eval(`!!document.querySelector('.p-video-placeholder')`)) === true)

    console.log('\n[控制台错误]')
    // 过滤掉与本功能无关的噪音（OCR wasm / 媒体设备在 headless 下的报错）
    const noise = /onnx|ort|wasm|SharedArrayBuffer|Failed to load resource.*(models|onnx)|getDisplayMedia|NotFoundError.*mediaDevices/i
    const allErr = [...loopPage.errors, ...pc.errors, ...ph.errors]
    const real = allErr.filter((e) => !noise.test(e))
    ok('三个页面均无相关 console 错误', real.length === 0, real.slice(0, 3).join(' | '))
  } catch (err) {
    ok('测试过程未抛异常', false, String(err))
  }

  const failures = finish()
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}

main()