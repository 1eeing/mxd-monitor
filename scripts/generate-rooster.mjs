/**
 * 生成内置"公鸡打鸣"报警音 -> public/audio/rooster.wav
 *
 * 纯程序合成（离线、无版权风险）：由短促"咯"声 + 带颤音/谐波的长鸣 构成。
 * 运行：node scripts/generate-rooster.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SR = 44100
const DURATION = 3.6
const out = new Float32Array(Math.floor(SR * DURATION))

/** 依时间顺序（0~DURATION）叠加一段带滑音的谐波音 */
function addTone(start, dur, f0, f1, amp, harm, opts = {}) {
  const { vib = 8, vibDepth = 0.02, noise = 0.05, attack = 0.02, release = 0.1 } = opts
  const n = Math.floor(dur * SR)
  const s0 = Math.floor(start * SR)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const p = n > 1 ? i / (n - 1) : 1
    const f = f0 + (f1 - f0) * p
    const vibA = 1 + vibDepth * Math.sin(2 * Math.PI * vib * t)
    const envIn = attack > 0 ? Math.min(1, t / attack) : 1
    const envOut = release > 0 ? Math.min(1, Math.max(0, (dur - t) / release)) : 1
    const a = amp * Math.min(envIn, envOut)
    let v = 0
    const fv = f * vibA
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * fv * (h + 1) * t)
    v += noise * (Math.random() * 2 - 1)
    const idx = s0 + i
    if (idx >= 0 && idx < out.length) out[idx] += v * a
  }
}

/** 短促"咯"声：噪声脉冲 + 上滑短音 */
function addKro(start, f0, f1, amp) {
  addTone(start, 0.13, f0, f1, amp, [1, 0.55, 0.2], {
    vib: 18,
    vibDepth: 0.03,
    noise: 0.22,
    attack: 0.008,
    release: 0.06,
  })
}

/** 长鸣：基频下滑 + 颤音 + 7Hz 抖动模拟"咯咯咯咯"喉音 */
function addCrow(start, dur, f0, f1, amp, phase = 0) {
  const n = Math.floor(dur * SR)
  const s0 = Math.floor(start * SR)
  const trem = 6.8
  const harm = [1, 0.62, 0.38, 0.14, 0.05]
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const p = n > 1 ? i / (n - 1) : 1
    const glide = f0 + (f1 - f0) * p
    const wob = 1 + 0.055 * Math.sin(2 * Math.PI * 2.1 * t + phase)
    const f = glide * wob
    const tremA = 0.68 + 0.32 * Math.sin(2 * Math.PI * trem * t + phase * 1.7)
    // 前 12% 快速起音，末尾 8% 释放
    const env = Math.min(1, p / 0.12) * Math.min(1, (1 - p) / 0.08)
    const a = amp * tremA * env
    let v = 0
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * f * (h + 1) * t)
    // 气息感噪声，随音量调制
    v += 0.05 * tremA * (Math.random() * 2 - 1)
    const idx = s0 + i
    if (idx >= 0 && idx < out.length) out[idx] += v * a
  }
}

// —— 前奏：两声短促"咯" ——
addKro(0.0, 520, 700, 0.55)
addKro(0.17, 560, 760, 0.6)
// —— 第三声"咯~"上滑 ——
addKro(0.36, 640, 980, 0.5)

// —— 主鸣叫 1（角色音）——
addCrow(0.62, 1.5, 720, 340, 0.85, 0)
// —— 主鸣叫 2（伴音，低一点）——
addCrow(0.78, 1.4, 610, 300, 0.5, 1.3)

// —— 尾音 ——
addTone(2.15, 0.5, 430, 260, 0.35, [1, 0.45, 0.2], {
  vib: 6,
  vibDepth: 0.05,
  noise: 0.04,
  attack: 0.03,
  release: 0.12,
})

// 归一化到 0.85 峰值
let peak = 0
for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
const gain = peak > 0 ? 0.85 / peak : 1
for (let i = 0; i < out.length; i++) out[i] *= gain

// 写 WAV（16-bit PCM 单声道）
const bytesPerSample = 2
const dataSize = out.length * bytesPerSample
const buf = Buffer.alloc(44 + dataSize)
buf.write('RIFF', 0)
buf.writeUInt32LE(36 + dataSize, 4)
buf.write('WAVE', 8)
buf.write('fmt ', 12)
buf.writeUInt32LE(16, 16)
buf.writeUInt16LE(1, 20) // PCM
buf.writeUInt16LE(1, 22) // mono
buf.writeUInt32LE(SR, 24)
buf.writeUInt32LE(SR * bytesPerSample, 28)
buf.writeUInt16LE(bytesPerSample, 32)
buf.writeUInt16LE(16, 34)
buf.write('data', 36)
buf.writeUInt32LE(dataSize, 40)
for (let i = 0; i < out.length; i++) {
  const s = Math.max(-1, Math.min(1, out[i]))
  buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
}

const here = dirname(fileURLToPath(import.meta.url))
const dest = join(here, '..', 'public', 'audio', 'rooster.wav')
mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, buf)
console.log(`已生成 ${dest}（${(buf.length / 1024).toFixed(0)} KB，${DURATION}s）`)