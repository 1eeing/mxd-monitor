import Ocr from '@gutenye/ocr-browser'
import * as ort from 'onnxruntime-web'
import { OCR_MODELS } from '../config'
import type { OcrBackend } from '../types'

let ocr: Ocr | null = null
let currentBackend: OcrBackend | null = null

export interface OcrLine {
  text: string
  score: number
  box?: number[][]
}

export interface DetectResult {
  lines: OcrLine[]
  width: number
  height: number
}

export interface InitResult {
  backend: OcrBackend
  /** ONNX Runtime 报告的实际执行提供者（webgpu / wasm） */
  provider: string
  /** 初始化耗时 ms */
  elapsedMs: number
}

/**
 * WASM 运行时来源：
 * - WebGPU(jsep)：onnxruntime-web 的 jsep.wasm 有 28MB，超过 EdgeOne Makers 免费版单文件
 *   25MB 上限，改用 npmmirror（国内可达的 npm 镜像 CDN）按固定版本加载；
 * - CPU(wasm)：ort-wasm-simd-threaded.wasm 只有 14MB，由 /onnx/ 本地托管，离线可用。
 * wasmPaths 为目录前缀，ort 会按需拉取对应的 .mjs 加载器与 .wasm 二进制。
 */
const WASM_PATHS: Record<OcrBackend, string> = {
  webgpu: 'https://registry.npmmirror.com/onnxruntime-web/1.30.0/files/dist/',
  wasm: '/onnx/',
}

/** 各资源的大致字节数，用于计算加载进度（约数即可，进度条不需要精确） */
const RESOURCE_BYTES: Record<string, number> = {
  'ort-wasm-simd-threaded.jsep.wasm': 28_312_028,
  'ort-wasm-simd-threaded.wasm': 14_239_897,
  'ch_PP-OCRv4_det_infer.onnx': 4_745_517,
  'ch_PP-OCRv4_rec_infer.onnx': 10_822_323,
  'ppocr_keys_v1.txt': 32_871,
}

/**
 * 临时拦截 window.fetch，统计关键资源（wasm + OCR 模型 + 字典）的实际下载字节，
 * 折算成 0~100 的进度回调。onnxruntime 与 OCR 库内部都走全局 fetch，拦得住。
 * 初始化完成后必须调用返回的还原函数。
 */
function trackDownloadProgress(backend: OcrBackend, onProgress: (pct: number) => void): () => void {
  const bigFiles =
    backend === 'webgpu'
      ? ['ort-wasm-simd-threaded.jsep.wasm', 'ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv4_rec_infer.onnx', 'ppocr_keys_v1.txt']
      : ['ort-wasm-simd-threaded.wasm', 'ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv4_rec_infer.onnx', 'ppocr_keys_v1.txt']
  const total = bigFiles.reduce((sum, name) => sum + (RESOURCE_BYTES[name] ?? 0), 0)
  const loaded = new Map<string, number>()

  const originalFetch = window.fetch.bind(window)
  const patchedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const target = bigFiles.find((name) => url.includes(name))
    if (!target) return originalFetch(input, init)
    const res = await originalFetch(input, init)
    if (!res.body || !res.ok) return res

    const reader = res.body.getReader()
    let count = loaded.get(target) ?? 0
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
              count += value.byteLength
              loaded.set(target, count)
              const sum = [...loaded.values()].reduce((a, b) => a + b, 0)
              onProgress(Math.min(99, (sum / total) * 100))
            }
            controller.enqueue(value)
          }
          controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
      cancel() {
        void reader.cancel()
      },
    })
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  window.fetch = patchedFetch as typeof fetch
  return () => {
    window.fetch = originalFetch
  }
}

/**
 * 初始化 OCR 引擎。
 * onProgress：资源下载进度 0~99（完成由调用方置 100 收尾）
 */
export async function initOcr(
  backend: OcrBackend,
  onProgress?: (pct: number) => void,
): Promise<InitResult> {
  if (ocr && currentBackend === backend) {
    onProgress?.(100)
    return { backend, provider: currentBackend, elapsedMs: 0 }
  }

  ort.env.wasm.wasmPaths = WASM_PATHS[backend]
  const onnxOptions: ort.InferenceSession.SessionOptions = {
    executionProviders: backend === 'webgpu' ? ['webgpu'] : ['wasm'],
  }

  const started = performance.now()
  const restoreFetch = onProgress ? trackDownloadProgress(backend, onProgress) : null
  try {
    ocr = await Ocr.create({ models: OCR_MODELS, onnxOptions })
  } finally {
    restoreFetch?.()
  }
  currentBackend = backend
  return { backend, provider: backend, elapsedMs: performance.now() - started }
}

export function isOcrReady(): boolean {
  return ocr !== null
}

/** 对一帧数据进行识别，返回文字行 */
export async function detectImageData(imageData: ImageData): Promise<DetectResult> {
  if (!ocr) throw new Error('OCR 引擎未初始化')
  const result = await ocr.detect({
    data: imageData.data,
    width: imageData.width,
    height: imageData.height,
  })
  return {
    lines: result.texts.map((line) => ({
      text: line.text,
      score: typeof line.mean === 'number' ? line.mean : 0,
      box: line.box,
    })),
    width: result.resizedImageWidth,
    height: result.resizedImageHeight,
  }
}