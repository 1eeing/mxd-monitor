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

export async function initOcr(backend: OcrBackend): Promise<InitResult> {
  if (ocr && currentBackend === backend) {
    return { backend, provider: currentBackend, elapsedMs: 0 }
  }

  ort.env.wasm.wasmPaths = WASM_PATHS[backend]
  const onnxOptions: ort.InferenceSession.SessionOptions = {
    executionProviders: backend === 'webgpu' ? ['webgpu'] : ['wasm'],
  }

  const started = performance.now()
  ocr = await Ocr.create({ models: OCR_MODELS, onnxOptions })
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