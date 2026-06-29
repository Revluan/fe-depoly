## Context

阶段五·性能优化清单中，"产物体积分析"已完成（`doc/bundle-analysis.md`），现状是单一 `index-[hash].js` 159.87 kB / gzip 52 kB，Sentry 与 React 共占 ~90%。每次业务代码变动，整个 bundle hash 漂移，导致即使用户本地已缓存过相同版本的第三方代码，浏览器仍需重新下载全部 52 kB。

当前部署架构（来自近期 commits 与 `doc/multi-env-isolation.md`）：Cloudflare R2 托管静态产物 + Cloudflare Worker 做灰度路由，HTML 不缓存、JS/CSS 长缓存（content hash）。这意味着 vendor 代码独立成 chunk 后，长缓存收益能直接兑现。

约束：
- 构建工具：Vite 7 + Rollup 4
- 部署：Cloudflare R2 + Worker，不支持 Service Worker 推送
- 浏览器目标：现代浏览器（ESM、原生 ESM CDN 可用）
- 不能因为优化破坏 Sentry source map 上传流程（`vite.config.ts:24-42`）

## Goals / Non-Goals

**Goals:**
- 把 `react`、`react-dom`、`@sentry/react` 从业务 chunk 中拆分出来，业务代码变动不再让 vendor chunk 的 hash 漂移
- 提供通过 CDN 外置 React 的能力，进一步降低自托管 bundle 体积
- 校验 Tree Shaking 已生效（避免 `import *` 误用导致整包打入）
- 所有优化可通过环境变量开关，本地开发不受影响
- 优化结果可量化（对比 stats.html 前后体积）

**Non-Goals:**
- 不做路由级 `React.lazy` 代码分割（业务代码占比 <10%，ROI 不足，等业务代码上来后单独立 change）
- 不替换 Sentry 为其他方案
- 不引入 Service Worker / HTTP 推送
- 不做图片优化（WebP/AVIF，单独立 change）

## Decisions

### 决策 1：用 `output.manualChunks` 而非 `splitVendorChunkPlugin`

**选择**：在 `build.rollupOptions.output.manualChunks` 中手动定义 `vendor-react`、`vendor-sentry` 两个 chunk。

**理由**：
- `splitVendorChunkPlugin` 是 Vite 提供的自动拆分插件，按 `node_modules` 路径自动分组，但分组粒度不可控——会把所有 `node_modules` 拆成一个大 vendor chunk，无法把 React 和 Sentry 拆开。
- 手动 `manualChunks` 可以精确控制"哪些依赖进哪个 chunk"，让 React 单独成 chunk 后，未来做 externals 时只需删掉 `vendor-react` 这一段配置，迁移路径清晰。

**Alternatives considered**：
- `splitVendorChunkPlugin`：简单但不可控，否决。
- 不分包：当前现状，长缓存命中率为 0，否决。

**配置形态**：

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'vendor-react': ['react', 'react-dom'],
        'vendor-sentry': ['@sentry/react'],
      },
    },
  },
},
```

### 决策 2：依赖外置通过 `build.rollupOptions.external` + CDN `<script>` 注入

**选择**：当 `EXTERNALS_CDN=true` 时，把 `react`、`react-dom` 加入 `external`，并在 `index.html` 注入 esm.sh 的 CDN script。

**理由**：
- Vite/Rollup 的 `external` 配置会让构建产物中保留 `import` 语句（或转为全局变量引用），不把依赖打包进 bundle。
- 通过 `transformIndexHtml` 钩子动态注入 CDN script，可以根据环境变量决定是否注入，无需引入 `vite-plugin-html` 等额外依赖。
- 选 esm.sh 而非 unpkg：esm.sh 自动提供 ESM 格式 + 正确的 dependency resolution，unpkg 需要 `?module` 后缀且对 React 18 的 `react-dom/client` 子路径支持不稳定。

**CDN URL 选择**：

```html
<!-- 生产：esm.sh，固定版本 -->
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18.3.1",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client"
  }
}
</script>
```

使用 importmap 而非 `<script src>` 全局变量方式，因为：
- 业务代码 `import { createRoot } from 'react-dom/client'` 不需要改写
- Rollup `external` 保留 import 语句，浏览器通过 importmap 解析
- 比 `window.React` 全局变量方式更接近原生 ESM，未来迁移友好

**Alternatives considered**：
- `<script src="https://unpkg.com/react@18/umd/react.production.min.js">` + 全局变量：需要把所有 `import React from 'react'` 改为 `window.React`，对源码侵入大。
- 自托管 React 在 R2：可行但失去 CDN 多域名并行下载优势；本项目已是自托管 bundle，外置的核心价值就是利用 CDN 边缘节点。
- 不外置 React，只外置 Sentry：Sentry 占 50% 但体积仅 ~25 kB gzip，外置收益不如 React 明显，且 Sentry 版本变更频繁，CDN 缓存命中率低。

### 决策 3：Tree Shaking 显式声明 + `moduleSideEffects` 校验

**选择**：在 vite.config.ts 显式设置 `build.rollupOptions.treeshake: true`（虽然 Rollup 默认开启），并通过 `package.json` 的 `sideEffects` 字段告知构建工具哪些文件有副作用。

**理由**：
- Rollup 默认 `treeshake: true`，但项目当前 `package.json` 未声明 `sideEffects`，构建工具会保守地保留所有 `import './index.css'` 等语句的副作用。
- 显式声明 `"sideEffects": ["*.css", "*.svg"]` 后，构建工具能更激进地 Tree Shake 未使用的纯 JS 模块。
- Sentry 的 `import * as Sentry from '@sentry/react'` 是 Tree Shaking 不友好的写法，但因为 Sentry SDK 本身是按需导出且 `@sentry/react` 的 package.json 声明了 `sideEffects: false`，实际打包时未使用部分会被 tree shake。本次不重构 Sentry 引入方式，避免影响 source map 上传。

**Alternatives considered**：
- 把 `import * as Sentry` 改为命名导入：收益小（Sentry 已声明 sideEffects: false），改动面大，否决。
- 关闭 Tree Shaking：负优化，否决。

### 决策 4：用环境变量 `EXTERNALS_CDN` 控制 CDN 外置开关

**选择**：默认关闭（`EXTERNALS_CDN=false`），生产环境通过 CI 环境变量开启。

**理由**：
- 本地开发（`npm run dev`）不应依赖 CDN，避免网络抖动影响开发体验。
- 生产开启后，如果 CDN 出问题，可以快速通过环境变量回滚，无需 redeploy 代码。
- 与现有 `SENTRY_AUTH_TOKEN`、`ANALYZE` 等环境变量开关的实践一致。

**Alternatives considered**：
- 用 `mode === 'production'` 自动开启：不灵活，预发环境（staging）可能想关闭 CDN 测试纯自托管性能。
- 配置文件单独管理：增加配置面，环境变量更轻量。

### 决策 5：不引入新依赖实现 HTML 注入

**选择**：用 Vite 内置的 `transformIndexHtml` 钩子（在 `plugins` 数组中返回一个 inline 插件）注入 importmap。

**理由**：
- `vite-plugin-html` 等插件功能强大但本项目只需注入一段 importmap，引入依赖 ROI 不足。
- 内置 `transformIndexHtml` 钩子 8 行代码搞定，且行为可控。

```ts
function externalsImportMap() {
  return {
    name: 'externals-import-map',
    transformIndexHtml(html) {
      const importMap = `<script type="importmap">{...}</script>`
      return html.replace('<head>', `<head>${importMap}`)
    },
  }
}
```

## Risks / Trade-offs

- **[风险] esm.sh CDN 不可用导致白屏** → Mitigation：通过 `EXTERNALS_CDN` 环境变量开关，可秒级回滚到自托管模式；后续可考虑增加 `<script>` onerror fallback 到自托管 React。
- **[风险] importmap 浏览器兼容性** → 现代浏览器（Chrome 89+、Firefox 108+、Safari 16.4+）全部支持。项目目标浏览器为现代浏览器，无需 polyfill。如果未来要支持旧浏览器，可加 `es-module-shims` polyfill。
- **[风险] React CDN 版本与 package.json 版本不一致** → Mitigation：CI 构建时从 `package.json` 读取 `react` 版本，注入到 importmap URL，保证版本一致。
- **[风险] Sentry source map 上传流程受影响** → `external` 配置只影响 react/react-dom,不影响 Sentry;Sentry 仍正常打包进 bundle,source map 流程不变。需要在实现后跑一次 `npm run build` 验证 Sentry 插件正常上传。
- **[权衡] manualChunks 固定分组 vs 函数式动态分组** → 固定分组配置简单、可读性强,但新增依赖时需要手动维护。当前依赖少(3 个),固定分组够用;未来依赖多了可改为函数式。
- **[权衡] CDN 加载 React 增加一次 RTT** → esm.sh 是边缘 CDN,国内访问延迟可控;React 18.3.1 gzip 后 ~13 kB,CDN 命中浏览器缓存后零成本。首屏多一次 RTT 换取后续所有页面加载都共享浏览器缓存的 React,整体净收益正向。
- **[无需改动] 多 chunk 与现有 R2 + Worker 架构兼容** → Worker 当前对 `/assets/*` 的处理是"按 artifactId 从 R2 取文件并设长缓存",多 chunk 只是多了几个文件,Worker 路由逻辑零改动;R2 侧 CI 已是 `aws s3 sync dist/ s3://fe-depoly-assets/`(全量同步),多 chunk 自动随 `dist/` 上传,且 `artifacts/{BUILD_ID}/` 也自动多版本共存,无需任何部署侧改动。

## Migration Plan

> **分支策略**:本项目无 staging 分支,push 到 `main` 即触发 CI(`.github/workflows/deploy-r2-worker.yml`),自动完成 build → 上传 R2 → 部署 Worker → 更新 KV 指针。新版本立即对所有用户生效。所以"先 staging 再生产"在本项目不存在——验证依赖 Sentry 错误率监控 + KV 指针秒级回滚。

1. **第一步:仅做 manualChunks 分包**(不外置)
   - 修改 `vite.config.ts` 增加 `manualChunks` 配置
   - 跑 `npm run build` + `npm run analyze`,确认产物出现 `vendor-react-[hash].js`、`vendor-sentry-[hash].js`
   - push 到 main,CI 自动部署,浏览器访问生产域名验证页面正常加载
   - 修改业务代码(如改 App.tsx 文案),重新 push,确认 vendor chunk hash 不变(浏览器二次访问命中长缓存)
2. **第二步:开启 externals + CDN**
   - 在 `vite.config.ts` 增加 `external` 配置(受 `EXTERNALS_CDN` 控制)
   - 增加 `transformIndexHtml` 插件注入 importmap
   - 在 `.env.production` 增加 `EXTERNALS_CDN=true`
   - 跑 `npm run build`,确认 `dist/` 下不再有 react 代码,且 `index.html` 包含 importmap
   - 浏览器本地打开 dist/index.html,验证 React 正常加载
   - push 到 main,CI 部署后访问生产域名,Network 面板确认 React 从 esm.sh 加载
3. **第三步:生产观察**
   - push 后观察 24h Sentry 错误率,确认无新增 "React is not defined"、"Failed to resolve module specifier 'react'" 等错误
   - 如有问题,通过 admin UI 或 `wrangler kv key put current-artifact <旧BUILD_ID>` 秒级回滚

**回滚策略**:
- 任何阶段出问题,设置 `EXTERNALS_CDN=false` 重新部署即可回滚到自托管 React。
- 如果 manualChunks 阶段出问题,删除 `manualChunks` 配置回滚到单 bundle。
- KV 指针 `current-artifact` 切回旧 BUILD_ID,因为 R2 的 `artifacts/{BUILD_ID}/` 多版本共存,可秒级回滚到任意历史版本(包括多 chunk 之前的单 bundle 版本),无需重新 build。

## Open Questions

- **esm.sh vs jsdelivr vs unpkg**：esm.sh 专门为 ESM 优化，但国内访问速度未验证。需要在实现阶段跑一次 `curl -w"%{time_total}" https://esm.sh/react@18.3.1` 对比其他 CDN。如果国内访问慢，可考虑换成 jsdelivr（`https://cdn.jsdelivr.net/npm/react@18.3.1/+esm`）。
- **是否需要给 Sentry 也做外置**：Sentry 占 50% 体积，但版本变更频繁（每次升级 hash 变），CDN 命中率不如 React。本次不做，等后续观察 Sentry 升级频率再决定。
- **importmap 是否需要 integrity**：SRI（Subresource Integrity）可以防止 CDN 被篡改，但 esm.sh 的 SRI 计算需要额外脚本生成。本次先不加，后续可作为安全加固单独立 change。
