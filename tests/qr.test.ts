/**
 * src/lan/qr.ts 的单元测试。
 *
 * qr.ts 里手写的部分是「模块矩阵 -> SVG path」这一步（逐行合并连续深色格 + 静区偏移），
 * 这段最容易写错且出错后不会抛异常，只会扫不出码，所以必须回读校验：
 * 把生成的 path 重新解析成网格，逐格和 qrcode 的原始矩阵比对。
 *
 * 用法：node src/lan/qr.test.ts（Node 24 原生支持类型擦除）
 */
import { create } from 'qrcode/lib/core/qrcode.js'
import { buildQr, lanAddressable, qrTargetReachable } from '../src/lan/qr.ts'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? `  -> ${extra}` : ''}`)
  }
}

/** 把 path 解析回网格：M<x> <y>h<len>v1h-<len>z */
function parsePath(path: string, size: number): boolean[][] {
  const grid: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const re = /M(\d+) (\d+)h(\d+)v1h-\d+z/g
  let m: RegExpExecArray | null
  while ((m = re.exec(path)) !== null) {
    const x = Number(m[1])
    const y = Number(m[2])
    const len = Number(m[3])
    for (let i = 0; i < len; i += 1) {
      if (y < 0 || y >= size || x + i >= size) continue
      grid[y][x + i] = true
    }
  }
  return grid
}

const QUIET = 4

function checkRoundTrip(text: string, label: string): void {
  const qr = buildQr(text)
  if (!qr) {
    ok(`${label}：能生成`, false, 'buildQr 返回 null')
    return
  }
  const ref = create(text, { errorCorrectionLevel: 'M' })
  const size = ref.modules.size

  ok(`${label}：viewBox = 边长 + 2×静区`, qr.viewBox === size + QUIET * 2, `${qr.viewBox} vs ${size + QUIET * 2}`)

  // 解析出的网格（去掉静区偏移）与原始矩阵比对
  const full = parsePath(qr.path, qr.viewBox)
  const grid: boolean[][] = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => full[y + QUIET][x + QUIET]),
  )

  let diff = 0
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const want = ref.modules.data[y * size + x] === 1
      if (grid[y][x] !== want) diff += 1
    }
  }
  ok(`${label}：${size}×${size} 矩阵逐格一致`, diff === 0, `${diff} 格不一致`)

  // 静区必须全空，否则定位图案贴边会扫不出来
  let quietDirty = 0
  for (let y = 0; y < qr.viewBox; y += 1) {
    for (let x = 0; x < qr.viewBox; x += 1) {
      const inQuiet = y < QUIET || x < QUIET || y >= qr.viewBox - QUIET || x >= qr.viewBox - QUIET
      if (inQuiet && full[y][x]) quietDirty += 1
    }
  }
  ok(`${label}：静区留白未被占用`, quietDirty === 0, `${quietDirty} 格`)

  // 三个定位图案的深色外框，位置固定，可以直接验
  const finder = (ox: number, oy: number) => {
    let hit = true
    for (let i = 0; i < 7; i += 1) {
      hit = hit && full[oy + QUIET + i][ox + QUIET]
      hit = hit && full[oy + QUIET + i][ox + QUIET + 6]
      hit = hit && full[oy + QUIET][ox + QUIET + i]
      hit = hit && full[oy + QUIET + 6][ox + QUIET + i]
    }
    return hit
  }
  ok(`${label}：左上定位图案外框完整`, finder(0, 0))
  ok(`${label}：右上定位图案外框完整`, finder(size - 7, 0))
  ok(`${label}：左下定位图案外框完整`, finder(0, size - 7))
}

console.log('[qr.ts]')
checkRoundTrip('http://192.168.1.19:5199/phone.html', '局域网 URL')
checkRoundTrip('http://10.0.0.7:5199/phone.html', '另一段 IP')
checkRoundTrip('https://example.com/a-fairly-long-path/phone.html?x=1&y=2', '长 URL')

ok('空字符串返回 null', buildQr('') === null)
ok('纯空白返回 null', buildQr('   ') === null)
ok('首尾空白被裁掉后仍能编码', buildQr('  http://192.168.1.19:5199/phone.html  ') !== null)
ok('超长内容返回 null 而非抛错', buildQr('x'.repeat(8000)) === null)

console.log('\n[lanAddressable]')
// 这个函数读 window.location，node 环境下没有 window，用最小桩
const g = globalThis as unknown as { window?: unknown }
g.window = { location: { protocol: 'http:', hostname: '192.168.1.19', port: '5199' } }
ok('局域网 IP 判定为可用', (() => {
  const r = lanAddressable()
  return r.ok && r.host === '192.168.1.19:5199'
})())
// 注意：lanAddressable 只是「页面地址」的兜底拼装，不再负责拒绝 localhost。
// PC 端必须用 localhost 打开才有 secure context（否则 getDisplayMedia 不存在），
// 二维码内容由服务端 ready 消息里的局域网地址决定。可达性检查挪到了
// qrTargetReachable —— 校验最终拿去编码的那个地址。
ok('localhost 仍可拼出地址（由后续可达性检查兜底）', lanAddressable().ok)
g.window = { location: { protocol: 'http:', hostname: '10.1.2.3', port: '' } }
ok('无端口时 host 不带多余冒号', (() => {
  const r = lanAddressable()
  return r.ok && r.host === '10.1.2.3'
})())
g.window = { location: { protocol: 'file:', hostname: '', port: '' } }
ok('非 http(s) 协议判定为不可用', !lanAddressable().ok)
delete g.window

console.log('\n[qrTargetReachable]')
ok('局域网 IP 可达', qrTargetReachable('http://192.168.1.19:5199/phone.html').ok)
ok(
  'localhost 地址不可达并给出中文原因',
  (() => {
    const r = qrTargetReachable('http://localhost:5199/phone.html')
    return !r.ok && r.reason.includes('localhost')
  })(),
)
ok('127.0.0.1 地址不可达', !qrTargetReachable('http://127.0.0.1:5199/phone.html').ok)
ok('IPv6 回环不可达', !qrTargetReachable('http://[::1]:5199/phone.html').ok)
ok('无法解析的地址判为不可达', !qrTargetReachable('这不是地址').ok)

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
