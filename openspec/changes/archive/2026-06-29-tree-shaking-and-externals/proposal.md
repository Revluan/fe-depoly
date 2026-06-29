## Why

阶段五性能优化清单里的"产物体积分析"已经做完（`doc/bundle-analysis.md`），stats.html 显示首屏 bundle gzip 后 52 kB，其中 Sentry 占 ~50%、React/ReactDOM 占 ~40%。当前所有第三方依赖被打进单一 `index-[hash].js`，首屏必须把 Sentry + React 全量下载完才能渲染，且每次业务代码变动都会让整个 bundle 的 hash 漂移、使长缓存失效。需要通过 Tree Shaking 校验 + 手动分包 + 依赖外置，把"不变的第三方代码"和"频繁变动的业务代码"在产物层面分开，让首屏只加载渲染必需的代码，并最大化长缓存命中率。

## What Changes

- **校验并强化 Tree Shaking**：审查 `@sentry/react`、`react`、`react-dom` 的引入方式，确保按 ESM 命名导入而非整包 `import *`；在 vite.config.ts 中显式开启 `build.rollupOptions.treeshake`（Rollup 默认开启，但显式声明 + 配置 `moduleSideEffects` 让纯 CSS/样式文件不被误判有副作用）。
- **手动分包（manualChunks）**：把 `react` + `react-dom` 拆成 `vendor-react` chunk，把 `@sentry/react` 拆成 `vendor-sentry` chunk，业务代码留在 `index` chunk。第三方代码 hash 几乎不变，业务代码变动不影响 vendor chunk 的长缓存。
- **依赖外置（externals）**：把 `react`、`react-dom` 设为 Rollup externals，通过 `<script>` 标签从 CDN 加载（esm.sh 或 unpkg），bundle 里不再打包 React 运行时，首屏 JS 体积预计减少 ~40%。配套在 `index.html` 注入 CDN script 标签，并保留 fallback 机制。
- **环境变量开关**：通过 `EXTERNALS_CDN` 环境变量控制是否启用外置 + CDN 加载（生产开启、本地开发关闭，避免开发态受 CDN 网络抖动影响）。
- **Sentry 体积优化（可选 / 默认关闭）**：提供 `SENTRY_DISABLE_TRACING` 环境变量，关闭 `browserTracingIntegration` 时预计省 ~15 kB gzip，作为后续可选项暴露出来。
- **验证产物**：跑 `npm run analyze` 对比优化前后的 stats.html，记录到 `doc/bundle-analysis.md` 的"后续可做的优化"章节落地结果。
- **更新文档**：新增 `doc/tree-shaking-externals.md` 记录配置方式、踩坑点、ROI 分析。

非目标（Non-goals）：

- 不做路由级 `React.lazy` 代码分割（项目当前业务代码极少，等业务代码占比超过 30% 再做，单独立 change）。
- 不替换 Sentry 为更轻量的错误监控方案（错误监控价值远超体积成本，已在 bundle-analysis.md 论证）。
- 不接入 HTTP/3、Service Worker（属于阶段四的范畴）。

## Capabilities

### New Capabilities
- `bundle-optimization`: 前端构建产物的分包、Tree Shaking、依赖外置策略，目标是把第三方代码与业务代码在产物层面解耦，最大化长缓存命中率、降低首屏 JS 体积。

### Modified Capabilities
<!-- 当前 openspec/specs/ 为空，无既有 capability 需要修改 -->

## Impact

- **代码改动**：
  - `vite.config.ts`：新增 `build.rollupOptions.output.manualChunks`、`build.rollupOptions.external`、`build.rollupOptions.treeshake` 配置；新增 `EXTERNALS_CDN` 环境变量读取逻辑。
  - `index.html`：当 `EXTERNALS_CDN=true` 时注入 React CDN `<script>` 标签（通过 vite-plugin-html 或在 `vite.config.ts` 的 `transformIndexHtml` 钩子中处理）。
  - `src/main.tsx`：保持不变（React 仍以正常方式 import，external 后由 Rollup 替换为全局变量引用）。
- **新增依赖**：可能需要 `vite-plugin-html` 或手动 `transformIndexHtml` 注入 CDN 标签（优先用 Vite 内置能力，避免新依赖）。
- **构建产物**：`dist/` 下从单 `index-[hash].js` 变为 `index-[hash].js` + `vendor-react-[hash].js` + `vendor-sentry-[hash].js`；启用 externals 后 vendor-react chunk 消失（改为 CDN 加载）。
- **部署影响**：CDN 加载 React 需要保证 `index.html` 里的 CDN 域名在生产环境可达;Cloudflare Worker 需允许跨域加载 React CDN(默认允许,无需额外配置)。多 chunk 产物全部上传到 R2(根目录 + `artifacts/{BUILD_ID}/` 两个位置),Worker 路由逻辑无需改动——`/assets/*.js` 仍由 Worker 从 R2 取出并交由 Cloudflare CDN 边缘缓存长缓存。
- **回滚策略**：
  - `EXTERNALS_CDN=false` 重新部署,关闭外置回退到打包模式。
  - 通过 admin UI 把 `current-artifact` KV 指针切回旧 BUILD_ID,秒级回滚到上一版本(多 chunk 文件已在 `artifacts/{旧BUILD_ID}/` 多版本共存,无需重新 build)。
- **分支策略**：本项目无 staging 分支,所有改动直接在 `main` 分支完成,push 到 main 触发 CI 全自动部署。验证依赖 Sentry 错误率监控 + KV 指针秒级回滚,而非灰度比例。
- **验证方式**：`npm run analyze` 对比体积;`npm run build` 检查产物 chunk 数量;浏览器打开 dist 验证 React 正常加载;push main 后访问生产域名验证 R2 + CDN 链路正常。
