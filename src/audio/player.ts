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
   * 当前报警音源地址（blob: 或默认音频路径）。
   * 局域网镜像要把同一份音频送到手机出响，读这里可避免在别处重复实现
   * 「自定义音频走 IndexedDB、否则用默认音频」这套选择逻辑。
   */
  get source(): string {
    return this.currentSrc
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