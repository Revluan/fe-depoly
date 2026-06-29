# Bundle Optimization Capability

## Purpose

前端构建产物的分包、Tree Shaking、依赖外置策略,把第三方代码与业务代码在产物层面解耦,最大化长缓存命中率、降低首屏 JS 体积。适用于基于 Vite/Rollup 的 SPA 项目。

## Requirements

### Requirement: Vendor 代码与业务代码分离

构建产物 SHALL 将 `react`、`react-dom`、`@sentry/react` 拆分到独立的 vendor chunk,业务代码变动 MUST NOT 导致 vendor chunk 的文件名 hash 漂移。

#### Scenario: 业务代码变动不影响 vendor chunk hash
- **WHEN** 开发者修改 `src/App.tsx` 的文案后执行 `npm run build`
- **THEN** `dist/assets/vendor-react-[hash].js` 与 `dist/assets/vendor-sentry-[hash].js` 的 hash 与上次构建保持一致
- **AND** `dist/assets/index-[hash].js` 的 hash 发生变化

#### Scenario: 首次构建生成多个 chunk
- **WHEN** 执行 `npm run build`
- **THEN** `dist/assets/` 目录下 SHALL 出现至少 3 个 JS 文件:`index-[hash].js`、`vendor-react-[hash].js`、`vendor-sentry-[hash].js`

#### Scenario: Sentry source map 上传不受影响
- **WHEN** 在 CI 环境执行 `npm run build` 且注入了 `SENTRY_AUTH_TOKEN`
- **THEN** Sentry 插件 SHALL 正常上传所有 chunk 的 source map
- **AND** 上传后 `dist/` 下 SHALL 不包含 `.map` 文件

### Requirement: Tree Shaking 配置显式声明

`vite.config.ts` SHALL 显式开启 Rollup 的 Tree Shaking(`build.rollupOptions.treeshake`),并在 `package.json` 中通过 `sideEffects` 字段声明有副作用的文件类型,使构建工具能正确识别可被 Tree Shake 的模块。

#### Scenario: package.json 声明 sideEffects
- **WHEN** 查看 `package.json` 顶层字段
- **THEN** SHALL 存在 `"sideEffects"` 字段
- **AND** 其值为数组,包含至少 `["*.css", "*.svg"]`

#### Scenario: vite.config.ts 显式开启 treeshake
- **WHEN** 查看 `vite.config.ts` 的 `build.rollupOptions` 配置
- **THEN** SHALL 存在 `treeshake: true`(或等价的对象配置)

### Requirement: 依赖外置通过环境变量开关

系统 SHALL 通过 `EXTERNALS_CDN` 环境变量控制是否将 `react`、`react-dom` 外置到 CDN 加载,默认关闭(`false`)。

#### Scenario: 默认关闭外置
- **WHEN** 未设置 `EXTERNALS_CDN` 环境变量执行 `npm run build`
- **THEN** 构建产物 `dist/assets/vendor-react-[hash].js` SHALL 存在(React 被打包进 bundle)
- **AND** `dist/index.html` MUST NOT 包含 importmap script 标签

#### Scenario: 开启外置
- **WHEN** 设置 `EXTERNALS_CDN=true` 执行 `npm run build`
- **THEN** 构建产物中 MUST NOT 存在包含 React 运行时的 chunk(React 通过 CDN 加载)
- **AND** `dist/index.html` SHALL 包含 `<script type="importmap">` 标签,映射 `react`、`react-dom`、`react-dom/client` 到 esm.sh CDN URL
- **AND** importmap 中的 React 版本 SHALL 与 `package.json` 中 `react` 的版本号一致

#### Scenario: 本地开发不依赖 CDN
- **WHEN** 执行 `npm run dev`(未设置 `EXTERNALS_CDN`)
- **THEN** 开发服务器 SHALL 正常启动,不依赖任何外部 CDN

#### Scenario: 多 chunk 产物完整上传到 R2
- **WHEN** push 到 main 触发 CI 执行 `aws s3 sync dist/ s3://fe-depoly-assets/`
- **THEN** `dist/assets/` 下所有 chunk(`index-[hash].js`、`vendor-react-[hash].js`、`vendor-sentry-[hash].js`)SHALL 全部上传到 R2 根目录 `assets/`
- **AND** 同一套 chunk SHALL 也同步到 `artifacts/{BUILD_ID}/assets/`(用于版本回滚)
- **AND** Worker 路由逻辑 MUST NOT 需要任何改动(多 chunk 仍走现有 `/assets/*` → R2 取文件 → 边缘缓存的路径)

### Requirement: CDN 加载失败可回滚

当 CDN 模式出现问题时,运维 SHALL 能通过多种方式回滚,且至少有一种方式无需重新构建代码。

#### Scenario: 环境变量回滚(需重新部署)
- **WHEN** 生产环境将 `EXTERNALS_CDN` 从 `true` 改为 `false` 并重新 push 到 main 触发 CI
- **THEN** 新部署的产物 SHALL 不再依赖 CDN
- **AND** React 代码 SHALL 重新被打包进 `vendor-react-[hash].js`

#### Scenario: KV 指针回滚(秒级,无需重新 build)
- **WHEN** 生产环境通过 admin UI 或 `wrangler kv key put current-artifact <旧BUILD_ID>` 切换 KV 指针
- **THEN** Worker SHALL 立即从 `artifacts/{旧BUILD_ID}/` 取文件返回
- **AND** 回滚生效时间 SHALL 小于 60 秒(KV 全球传播)
- **AND** 旧 BUILD_ID 下的所有 chunk 文件 MUST 在 R2 中仍然存在(因为 `artifacts/{BUILD_ID}/` 是多版本共存的)

### Requirement: 优化结果可量化验证

构建产物 SHALL 通过 `npm run analyze` 生成可视化的体积分析报告,支持优化前后对比。

#### Scenario: 对比优化前后体积
- **WHEN** 在优化前后分别执行 `npm run analyze`
- **THEN** 生成的 `stats.html` SHALL 显示各 chunk 的 gzip/brotli 体积
- **AND** 优化后的 `index-[hash].js` gzip 体积 SHALL 小于优化前(因为部分代码被拆到 vendor chunk)
