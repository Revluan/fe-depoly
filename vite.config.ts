/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { visualizer } from 'rollup-plugin-visualizer'
import path from 'node:path'
import fs from 'node:fs'

// 读取 package.json 中 react 的版本号,用于拼接 esm.sh CDN URL
// 这样升级 react 版本时不用同步改 importmap 里的 URL
function getReactVersion(): string {
  const pkgPath = path.resolve(__dirname, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  const ver = pkg.dependencies?.react
  if (!ver) throw new Error('package.json dependencies.react not found')
  // ^18.3.1 / ~18.3.1 / 18.3.1 都去掉前缀,取纯版本号
  return ver.replace(/^[^0-9]+/, '')
}

// 当 EXTERNALS_CDN=true 时,向 index.html 注入 importmap
// 让浏览器通过 esm.sh 加载 react/react-dom,不打包进 bundle
function externalsImportMap(): import('vite').Plugin {
  const reactVersion = getReactVersion()
  const importMap = {
    imports: {
      react: `https://esm.sh/react@${reactVersion}`,
      'react-dom': `https://esm.sh/react-dom@${reactVersion}`,
      'react-dom/client': `https://esm.sh/react-dom@${reactVersion}/client`,
    },
  }
  const importMapTag = `<script type="importmap">${JSON.stringify(importMap)}</script>`
  return {
    name: 'externals-import-map',
    transformIndexHtml(html) {
      // 在 <head> 后注入 importmap,确保在 module script 之前解析
      return html.replace('<head>', `<head>${importMapTag}`)
    },
  }
}

export default defineConfig(({ mode }) => {
  // 加载所有 env(含非 VITE_ 前缀的,如 SENTRY_AUTH_TOKEN)
  const env = loadEnv(mode, process.cwd(), '')
  const isProduction = mode === 'production'
  // 只有 CI 注入了 Auth Token 才启用 Sentry 插件,避免本地构建乱上传
  const hasSentryToken = !!process.env.SENTRY_AUTH_TOKEN
  const enableSentryPlugin = isProduction && hasSentryToken
  // 产物体积分析:仅 ANALYZE=true 时启用,避免每次 build 都生成 stats.html
  const enableAnalyze = process.env.ANALYZE === 'true'
  // 依赖外置:把 react/react-dom 通过 CDN importmap 加载,不打包进 bundle
  // 默认关闭,生产环境通过 .env.production 或 CI 环境变量开启
  const enableExternals = process.env.EXTERNALS_CDN === 'true'

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
      // 依赖外置:向 index.html 注入 importmap,把 react/react-dom 指向 esm.sh CDN
      ...(enableExternals ? [externalsImportMap()] : []),
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
      rollupOptions: {
        // 显式开启 Tree Shaking(Rollup 默认开启,显式声明 + package.json sideEffects 字段配合
        // 让构建工具能更激进地 shake 掉未使用的纯 JS 模块)
        treeshake: true,
        // 依赖外置:把 react/react-dom 通过 CDN importmap 加载,不打包进 bundle
        ...(enableExternals ? { external: ['react', 'react-dom', 'react-dom/client'] } : {}),
        output: {
          // 手动分包:把第三方依赖拆到独立 chunk,业务代码变动不影响 vendor chunk 的长缓存
          // 当 enableExternals=true 时,react/react-dom 被外置,不能出现在 manualChunks 里
          // 否则 Rollup 报错:"react" cannot be included in manualChunks because it is resolved as an external module
          // 所以这里用函数式 manualChunks,跳过被 external 的依赖
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (
                !enableExternals &&
                (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/'))
              ) {
                return 'vendor-react'
              }
              if (id.includes('node_modules/@sentry/react')) {
                return 'vendor-sentry'
              }
            }
            return undefined
          },
        },
      },
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
