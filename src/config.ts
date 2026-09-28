/** OCR 模型文件路径（见 public/models） */
export const OCR_MODELS = {
  detectionPath: '/models/ch_PP-OCRv4_det_infer.onnx',
  recognitionPath: '/models/ch_PP-OCRv4_rec_infer.onnx',
  dictionaryPath: '/models/ppocr_keys_v1.txt',
} as const

/** 默认报警音频（用户放入的 sound.mp3，见 public/audio/） */
export const DEFAULT_ALARM_AUDIO = '/audio/sound.mp3'

/** 自定义报警音频存入 IndexedDB 的 key */
export const CUSTOM_ALARM_AUDIO_KEY = 'custom-alarm-audio'

/** 默认识别间隔（毫秒） */
export const DEFAULT_OCR_INTERVAL_MS = 1500

/** 停止报警的容错帧数：连续 N 次未识别到关键字才停止报警，防止 OCR 偶发误识别导致报警抖动 */
export const ALARM_GRACE_FRAMES = 2

/**
 * 单帧识别超时（毫秒）。超过则判定 OCR 引擎卡死：
 * 引擎的 promise 既不 resolve 也不 reject 时，若不设上限，识别循环会永久停摆且不产生任何日志。
 */
export const OCR_TIMEOUT_MS = 15_000

/**
 * 存活判定：超过这个时长没有成功识别过一帧，就认为监控已失活（定时器被浏览器冻结、
 * 画面取不到、引擎卡死等），需要在界面上明确提示，而不是让界面一直显示「运行中」。
 */
export const MONITOR_STALL_MS = 90_000

/** 日志最大条数 */
export const MAX_LOG_ENTRIES = 200
