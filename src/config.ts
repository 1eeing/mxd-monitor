/** OCR 模型文件路径（见 public/models） */
export const OCR_MODELS = {
  detectionPath: '/models/ch_PP-OCRv4_det_infer.onnx',
  recognitionPath: '/models/ch_PP-OCRv4_rec_infer.onnx',
  dictionaryPath: '/models/ppocr_keys_v1.txt',
} as const

/** 默认报警音频（用户放入的 sound.mp3，见 public/audio/） */
export const DEFAULT_ALARM_AUDIO = '/audio/sound.mp3'

/** 默认识别间隔（毫秒） */
export const DEFAULT_OCR_INTERVAL_MS = 1500

/** 停止报警的容错帧数：连续 N 次未识别到关键字才停止报警，防止 OCR 偶发误识别导致报警抖动 */
export const ALARM_GRACE_FRAMES = 2

/** 日志最大条数 */
export const MAX_LOG_ENTRIES = 200
