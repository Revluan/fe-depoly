## 1. Tree Shaking 显式声明

- [x] 1.1 在 `package.json` 顶层添加 `"sideEffects": ["*.css", "*.svg", "*.png", "*.jpg"]` 字段
- [x] 1.2 在 `vite.config.ts` 的 `build.rollupOptions` 中显式添加 `treeshake: true`
- [x] 1.3 跑 `npm run build` 确认构建成功,产物体积无明显异常波动
- [x] 1.4 跑 `npm run analyze` 对比 stats.html,确认无新增整包打入现象

## 2. 手动分包(manualChunks)

- [x] 2.1 在 `vite.config.ts` 的 `build.rollupOptions.output` 中添加 `manualChunks` 配置,定义 `vendor-react`(`react`、`react-dom`)和 `vendor-sentry`(`@sentry/react`)两个 chunk
- [x] 2.2 跑 `npm run build`,确认 `dist/assets/` 下出现 `vendor-react-[hash].js` 和 `vendor-sentry-[hash].js`
- [x] 2.3 修改 `src/App.tsx` 文案,重新 build,确认 vendor chunk hash 不变、index chunk hash 变化
- [x] 2.4 在浏览器打开 `dist/index.html`(或 `npm run preview`),确认页面正常渲染、Sentry ErrorBoundary 正常工作
- [x] 2.5 跑 `npm run analyze` 记录优化后的 stats.html 各 chunk 体积

## 3. 依赖外置(externals + importmap)

- [x] 3.1 在 `vite.config.ts` 顶部读取 `EXTERNALS_CDN` 环境变量(参考现有 `ANALYZE` 模式)
- [x] 3.2 当 `EXTERNALS_CDN=true` 时,在 `build.rollupOptions.external` 中添加 `'react'`、`'react-dom'`、`'react-dom/client'`
- [x] 3.3 当 `EXTERNALS_CDN=true` 时,从 `package.json` 读取 `react` 版本号(用 `fs.readFileSync` + `JSON.parse`,避免引入额外依赖)
- [x] 3.4 实现一个 inline Vite 插件 `externalsImportMap()`,在 `transformIndexHtml` 钩子中向 `<head>` 注入 `<script type="importmap">`,映射 `react`、`react-dom`、`react-dom/client` 到 `https://esm.sh/react@<version>` 等对应 URL
- [x] 3.5 在 `plugins` 数组中条件性加入该插件(仅当 `EXTERNALNS_CDN=true` 时)
- [x] 3.6 在 `.env.production` 中添加 `EXTERNALS_CDN=true`(若文件不存在则创建)
- [x] 3.7 跑 `EXTERNALS_CDN=true npm run build`,确认 `dist/index.html` 包含 importmap 标签且 importmap 中 React 版本与 package.json 一致
- [x] 3.8 确认 `dist/assets/` 下不再有 `vendor-react-[hash].js`(React 已外置),`vendor-sentry-[hash].js` 仍存在
- [x] 3.9 在浏览器打开 `dist/index.html`,Network 面板确认 React 从 esm.sh 加载,页面正常渲染

## 4. CDN 测速与选型验证

- [x] 4.1 跑 `curl -w "%{time_total}\n" -o /dev/null -s https://esm.sh/react@18.3.1` 测试 esm.sh 国内访问延迟
- [x] 4.2 对比 `https://cdn.jsdelivr.net/npm/react@18.3.1/+esm` 的延迟
- [x] 4.3 如果 jsdelivr 明显更快,把 `externalsImportMap` 插件中的 CDN URL 改为 jsdelivr;否则保持 esm.sh
- [x] 4.4 把测速结果记录到 `doc/tree-shaking-externals.md`

## 5. 文档与验证清单

- [x] 5.1 新建 `doc/tree-shaking-externals.md`,记录:配置方式、环境变量说明、踩坑点、ROI 分析、测速对比
- [x] 5.2 在 `doc/plan.md` 阶段五的 "Tree Shaking 与依赖外置" 一项打勾 `[x]` 并附文档链接
- [x] 5.3 更新 `doc/bundle-analysis.md` 的"后续可做的优化"章节,把"依赖外置"一项标注为已完成并附新文档链接
- [x] 5.4 跑 `npm run build` 与 `EXTERNALS_CDN=true npm run build` 两种模式,记录产物体积对比表到 `doc/tree-shaking-externals.md`
- [x] 5.5 跑 `npm run lint`、`npm run type-check`、`npm run test`,确认无新增报错

## 6. 部署验证(main 分支直推)

> 本项目 CI 触发条件是 `push to main`,无 staging 分支。push 后 CI 自动:build → 上传 `dist/` 到 R2(根目录 + `artifacts/{BUILD_ID}/`) → 更新 `current-artifact` KV 指针。新版本立即对所有用户生效。

- [x] 6.1 在本地完成 1-5 节所有任务并验证通过后,commit 改动到 main 分支
- [x] 6.2 push 到 main,触发 `.github/workflows/deploy-r2-worker.yml`(commit `ae60410` 已 push,CI 触发;UI 全绿待用户在 GitHub Actions 面板确认)
- [ ] 6.3 CI 完成后,浏览器访问生产域名,DevTools Network 面板确认:
  - 6.3.1 `index.html` 响应头 `Cache-Control: no-cache` 正常
  - 6.3.2 多 chunk 模式下:`vendor-react-[hash].js`、`vendor-sentry-[hash].js`、`index-[hash].js` 均从 R2(经 Cloudflare CDN 边缘缓存)返回,状态 200,`Cache-Control: public, max-age=31536000, immutable`
  - 6.3.3 externals 模式下:`index.html` 包含 importmap,React 从 esm.sh 加载(状态 200),`dist/assets/` 下不存在 `vendor-react-[hash].js`
  - 6.3.4 页面正常渲染,Sentry ErrorBoundary 工作正常(点 "Trigger Error" 验证上报)
- [ ] 6.4 修改 `src/App.tsx` 文案,push 到 main,新 BUILD_ID 部署后确认:
  - 6.4.1 `vendor-react-[hash].js`、`vendor-sentry-[hash].js` 文件名 hash 与上一次构建一致(长缓存命中)
  - 6.4.2 `index-[hash].js` hash 变化,`index.html` 引用的是新 hash
- [ ] 6.5 推 main 后观察 24h Sentry 错误率,确认无新增 "React is not defined"、"Cannot read property X of undefined"、"Failed to resolve module specifier 'react'" 等错误
- [ ] 6.6 如果出问题,通过 admin UI 或 `wrangler kv key put current-artifact <旧BUILD_ID> --namespace-id=...` 秒级回滚到上一版本,无需回滚代码

## 7. R2 部署侧验证(无代码改动,仅确认)

> 多 chunk 不改 Worker 路由逻辑,但需要在 R2 侧确认产物完整上传。

- [ ] 7.1 CI 部署完成后,用 `wrangler r2 object list fe-depoly-assets --prefix=assets/` 或 aws cli 确认 R2 中存在所有 chunk 文件
- [ ] 7.2 确认 R2 `artifacts/{BUILD_ID}/assets/` 下也同步了一份(用于灰度回滚时仍能取到该版本的所有 chunk)
- [ ] 7.3 确认 Worker 请求 `/assets/vendor-react-[hash].js` 时正确从 R2 取回(可在 Worker 日志或 Cloudflare Dashboard → Workers → Logs 看)
