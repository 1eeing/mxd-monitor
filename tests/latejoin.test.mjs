/**
 * 晚连手机场景 E2E（PC 先共享 → 手机后连）。
 *
 * tests/video.test.mjs 走的是「手机先连、再开始监控」；本文件是反过来的顺序。
 * 真机上这个顺序过去必然连不上：诊断显示「对方候选：（无）、ICE 停在 new」，
 * 根因是信令层把双向的 ICE 候选都丢了（见 tests/serve.test.mjs 的契约断言）。
 *
 * 本文件负责锁住三条与顺序相关的不变式：
 *   1. 首个 offer 只带 DataChannel，视频轨在连接建立后才挂（见 useLanMirror 注释）
 *   2. 候选先于 offer 到达时仍能建连
 *   3. 视频真的在播——只查 videoWidth > 0 证明不了画面在动，
 *      而 iOS 拒绝自动播放时恰恰是「元素在、有尺寸、但一片黑」
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
const PORT = Number(process.env.TEST_PORT ?? 5215)
const BASE = `http://127.0.0.1:${PORT}`
const CDP_PORT = Number(process.env.CDP_PORT ?? 9336)
const LAN_IP = process.env.TEST_LAN_IP ?? lanIp()
const PHONE_BASE = LAN_IP ? `http://${LAN_IP}:${PORT}` : BASE

const { ok, finish } = createReporter('后连手机场景 E2E')

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

/**
 * 把**第一条** offer 消息推迟 2 秒，让 PC 的 ICE candidate 一定先于 offer 到达。
 *
 * 这不是模拟慢网络，而是把真实存在的竞态固定下来：offer 是 setLocalDescription
 * 完成后才发的，而 onicecandidate 与它是并发的，所以 candidate 完全可能先到。
 * 先到的候选会缓存在 pendingIceRef，等 offer 走完 setRemoteDescription 再补进去。
 *
 * 注意这个测试**抓不住**「候选被丢弃」那类 bug：同机 loopback 上 ICE 收集是瞬时的，
 * 候选直接进了 answer SDP，trickle 通道不是承重路径。真机上收集慢、answer 里没有
 * 候选，trickle 是唯一通道，所以那类 bug 在这里天然不可见。守住它的是
 * tests/serve.test.mjs 里的契约断言（「手机 ice 即使不带 to 也会转发给 PC」）。
 * 本测试的价值是覆盖「候选先到」这条时序本身仍然能正常建连。
 *
 * 用属性劫持而不是 stopImmediatePropagation：app 用的是 ws.onmessage = fn，
 * 而 Chrome 派发事件读的是内部 handler 槽位、不做 JS 属性查找，
 * 所以必须借原生 accessor 赋值，包装函数才会进到槽位里。
 */
const DELAY_OFFER = `
  window.__got = [];
  (() => {
    const Native = window.WebSocket
    // 必须借原生 accessor 赋值：Chrome 派发事件时读的是内部 handler 槽位，
    // 不做 JS 属性查找，所以直接 defineProperty 一个同名字段是拦不住的
    // （那样 app 的处理器进了自定义 getter，原生槽位始终为 null，消息全丢）。
    const desc = Object.getOwnPropertyDescriptor(Native.prototype, 'onmessage')
    window.WebSocket = class extends Native {
      constructor(...a) {
        super(...a)
        const self = this
        let delayed = false
        Object.defineProperty(this, 'onmessage', {
          configurable: true,
          get() { return desc.get.call(self) },
          set(fn) {
            desc.set.call(self, function (ev) {
              let t = '?'
              try { t = JSON.parse(ev.data).t } catch {}
              window.__got.push(t + (delayed ? '(延迟中)' : ''))
              if (!delayed && String(ev.data).includes('"offer"')) {
                delayed = true
                setTimeout(() => fn.call(self, ev), 2000)
                return
              }
              fn.call(self, ev)
            })
          },
        })
      }
    }
  })()
`

const main = async () => {
  console.log(`后连手机场景 E2E  (PC ${BASE} / 手机 ${PHONE_BASE}, CDP :${CDP_PORT})`)

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

    const pc = await Page.open(cdp, `${BASE}/`, 'pc', { beforeLoad: FORCE_WASM })
    ok(
      'PC 页就绪',
      (await pc.waitFor(
        `[...document.querySelectorAll('button')].some(b => b.textContent.includes('连接手机'))`,
        20000,
      )) === true,
    )

    // ===== 关键顺序：先共享，此时一台手机都没有 =====
    ok('点击「开始监控」', (await pc.clickText('button', '开始监控')) === true)
    const shared = await pc.waitFor(
      `(() => { const b = document.querySelector('.capture-badge'); return b && !b.className.includes('warn') && b.textContent.includes('共享中') })()`,
      25000,
    )
    ok('PC 已在共享（streamRef 有流，尚无手机接入）', shared === true)

    // 录下每次 setLocalDescription 产出的 SDP。
    // 关键不变式：首次 offer 只能是 DataChannel，不能带视频 m-line。
    // iOS Safari 上「首轮就带视频」的协商会让 ICE 永远停在 checking（真机实测），
    // 这条断言是为了防止日后有人把 addTrack 挪回建连时机。
    await pc.eval(`(() => {
      const orig = RTCPeerConnection.prototype.setLocalDescription
      window.__offers = []
      RTCPeerConnection.prototype.setLocalDescription = function (...a) {
        return orig.apply(this, a).then((r) => {
          window.__offers.push(this.localDescription?.sdp ?? '')
          return r
        })
      }
      return true
    })()`)

    await pc.clickText('button', '连接手机')
    await pc.clickText('button', '开启镜像')
    ok(
      'PC 信令连上本地服务',
      (await pc.waitFor(
        `[...document.querySelectorAll('.lan-status')].some(e => e.textContent.includes('已连上本地镜像服务'))`,
        10000,
      )) === true,
    )

    // ===== 手机此刻才连进来 =====
    const ph = await Page.open(cdp, `${PHONE_BASE}/phone.html`, 'phone', { beforeLoad: FORCE_WASM })
    ok('手机页挂载（局域网 IP，非 secure context）', (await ph.waitFor(`!!document.querySelector('.p-app')`, 15000)) === true)
    ok(
      'PC 侧看到 1 台手机',
      (await pc.waitFor(
        `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('连接手机')); return b?.querySelector('.header-badge')?.textContent === '1' })()`,
        20000,
      )) === true,
    )
    ok(
      '手机侧显示「已连接电脑」',
      (await ph.waitFor(`document.querySelector('.p-status-row')?.textContent?.includes('已连接电脑')`, 20000)) === true,
    )

    // 晚到的手机应立刻拿到已经在跑的视频轨
    const dims = await ph.waitFor(
      `(() => { const v = document.querySelector('.p-video'); return v && v.videoWidth > 0 ? (v.videoWidth + 'x' + v.videoHeight) : 0 })()`,
      30000,
    )
    ok('晚到的手机能解出画面', typeof dims === 'string' && dims.includes('x'), `videoWidth=${dims}`)

    // 首次 offer 的内容必须是这次修复的核心不变式
    const offerInfo = await pc.eval(`(() => {
      const list = window.__offers || []
      const first = list[0] ?? ''
      return JSON.stringify({
        count: list.length,
        firstHasVideo: /m=video/.test(first),
        firstHasData: /m=application/.test(first),
        laterHasVideo: list.slice(1).some(s => /m=video/.test(s)),
      })
    })()`)
    const oi = JSON.parse(String(offerInfo))
    console.log(`\n[协商] offer 共 ${oi.count} 个；首个带视频=${oi.firstHasVideo} 带DataChannel=${oi.firstHasData}`)
    ok('PC 发过 offer', oi.count > 0)
    ok('首个 offer 只带 DataChannel（真机 ICE 能否通的关键不变式）', oi.firstHasData && !oi.firstHasVideo)
    ok('视频轨在后续重协商里才出现', !oi.firstHasVideo && oi.laterHasVideo)

    // videoWidth>0 只说明元数据到了；paused===false 才说明真的在播。
    // iOS 拒绝自动播放时正是「有尺寸但黑屏」，只查尺寸会漏掉。
    const playing = await ph.waitFor(`(() => { const v = document.querySelector('.p-video'); return v ? v.paused === false : false })()`, 10000)
    ok('视频处于播放中（paused=false，不是有尺寸的黑屏）', playing === true)

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
      '持续解出多帧（画面在动，不是静止帧）',
      framed === 'unsupported' || (typeof framed === 'number' && framed >= 2),
      `3 秒内新呈现帧数=${framed}`,
    )

    // Chrome 无手势限制会自动播，不该冒出「点一下开始播放画面」这个兜底提示。
    // 真机上如果它出现，说明确实需要用户手势，UI 至少给了出口而不是默默黑屏。
    ok(
      '未出现「点一下开始播放画面」兜底提示',
      (await ph.eval(
        `[...document.querySelectorAll('.p-unlock')].some(b => b.textContent.includes('开始播放画面'))`,
      )) === false,
    )

    // 播放/暂停开关必须常驻：Safari 的自动播放既可能 reject，也可能不 reject
    // 却不渲染，用户需要一个随时能点的出口，不能只在报错时才出现。
    ok(
      '画面上常驻播放/暂停开关',
      (await ph.eval(`!!document.querySelector('.p-video-toggle')`)) === true,
    )
    ok('播放中时开关显示暂停图标', (await ph.eval(`document.querySelector('.p-video-toggle')?.textContent?.trim() === '⏸'`)) === true)

    // 暂停 → 画面真的停 → 再播 → 恢复
    await ph.eval(`(() => { const b = document.querySelector('.p-video-toggle'); if (b) b.click(); return !!b })()`)
    ok('点开关能暂停', (await ph.waitFor(`(() => { const v = document.querySelector('.p-video'); return v ? v.paused === true : false })()`, 5000)) === true)
    ok('暂停后按钮变成播放图标', (await ph.eval(`document.querySelector('.p-video-toggle')?.textContent?.trim() === '▶'`)) === true)

    await ph.eval(`(() => { const b = document.querySelector('.p-video-toggle'); if (b) b.click(); return !!b })()`)
    ok('再点能恢复播放', (await ph.waitFor(`(() => { const v = document.querySelector('.p-video'); return v ? v.paused === false : false })()`, 5000)) === true)
    const afterResume = await ph.waitFor(
      `(() => { const v = document.querySelector('.p-video'); return v && v.videoWidth > 0 ? v.videoWidth : 0 })()`,
      10000,
    )
    ok('恢复后仍有画面', typeof afterResume === 'number' && afterResume > 0, `videoWidth=${afterResume}`)

    console.log('\n[诊断面板]')
    // 诊断面板是排查真机问题唯一的依据，所以它自己必须先被验证过，
    // 并留下一份「健康状态」基线，方便和真机的输出对照。
    ok('诊断面板默认收起但存在', (await ph.eval(`!!document.querySelector('details.p-diag')`)) === true)
    await ph.eval(`(() => { const d = document.querySelector('details.p-diag'); if (d) d.open = true })()`)
    await ph.eval(`(() => { const b = [...document.querySelectorAll('.p-diag .p-link')].find(x => x.textContent.includes('刷新诊断')); if (b) b.click(); return !!b })()`)
    const diag = await ph.waitFor(`(document.querySelector('.p-diag-text')?.textContent || '').includes('bytes=')`, 10000)
    ok('点「刷新诊断」能出文本', diag === true)
    const diagText = await ph.eval(`document.querySelector('.p-diag-text')?.textContent ?? ''`)
    for (const line of String(diagText).split('\n')) console.log(`    ${line}`)

    // 健康基线：媒体包在收、帧在解、元素在播。真机若与此不同，对照即可定位环节。
    const num = (k) => Number(new RegExp(`${k}=(\\d+)`).exec(String(diagText))?.[1] ?? -1)
    ok('诊断：信令与通道都通', String(diagText).includes('signaling=true') && String(diagText).includes('peerReady=true'))
    ok('诊断：连接已建立', /connection=connected/.test(String(diagText)))
    ok('诊断：视频元素有尺寸', /video=\d+x\d+/.test(String(diagText)))
    ok('诊断：媒体包在收（bytes>0）', num('bytes') > 0, `bytes=${num('bytes')}`)
    ok('诊断：帧在解（framesDecoded>0）', num('framesDecoded') > 0, `framesDecoded=${num('framesDecoded')}`)
    // 候选明细必须在同机直连下能列出来：没有它就没法判断真机是没发候选、
    // 还是发了 .local、还是候选到了但包没通——这正是本次真机故障的定位依据。
    ok('诊断：列出了本端候选', !String(diagText).includes('本端候选: （无）'))
    ok('诊断：列出了对方候选', !String(diagText).includes('对方候选: （无）'))
    ok('诊断：列出了候选对', !String(diagText).includes('候选对: （无）'))
    ok('诊断：候选对里有 succeeded', /候选对: [^\n]*succeeded/.test(String(diagText)))

    console.log('\n[控制台错误]')
    const noise = /onnx|ort|wasm|SharedArrayBuffer|Failed to load resource.*(models|onnx)|mediaDevices|NotFoundError/i
    const real = [...pc.errors, ...ph.errors].filter((e) => !noise.test(e))
    ok('两个页面均无相关 console 错误', real.length === 0, real.slice(0, 3).join(' | '))

    // ===== 竞态：PC 的 candidate 先于 offer 到达 =====
    // 真机故障的真正触发条件。offer 在 setLocalDescription 完成后才发出，
    // 而 onicecandidate 与它并发，所以候选完全可能先到。
    // 之前这里会把已缓冲的候选清空，手机遂一个对方候选都没有。
    console.log('\n[candidate 先于 offer 到达]')
    // 只关第一台手机，PC 页面必须留着——镜像服务就跑在它里面，关了就没人发 offer 了
    await ph.close()
    const ph2 = await Page.open(cdp, `${PHONE_BASE}/phone.html`, 'phone2', {
      beforeLoad: FORCE_WASM + DELAY_OFFER,
    })
    ok('手机页挂载（offer 被刻意推迟）', (await ph2.waitFor(`!!document.querySelector('.p-app')`, 15000)) === true)

    // 断言竞态真的被触发了，而不是「碰巧通过」。
    // __got 是收到的消息序列：首条 offer 被扣住 2 秒，期间到达的 ice 候选
    // 会排在它后面——这正是「候选先到、被缓冲」的现场。
    // 注意 ice 的日志带「(延迟中)」后缀，匹配要用前缀而不是全等。
    const race = JSON.parse(
      String(
        await ph2.eval(`(() => {
          const got = window.__got || []
          const ice = got.map((g, i) => (g.indexOf('ice') === 0 ? i : -1)).filter((i) => i >= 0)
          const off = got.map((g, i) => (g.indexOf('offer') === 0 ? i : -1)).filter((i) => i >= 0)
          return JSON.stringify({ got, firstOffer: off[0] ?? -1, lastIce: ice.length ? ice[ice.length-1] : -1 })
        })()`),
      ),
    )
    console.log(`  [dbg] ph2 收到消息序列: ${race.got.join(' -> ')}`)
    ok(
      '竞态确实被触发（候选落在 offer 待处理期间）',
      race.firstOffer >= 0 && race.lastIce > race.firstOffer,
      `offer@${race.firstOffer} ice@${race.lastIce}`,
    )

    const raceDims = await ph2.waitFor(
      `(() => { const v = document.querySelector('.p-video'); return v && v.videoWidth > 0 ? (v.videoWidth + 'x' + v.videoHeight) : 0 })()`,
      45000,
    )
    ok('候选先到也能连上并出画面', typeof raceDims === 'string' && raceDims.includes('x'), `videoWidth=${raceDims}`)

    await ph2.eval(`(() => { const d = document.querySelector('details.p-diag'); if (d) d.open = true })()`)
    await ph2.eval(`(() => { const b = [...document.querySelectorAll('.p-diag .p-link')].find(x => x.textContent.includes('刷新诊断')); if (b) b.click(); return !!b })()`)
    await ph2.waitFor(`(document.querySelector('.p-diag-text')?.textContent || '').includes('候选对:')`, 10000)
    const raceDiag = String(await ph2.eval(`document.querySelector('.p-diag-text')?.textContent ?? ''`))
    for (const line of raceDiag.split('\n')) console.log(`    ${line}`)
    ok('竞态下对方候选非空（先到的候选没被丢弃）', !/对方候选: （无）/.test(raceDiag))
    ok('竞态下 ICE 建立成功', /connection=connected/.test(raceDiag))
  } catch (err) {
    ok('测试过程未抛异常', false, String(err))
  }

  const failures = finish()
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}

main()
