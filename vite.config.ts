import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import type { Connect, Plugin } from 'vite'
import { defineConfig } from 'vite'

/** 跨源隔离头：让 onnxruntime-web 的 WASM 多线程（SharedArrayBuffer）可用，WebGPU 路径不受影响 */
function crossOriginIsolation(): Plugin {
  const setHeaders: Connect.NextHandleFunction = (_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    next()
  }
  return {
    name: 'cross-origin-isolation-headers',
    configureServer(server) {
      server.middlewares.use(setHeaders)
    },
    configurePreviewServer(server) {
      server.middlewares.use(setHeaders)
    },
  }
}

/**
 * dev 修复：onnxruntime-web 运行时动态 import 会被 Vite 8 的 import-analysis 注入 `?import`，
 * 而这会命中「public 目录文件不可作为模块导入」的拦截分支。这里在 transform 中间件之前
 * 把 /onnx/* 请求的查询串剥掉，让静态中间件直接返回 public 文件。（生产无此注入，不受影响）
 */
function servePublicOnnxInDev(): Plugin {
  return {
    name: 'serve-public-onnx-in-dev',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const rawUrl = req.url ?? ''
        const clean = rawUrl.split('?')[0]
        if (clean.startsWith('/onnx/')) req.url = clean
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // 两个入口：PC 端 index.html 与手机端 phone.html。
  // input 的 key 用文件名本身，产物就是 dist/index.html 和 dist/phone.html。
  // 手机端不碰 OCR/onnxruntime，产物很小，天然和主包分开。
  plugins: [react(), crossOriginIsolation(), servePublicOnnxInDev()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        phone: resolve(import.meta.dirname, 'phone.html'),
      },
    },
  },
  server: {
    // dev 时手机要用局域网 IP 访问，默认只监听 localhost 会连不上
    host: true,
    watch: {
      // 静态资源（音频/模型/onnx）不需要 HMR 监听：
      // 1) 文件大且固定，没有改它的场景；
      // 2) Windows 上被其他进程（残留 dev server / 浏览器 audio 元素）锁定的
      //    文件（如 public/audio/*.mp3）会让 Vite 的 watcher 抛 EBUSY 而整个崩溃。
      ignored: [
        '**/public/audio/**',
        '**/public/models/**',
        '**/public/onnx/**',
        '**/public/audio-vendor/**',
      ],
    },
  },
  resolve: {
    alias: {
      // js-clipper 原包含非 UTF-8 字节导致生产构建失败，改用已转码的本地副本
      'js-clipper': fileURLToPath(new URL('./src/vendor/js-clipper/clipper.js', import.meta.url)),
    },
  },
})