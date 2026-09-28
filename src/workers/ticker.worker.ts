/**
 * 识别循环的心跳定时器，故意放在 Worker 里跑。
 *
 * 为什么不用主线程的 setInterval：
 * Chrome 会对「隐藏页面的主线程」启用 intensive throttling —— 页面切到后台约 5 分钟后，
 * setTimeout/setInterval 被压到约每分钟一次。测谎这类只出现几秒的弹窗，在这种采样率下
 * 会被整段错过，而且不会有任何报错，界面照样显示「运行中」。
 * Worker 里的定时器不受这条限制；Worker 发来的 postMessage 属于普通任务事件，
 * 仍会被主线程及时派发。
 *
 * 注意边界：Worker 只能绕开「定时器降频」，绕不开页面冻结（Page Freeze）与标签页被回收。
 * 那属于浏览器/系统的资源回收行为，任何纯网页方案都无解，只能靠 useMonitor 的存活看门狗暴露出来。
 *
 * 这里不用 `/// <reference lib="webworker" />`：项目 tsconfig 只开了 DOM lib，
 * 引入 webworker lib 会和 DOM 的 `self` 声明冲突。用结构化类型局部声明即可。
 */
interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage: (message: unknown) => void
  setInterval: (handler: () => void, timeout: number) => number
  clearInterval: (handle: number) => void
}

const ctx = self as unknown as WorkerScope

let timer: number | null = null

ctx.onmessage = (e: MessageEvent) => {
  const data = e.data as { type?: string; intervalMs?: number } | null
  if (!data) return
  if (data.type === 'start') {
    if (timer !== null) ctx.clearInterval(timer)
    const intervalMs = Math.max(300, Number(data.intervalMs) || 1500)
    timer = ctx.setInterval(() => ctx.postMessage({ type: 'tick' }), intervalMs)
  } else if (data.type === 'stop') {
    if (timer !== null) {
      ctx.clearInterval(timer)
      timer = null
    }
  }
}
