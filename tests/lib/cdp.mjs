/**
 * CDP 测试公共库：极简 Chrome DevTools Protocol 客户端 + 页面封装。
 *
 * 单独抽出来是因为有两个浏览器测试（冒烟、视频链路）都要用同一套
 * attach / 导航 / 求值 / 点按钮的能力，复制一份只会让两边行为漂移。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

export const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 找本机内网 IPv4：PC 页只有在以局域网 IP 打开时才会渲染二维码（localhost 会刻意拒绝） */
export function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return null
}

/** 断言计数器：两个测试文件各建一个，避免全局共享 */
export function createReporter(label) {
  const state = { pass: 0, fail: 0 }
  return {
    ok(name, cond, extra = '') {
      if (cond) {
        state.pass += 1
        console.log(`  ✓ ${name}`)
      } else {
        state.fail += 1
        console.log(`  ✗ ${name}${extra ? `  -> ${extra}` : ''}`)
      }
    },
    finish() {
      console.log(`\n${label}：通过 ${state.pass}，失败 ${state.fail}`)
      return state.fail
    },
    get counts() {
      return { ...state }
    },
  }
}

/** 极简 CDP 客户端：一个 WebSocket + 自增 id 配对 */
export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Set()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (!p) return
        if (msg.error) p.rej(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
        else p.res(msg.result)
        return
      }
      for (const fn of [...this.listeners]) fn(msg)
    })
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${method} 超时`))
      }, 60000)
    })
  }

  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

/** 一个页面：负责 attach、导航、求值、收集 console 错误 */
export class Page {
  constructor(cdp, sessionId, label) {
    this.cdp = cdp
    this.sessionId = sessionId
    this.label = label
    this.errors = []
  }

  static async open(cdp, url, label, { beforeLoad } = {}) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(cdp, sessionId, label)
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        page.errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails
        page.errors.push(d?.exception?.description ?? d?.text ?? 'unknown')
      }
    })
    await page.cdp.send('Page.enable', {}, sessionId)
    await page.cdp.send('Runtime.enable', {}, sessionId)
    if (beforeLoad) {
      // 必须在页面脚本执行前注入，否则 localStorage 已经被读过一次了
      await page.cdp.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: `(() => { try { ${beforeLoad} } catch {} })()` },
        sessionId,
      )
    }
    await page.goto(url)
    return page
  }

  async goto(url) {
    await this.cdp.send('Page.navigate', { url }, this.sessionId)
    for (let i = 0; i < 200; i += 1) {
      await wait(100)
      const r = await this.eval('document.readyState')
      if (r === 'complete') return
    }
    throw new Error(`${this.label}: 加载超时`)
  }

  /** 在页面里求值，返回 JSON 化的结果 */
  async eval(expression) {
    const r = await this.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
    )
    if (r.exceptionDetails) {
      throw new Error(
        `${this.label}: 求值抛错 ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`,
      )
    }
    return r.result?.value
  }

  /** 按可见文本点按钮 */
  clickText(selector, text) {
    return this.eval(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((e) => (e.textContent || '').includes(${JSON.stringify(text)}))
      if (!el) return false
      el.click()
      return true
    })()`)
  }

  /** 轮询直到表达式为真值；超时返回 null */
  async waitFor(expression, ms = 12000) {
    const deadline = Date.now() + ms
    for (;;) {
      const v = await this.eval(expression)
      if (v) return v
      if (Date.now() > deadline) return null
      await wait(150)
    }
  }

  /** 轮询到条件成立，返回最后一次求值的原始值（可能为 0/false） */
  async waitUntil(expression, ms = 12000) {
    const deadline = Date.now() + ms
    let last
    for (;;) {
      last = await this.eval(expression)
      if (last) return last
      if (Date.now() > deadline) return last === undefined ? null : last
      await wait(150)
    }
  }
}

/** 起一个 headless Chrome，返回 { chrome, profile, cleanup } */
export function launchChrome({ cdpPort, args = [], chromePath = process.env.CHROME_PATH ?? DEFAULT_CHROME }) {
  const profile = mkdtempSync(join(tmpdir(), 'mxd-cdp-'))
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      ...args,
    ],
    { stdio: 'ignore' },
  )
  const cleanup = () => {
    try {
      chrome.kill()
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
  return { chrome, profile, cleanup }
}

/** 等 HTTP 服务就绪 */
export async function waitForHttp(url, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    await wait(150)
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return true
    } catch {}
  }
  return false
}

/** 等 Chrome 调试端口就绪，返回 WebSocket 地址 */
export async function waitForCdp(port, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    await wait(150)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      const wsUrl = (await r.json()).webSocketDebuggerUrl
      if (wsUrl) return wsUrl
    } catch {}
  }
  return null
}

/** 装好退出清理，避免 Chrome / 服务端进程泄漏 */
export function installCleanup(...fns) {
  const cleanup = () => {
    for (const fn of fns) {
      try {
        fn()
      } catch {}
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  return cleanup
}
