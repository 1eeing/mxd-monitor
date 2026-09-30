/**
 * 报警音播放器。
 * 命中关键字 -> start() 循环播放；未命中/手动停止 -> stop()。
 * 同一时刻只维护一个 audio 元素。
 */
export class AlarmPlayer {
  private audio: HTMLAudioElement | null = null
  private enabled = false
  private currentSrc: string = ''

  /** 设置报警音源（会停掉当前播放），并回收旧 blob URL 防止泄漏 */
  setSource(src: string): void {
    if (this.enabled) this.stop()
    if (this.currentSrc.startsWith('blob:')) {
      URL.revokeObjectURL(this.currentSrc)
    }
    this.currentSrc = src
    const audio = new Audio(src)
    audio.loop = true
    audio.preload = 'auto'
    this.audio = audio
  }

  get alarmOn(): boolean {
    return this.enabled
  }

  /**
   * 开始循环播放。返回的 Promise 在播放失败时 reject（如浏览器自动播放策略拦截、
   * 音频设备被占用），调用方应据此记录日志——静默失败会让「命中了却没声音」无从排查。
   */
  start(): Promise<void> {
    if (!this.audio || this.enabled) return Promise.resolve()
    this.enabled = true
    return this.audio.play().then(
      () => undefined,
      (err: unknown) => {
        this.enabled = false
        throw err
      },
    )
  }

  stop(): void {
    if (this.audio && this.enabled) {
      this.audio.pause()
      this.audio.currentTime = 0
    }
    this.enabled = false
  }
}

export const alarmPlayer = new AlarmPlayer()

/**
 * 试解码一个音频 Blob，判断当前浏览器到底能不能播它。
 *
 * 必须在**存库之前**问一遍，原因是 Chrome 对无法解码的文件既不抛异常也不 reject
 * promise，只是触发 audio.onerror（实测 code=4 SRC_NOT_SUPPORTED）。放任不管的话，
 * 用户挑了个坏文件或浏览器不支持的编码，界面照样显示「已上传 xxx.ogg」并选中它，
 * 直到某次真报警时才哑掉——那时已经没有任何线索指回当初选错了文件。
 */
export function probePlayable(blob: Blob, timeoutMs = 5000): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio()
    let settled = false
    const finish = (ok: boolean, reason: string): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      audio.oncanplay = null
      audio.onerror = null
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
      resolve({ ok, reason })
    }
    const timer = window.setTimeout(
      () => finish(false, '解码超时，文件可能已损坏或体积过大'),
      timeoutMs,
    )
    audio.preload = 'metadata'
    audio.oncanplay = () => finish(true, '')
    audio.onerror = () => {
      const code = audio.error?.code
      // MediaError：1 ABORTED / 2 NETWORK / 3 DECODE / 4 SRC_NOT_SUPPORTED
      const meaning =
        code === 4 ? '浏览器不支持该音频的编码格式' : code === 3 ? '音频文件已损坏' : '音频无法解码'
      finish(false, `${meaning}（MediaError ${code ?? '未知'}）`)
    }
    audio.src = url
  })
}