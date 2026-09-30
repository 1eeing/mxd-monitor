/**
 * qrcode 的 core 入口（只出模块矩阵，不做 PNG 编码）没有官方类型声明。
 * 只需要 create()，所以在这里补一个最小声明，够用即可。
 */
declare module 'qrcode/lib/core/qrcode.js' {
  export interface QrBitMatrix {
    /** 边长（模块数），如 21 / 25 / 29 */
    size: number
    /** 长度 size*size，每格 1 = 深色，0 = 浅色；下标 y * size + x */
    data: Uint8Array
  }

  export interface QrCode {
    modules: QrBitMatrix
    version: number
    errorCorrectionLevel: unknown
  }

  export function create(
    data: string,
    options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' },
  ): QrCode
}
