/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { visualizer } from 'rollup-plugin-visualizer'
import path from 'node:path'

export default defineConfig(({ mode }) => {
  // 加载所有 env(含非 VITE_ 前缀的,如 SENTRY_AUTH_TOKEN)
  const env = loadEnv(mode, process.cwd(), '')
  const isProduction = mode === 'production'
  // 只有 CI 注入了 Auth Token 才启用 Sentry 插件,避免本地构建乱上传
  const hasSentryToken = !!process.env.SENTRY_AUTH_TOKEN
  const enableSentryPlugin = isProduction && hasSentryToken
  // 产物体积分析:仅 ANALYZE=true 时启用,避免每次 build 都生成 stats.html
  const enableAnalyze = process.env.ANALYZE === 'true'

  return {
    base: '/',
    plugins: [
      react(),
      // Sentry 插件:构建时上传 source map 到 Sentry,关联到 Release
      // 仅在生产构建 + 有 Auth Token 时启用
      ...(enableSentryPlugin
        ? [
            sentryVitePlugin({
              org: env.SENTRY_ORG,
              project: env.SENTRY_PROJECT,
              authToken: process.env.SENTRY_AUTH_TOKEN!,
              release: {
                // Release 名必须和 SDK 里 Sentry.init 的 release 一致
                // 用 VITE_APP_VERSION(本项目 CI 注入为 git commit SHA)
                name: env.VITE_APP_VERSION,
              },
              sourcemaps: {
                // 上传后删除本地 .map 文件,避免泄露源码到 R2
                filesToDeleteAfterUpload: ['dist/**/*.map'],
              },
              telemetry: false,
            }),
          ]
        : []),
      // 产物体积可视化:生成 stats.html,用浏览器打开看每个模块占比
      ...(enableAnalyze
        ? [
            visualizer({
              filename: 'stats.html',
              template: 'treemap',
              gzipSize: true,
              brotliSize: true,
              // 不自动打开浏览器,CI 里也能用
              open: false,
            }),
          ]
        : []),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      open: true,
    },
    build: {
      outDir: 'dist',
      // 必须开 source map,Sentry 才能根据 source map 还原压缩后的错误堆栈到源码位置
      sourcemap: true,
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        exclude: ['node_modules/', 'dist/', 'src/test/'],
      },
    },
  }
})
