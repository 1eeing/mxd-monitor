/**
 * 生成二维码 SVG 路径。
 *
 * 只用 qrcode 的 core（出模块矩阵），不用它的 PNG 编码器：
 * 1) core 的唯一外部依赖是 dijkstrajs，而 PNG 那条链会拖进 pngjs / yargs 一大堆；
 * 2) 矩阵拿到手后自己画 SVG，可以直接用当前的 CSS 变量配色，
 *    还能顺手做「每行合并连续深色格」把路径压短。
 */
import { create } from 'qrcode/lib/core/qrcode.js'

/** 纠错等级 M：局域网 URL 长度固定（十几字节 IP + 固定路径），
 *  但手机是斜着拍电脑屏幕，M 的冗余足够抗住中等程度的模糊/反光。 */
const ECC = 'M' as const

/** 静区（quiet zone）模块数，规范要求至少 4 */
const QUIET = 4

export interface QrSvg {
  /** viewBox 尺寸（模块数 + 两侧静区），边长相等，可直接当 width/height */
  viewBox: number
  /** 拼接好的深色模块 path，填色由 CSS 控制 */
  path: string
}

/**
 * 把文本编码成二维码。
 *
 * @param text 二维码内容，局域网 URL
 * @returns SVG 绘制信息；文本过长超出可编码范围时返回 null（调用方应给出可读提示）
 */
export function buildQr(text: string): QrSvg | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  let size: number
  let data: Uint8Array
  try {
    const qr = create(trimmed, { errorCorrectionLevel: ECC })
    size = qr.modules.size
    data = qr.modules.data
  } catch {
    // 数据超出版本上限时 create 会抛错
    return null
  }

  // 逐行合并连续深色格：整行连续的模块写成一条 "M x y h n v1 h-n z"，
  // 比每格一个矩形短得多（典型能省掉一半以上路径长度）。
  // 坐标在这里直接加上静区偏移，后面就不用再做字符串变换了。
  const parts: string[] = []
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * size
    const py = y + QUIET
    let x = 0
    while (x < size) {
      if (!data[rowStart + x]) {
        x += 1
        continue
      }
      let run = 1
      while (x + run < size && data[rowStart + x + run]) run += 1
      const px = x + QUIET
      parts.push(`M${px} ${py}h${run}v1h-${run}z`)
      x += run
    }
  }

  return { viewBox: size + QUIET * 2, path: parts.join('') }
}

/**
 * 兜底判断：页面没经由本地服务打开时，用当前地址拼一个手机端 URL。
 *
 * 注意二维码**不再**由 location.hostname 决定——PC 端要用 localhost 打开才有
 * secure context（否则浏览器直接不给 getDisplayMedia），那样拼出来的二维码
 * 手机根本连不上。正常路径是服务端在 ready 消息里通告局域网地址，
 * 只有连不上信令时才退化到这里。
 */
export function lanAddressable(): { ok: true; host: string } | { ok: false; reason: string } {
  const { hostname, port, protocol } = window.location
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, reason: '当前地址协议无法用于局域网连接' }
  }
  return { ok: true, host: port ? `${hostname}:${port}` : hostname }
}

/** 二维码内容是不是手机真的能访问的地址（localhost / 回环 手机肯定连不上） */
export function qrTargetReachable(url: string): { ok: true } | { ok: false; reason: string } {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return { ok: false, reason: '生成的地址无法解析' }
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return {
      ok: false,
      reason: '二维码指向 localhost，手机访问不到。请确认 npm run lan 在运行，点「重新获取地址」',
    }
  }
  return { ok: true }
}
