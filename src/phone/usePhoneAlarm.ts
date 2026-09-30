/**
 * 手机端报警音频。
 *
 * 以下是 iOS 18.7 / Safari 26.6 真机实测的结论（局域网 HTTP，非 secure context），
 * 它们直接决定了这里的结构，改动前先读懂：
 *
 * 1) 无用户手势时 `new Audio().play()` 一律 NotAllowedError；
 * 2) 在用户手势里 play() 一次即完成解锁，但**解锁只对该元素实例有效**，
 *    换一个新元素仍然被拒 —— 所以整个生命周期只能复用同一个 audio；
 * 3) 页面载入后等 10s 自动播放（此时没有任何手势）同样被拒；
 * 4) MediaSession 可用：注册后锁屏/控制中心会出现媒体条目。
 *
 * 据此用两条路：
 * 1) 前台：手势解锁一个常驻元素反复用，报警最可靠；
 * 2) 锁屏/后台：常驻元素会被系统暂停，play() 不可靠，
 *    用 MediaSession 登记条目，并在回到前台时自动续播。
 *
 * ⚠ 尚未验证：锁屏后能否在无手势下真的启动报警音。实测过的只是
 * 「注册 MediaSession 后锁屏出现条目并有声音」，而那次声音来自一个
 * 提前就在播放的低音量循环音频，不足以证明无手势播放可行。
 * 若真机验收发现锁屏无声，优先加「锁屏点一下恢复」按钮（已具备），
 * 不要指望绕过 iOS 的自动播放策略。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface PhoneAlarm {
  /** 报警是否正在响 */
  ringing: boolean
  /** 音频系统是否已就绪（前景路径解锁成功） */
  unlocked: boolean
  /** 最近一次播放失败原因，中文，可直接展示 */
  blockedReason: string | null
  /** 在用户手势里解锁音频 */
  unlock: () => Promise<void>
  /** 开始/停止报警 */
  setRinging: (on: boolean) => void
  /** 重新拉取报警音频（PC 换了自定义音频后） */
  reload: () => Promise<void>
}

function describe(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') {
      return '浏览器拦截了自动播放（iOS 要求先有一次用户操作）'
    }
    if (err.name === 'AbortError') return '播放被中断'
    if (err.name === 'NotSupportedError') return '音频格式不支持'
  }
  return err instanceof Error ? err.message : String(err)
}

export function usePhoneAlarm(): PhoneAlarm {
  /**
   * 手势解锁出来的常驻元素。整个生命周期只用这一个：
   * 换元素就会丢失解锁状态（iOS 的解锁是元素级的）。
   */
  const elRef = useRef<HTMLAudioElement | null>(null)
  const srcRef = useRef<string>('/audio/sound.mp3')
  const ringingRef = useRef(false)
  const [ringing, setRingingState] = useState(false)
  const [unlocked, setUnlocked] = useState(false)
  const [blockedReason, setBlockedReason] = useState<string | null>(null)

  /**
   * 取常驻音频元素，没有就建一个。
   *
   * loop / preload 只在创建时设置一次：iOS 的解锁状态绑定在元素实例上，
   * 换元素就回到「需要用户手势」的状态，所以整个生命周期只能复用这一个。
   * 必须定义在 setRinging 之前——后者的依赖数组要读它。
   */
  const ensureEl = useCallback((): HTMLAudioElement => {
    const existing = elRef.current
    if (existing) return existing
    const el = new Audio(srcRef.current)
    el.loop = true
    el.preload = 'auto'
    elRef.current = el
    return el
  }, [])

  const setRinging = useCallback(
    (on: boolean) => {
      if (ringingRef.current === on) return
      ringingRef.current = on
      setRingingState(on)

      if (on) {
        if (!elRef.current) {
          setBlockedReason('音频还没解锁，请先点一下下面的按钮')
          return
        }
        // 回到前台时 iOS 可能把元素暂停过，从头播
        const el = ensureEl()
        el.currentTime = 0
        void el.play().then(
          () => setBlockedReason(null),
          (err: unknown) => {
            setBlockedReason(`${describe(err)}。请点下面的按钮恢复声音。`)
          },
        )
      } else {
        elRef.current?.pause()
      }
    },
    [ensureEl],
  )

  const unlock = useCallback(async (): Promise<void> => {
    // 在手势里同步创建并播放：iOS 要求 play() 由用户手势直接触发，
    // 包进 setTimeout / Promise.resolve 之后就失效了。
    const el = ensureEl()
    try {
      // 播一下立刻停：走通解锁链路就行，不必让用户第一次点就被鸡叫吓到
      await el.play()
      el.pause()
      setUnlocked(true)
      setBlockedReason(null)
      // 解锁时若报警本来就在响，立刻补上声音
      if (ringingRef.current) void el.play().catch(() => undefined)
    } catch (err) {
      setUnlocked(false)
      setBlockedReason(describe(err))
    }
  }, [ensureEl])

  /**
   * 拉取 PC 同步过来的报警音频。
   *
   * 走服务端 /alarm-audio 而不是各自读 /audio/sound.mp3：PC 用的是自定义音频
   * （存在它的 IndexedDB 里），只有 PC 读得到，路径也是它自己的。
   */
  const reload = useCallback(async (): Promise<void> => {
    try {
      const resp = await fetch('/alarm-audio', { cache: 'no-store' })
      if (!resp.ok) return
      const blob = await resp.blob()
      if (blob.size === 0) return
      const url = URL.createObjectURL(blob)
      const prev = srcRef.current
      srcRef.current = url
      if (elRef.current) {
        elRef.current.src = url
        elRef.current.load()
      }
      // 只回收自己刚生成的 blob URL，默认路径不能 revoke
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev)
    } catch {
      // 拉取失败保持原音源，不影响已有功能
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * MediaSession：让锁屏/控制中心出现本应用的条目。
   *
   * 关键点：iOS 锁屏时页面的 JS 大概率还在跑（Safari 的媒体例外），
   * 但普通 audio 的 play() 会被系统静音/拒绝。注册成媒体会话后，
   * 配合下面的 handlers，用户在锁屏上就能用系统媒体控件恢复声音。
   */
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    ms.metadata = new MediaMetadata({
      title: '冒险岛监控',
      artist: '等待中',
      album: '报警',
    })
    ms.setActionHandler('play', () => {
      void elRef.current?.play().catch(() => undefined)
    })
    ms.setActionHandler('pause', () => elRef.current?.pause())
    ms.setActionHandler('stop', () => elRef.current?.pause())
    return () => {
      ms.setActionHandler('play', null)
      ms.setActionHandler('pause', null)
      ms.setActionHandler('stop', null)
    }
  }, [])

  // 报警状态同步到锁屏条目上，让用户一眼看出当前是不是在报警
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ringing ? '⚠ 报警中' : '冒险岛监控',
      artist: ringing ? '检测到关键字' : '等待中',
      album: '报警',
    })
    navigator.mediaSession.playbackState = ringing ? 'playing' : 'paused'
  }, [ringing])

  /**
   * 回到前台时补播。iOS 切走再回来会暂停/静音音频，
   * 报警状态还是 true 的话必须重新驱动一次，否则会「有报警状态但没声音」。
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (!ringingRef.current) return
      const el = elRef.current
      if (!el) return
      void el.play().then(
        () => setBlockedReason(null),
        (err: unknown) => setBlockedReason(describe(err)),
      )
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // 卸载时把 MediaSession 让出去，否则别的页面/上一张音乐卡会显示异常状态
  useEffect(
    () => () => {
      elRef.current?.pause()
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'
    },
    [],
  )

  return { ringing, unlocked, blockedReason, unlock, setRinging, reload }
}
