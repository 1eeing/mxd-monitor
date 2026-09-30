/**
 * 视频链路 E2E 测试：真实采集 → WebRTC → 手机端解码渲染。
 *
 * 冒烟测试（tests/browser.test.mjs）只验证了「信令 + DataChannel + 状态同步」，
 * 视频轨这条最关键的路当时完全没有覆盖：PC 的屏幕流有没有真的被
 * useLanMirror 消费并 addTrack、removeTrack 后重协商是否正常、手机端
 * 到底有没有解出画面。这几个问题只有把真浏览器和真 PeerConnection 串起来才暴露得出来。
 *
 * 用 Chrome 的假采集参数拿到一条测试视频轨（--use-fake-ui-for-media-stream
 * 自动确认选择器，--auto-select-desktop-capture-source 选整个屏幕），
 * 绕开真实屏幕选择器，但保留完整的 getDisplayMedia → addTrack → 传输 → 解码路径。
 *
 * 另外强制 backend=wasm：headless 里没有可用 GPU，跑 WebGPU 必失败。
 *
 * 用法：node tests/video.test.mjs
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
const PORT = Number(process.env.TEST_PORT ?? 5213)
const BASE = `http://127.0.0.1:${PORT}`
const CDP_PORT = Number(process.env.CDP_PORT ?? 9334)

/**
 * PC 页必须走 127.0.0.1（= secure context），手机页走局域网 IP。
 *
 * 这不是偷懒，而是真实部署形态的复刻：
 * - PC 端要跑 getDisplayMedia，而它只在 secure context 里存在。
 *   用 http://192.168.x.x 打开 PC 页时 navigator.mediaDevices 整个是 undefined，
 *   屏幕采集根本起不来（见 useScreenCapture 里的显式拦截）。
 *   所以 PC 侧应当走 EdgeOne 的 HTTPS 站点，这里用 127.0.0.1 等价替代。
 * - 手机端才是真正通过局域网 http 访问的那一端，用 LAN IP 才能覆盖到
 *   「非 secure context 下 WebRTC 仍可用」这个前提。
 */
const LAN_IP = process.env.TEST_LAN_IP ?? lanIp()
const PHONE_BASE = LAN_IP ? `http://${LAN_IP}:${PORT}` : BASE

const { ok, finish } = createReporter('视频链路 E2E 测试')

/** 页面脚本执行前注入：强制 WASM 后端，避开 headless 无 GPU 的问题 */
const FORCE_WASM = `
  try {
    localStorage.setItem('mxd-monitor.settings.v1', JSON.stringify({
      ocrIntervalMs: 30000,
      backend: 'wasm',
      keywords: [{ id: 'k1', label: '测谎', pattern: '测谎小游戏开始', enabled: true }],
      crop: { enabled: false, left: 0, top: 0, width: 1, height: 1, scale: 1 },
      useCustomAudio: false,
      customAudioName: '',
    }))
  } catch {}
`

const main = async () => {
  console.log(`视频链路 E2E 测试  (PC ${BASE} / 手机 ${PHONE_BASE}, Chrome CDP :${CDP_PORT})`)

  const server = spawn(process.execPath, [join(ROOT, 'server', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  })

  const { cleanup: cleanupChrome } = launchChrome({
    cdpPort: CDP_PORT,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--disable-features=Translate,MediaRouter',
    ],
  })
  const cleanup = installCleanup(cleanupChrome, () => {
    try {
      server.kill()
    } catch {}
  })

  try {
    if (!(await waitForHttp(`${BASE}/`))) throw new Error('服务端没起来')
    const wsUrl = await waitForCdp(CDP_PORT)
    if (!wsUrl) throw new Error('Chrome 调试端口没起来')
    const cdp = await Cdp.attach(wsUrl)

    // ---- 建链 ----
    const pc = await Page.open(cdp, `${BASE}/`, 'pc', { beforeLoad: FORCE_WASM })
    ok(
      'PC 页就绪',
      (await pc.waitFor(
        `[...document.querySelectorAll('button')].some(b => b.textContent.includes('连接手机'))`,
        20000,
      )) === true,
    )
    await pc.clickText('button', '连接手机')
    ok(
      '点开镜像弹窗',
      (await pc.waitFor(
        `[...document.querySelectorAll('button')].some(b => b.textContent.includes('开启镜像'))`,
        5000,
      )) === true,
    )
    await pc.clickText('button', '开启镜像')
    ok(
      'PC 信令连上本地服务',
      (await pc.waitFor(
        `[...document.querySelectorAll('.lan-status')].some(e => e.textContent.includes('已连上本地镜像服务'))`,
        10000,
      )) === true,
    )

    const ph = await Page.open(cdp, `${PHONE_BASE}/phone.html`, 'phone', { beforeLoad: FORCE_WASM })
    ok('手机页挂载成功（局域网 IP，非 secure context）', (await ph.waitFor(`!!document.querySelector('.p-app')`, 15000)) === true)

    ok(
      'PC 侧看到 1 台手机已连接',
      (await pc.waitFor(
        `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('连接手机')); return b?.querySelector('.header-badge')?.textContent === '1' })()`,
        20000,
      )) === true,
    )
    ok(
      '手机侧显示「已连接电脑」',
      (await ph.waitFor(`document.querySelector('.p-status-row')?.textContent?.includes('已连接电脑')`, 20000)) ===
        true,
    )
    ok(
      '监控未开时手机显示视频占位',
      (await ph.eval(`!!document.querySelector('.p-video-placeholder')`)) === true,
    )

    // ---- 开始监控：轨道必须立刻挂上 ----
    ok('点击「开始监控」', (await pc.clickText('button', '开始监控')) === true)

    // capture-badge 是在 isCapturing 为真时才渲染的「共享中」徽标，
    // 它出现即说明 screen.streamRef 已经有流（useLanMirror 消费的就是它）
    const shared = await pc.waitFor(
      `(() => { const b = document.querySelector('.capture-badge'); return b && !b.className.includes('warn') && b.textContent.includes('共享中') })()`,
      25000,
    )
    ok('PC 屏幕共享生效（streamRef 有流）', shared === true)

    // 状态同步到非 idle，证明 initializing 状态也过了 DataChannel
    ok(
      '手机收到「正在启动监控…」状态',
      (await ph.waitFor(
        `(() => { const t = document.querySelector('.p-status-text')?.textContent || ''; return t.includes('正在启动监控') || t.includes('监控运行中') })()`,
        15000,
      )) === true,
    )

    // ---- 手机端真的解出画面 ----
    const dims = await ph.waitFor(
      `(() => { const v = document.querySelector('.p-video'); return v && v.videoWidth > 0 ? (v.videoWidth + 'x' + v.videoHeight) : 0 })()`,
      30000,
    )
    ok('手机端视频解出画面（videoWidth>0）', typeof dims === 'string' && dims.includes('x'), String(dims))
    ok('有画面后占位消失', (await ph.eval(`!!document.querySelector('.p-video-placeholder')`)) === false)

    // videoWidth>0 只说明元数据到了；用 rVFC 数真正呈现的帧数，
    // 才能排除「拿到轨但一帧都没解出来」
    const framed = await ph.eval(`(async () => {
      const v = document.querySelector('.p-video')
      if (typeof v.requestVideoFrameCallback !== 'function') return 'unsupported'
      const first = await new Promise((res) => {
        let done = false
        v.requestVideoFrameCallback((now, meta) => { if (!done) { done = true; res(meta) } })
        setTimeout(() => { if (!done) { done = true; res(null) } }, 20000)
      })
      if (!first) return 0
      const start = first.presentedFrames
      await new Promise((r) => setTimeout(r, 3000))
      return await new Promise((res) => {
        v.requestVideoFrameCallback((now, meta) => res(meta.presentedFrames - start))
      })
    })()`)
    ok(
      '手机端持续解出多帧（不是只拿到元数据）',
      framed === 'unsupported' || (typeof framed === 'number' && framed >= 2),
      `3 秒内新呈现帧数=${framed}`,
    )

    // ---- 停止监控：removeTrack + 重协商后应回到占位 ----
    ok('点击「停止监控」', (await pc.clickText('button', '停止监控')) === true)
    ok(
      'PC 回到未共享（capture-badge 消失）',
      (await pc.waitFor(`!document.querySelector('.capture-badge')`, 15000)) === true,
    )
    ok(
      '手机状态回归「监控未开始」',
      (await ph.waitFor(
        `document.querySelector('.p-status-text')?.textContent?.includes('监控未开始')`,
        15000,
      )) === true,
    )
    ok(
      '手机端视频占位恢复（轨道已移除）',
      (await ph.waitFor(`!!document.querySelector('.p-video-placeholder')`, 15000)) === true,
    )
    ok(
      '手机端不再显示旧画面（video 已卸载或无尺寸）',
      (await ph.eval(
        `(() => { const v = document.querySelector('.p-video'); return !v || v.videoWidth === 0 })()`,
      )) === true,
    )

    console.log('\n[控制台错误]')
    // 过滤 OCR 引擎与 headless 媒体设备相关的固有噪音
    const noise = /onnx|ort|wasm|SharedArrayBuffer|Failed to load resource.*(models|onnx)|mediaDevices|NotFoundError/i
    const real = [...pc.errors, ...ph.errors].filter((e) => !noise.test(e))
    ok('两个页面均无相关 console 错误', real.length === 0, real.slice(0, 3).join(' | '))
  } catch (err) {
    ok('测试过程未抛异常', false, String(err))
  }

  const failures = finish()
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}

main()
