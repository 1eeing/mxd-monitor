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
 * 初始化 OCR 引擎。
 * - webgpu：使用 GPU（Chrome 113+，WebGPU），速度快
 * - wasm：CPU 回退
 * WASM 文件由本地 /onnx/ 目录托管。
 */
export async function initOcr(backend: OcrBackend): Promise<InitResult> {
  if (ocr && currentBackend === backend) {
    return { backend, provider: currentBackend, elapsedMs: 0 }
  }

  ort.env.wasm.wasmPaths = '/onnx/'
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