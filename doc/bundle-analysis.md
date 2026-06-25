# 产物体积分析（rollup-plugin-visualizer）

> 阶段五·性能优化与监控的第 2 步：用可视化工具看清楚 dist/ 里每个模块占多少体积，为后续优化（拆包、Tree Shaking、依赖替换）提供依据。

## 一、为什么要做产物分析

### 1. 问题背景
项目跑一次 build，终端只输出一个总体积：

```
dist/assets/index-CYOxeN2H.js   159.87 kB │ gzip: 52.02 kB
```

但这个 159.87 kB 里**到底装了什么**？是 React？是 Sentry？还是某个依赖把整个 lodash 都打进来了？不知道这个，优化就是盲打。

### 2. 产物分析能回答的问题
- 哪些依赖占了最大体积？该优化谁？
- 业务代码 vs 第三方依赖占比多少？
- 是否有重复打包（同一个依赖被多个入口引入）？
- Tree Shaking 是否生效（按需引入是否真的按需）？
- gzip / brotli 压缩后的真实传输体积是多少？

### 3. 工具选型

| 工具 | 适配构建工具 | 特点 |
| --- | --- | --- |
| **rollup-plugin-visualizer** | Vite / Rollup | 生成单个 stats.html，离线可看，最常用 |
| webpack-bundle-analyzer | Webpack | Webpack 项目标配 |
| vite-bundle-visualizer | Vite | 包装了 rollup-plugin-visualizer，配置更简单 |
| source-map-explorer | 任意（需要 source map） | 通过 source map 反推，不依赖构建工具 |

本项目用 Vite，选 `rollup-plugin-visualizer`。

## 二、接入步骤

### 1. 安装

```bash
npm i -D rollup-plugin-visualizer
```

### 2. 修改 vite.config.ts

```ts
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig(({ mode }) => {
  // ...其他变量
  const enableAnalyze = process.env.ANALYZE === 'true'

  return {
    plugins: [
      react(),
      // ...其他插件
      ...(enableAnalyze
        ? [
            visualizer({
              filename: 'stats.html',       // 输出文件名
              template: 'treemap',           // 图表类型:treemap/sunburst/network
              gzipSize: true,                // 显示 gzip 体积
              brotliSize: true,              // 显示 brotli 体积
              open: false,                   // 不自动打开浏览器(CI 友好)
            }),
          ]
        : []),
    ],
    // ...
  }
})
```

### 3. 加 npm 脚本

`package.json`:

```json
{
  "scripts": {
    "analyze": "ANALYZE=true vite build"
  }
}
```

### 4. 加 .gitignore

```
# Bundle analysis
stats.html
```

`stats.html` 是构建产物，不应该提交到仓库。

## 三、关键设计：用环境变量控制开关

### 1. 为什么不直接 `open: true`

如果 `open: true`，每次 build 都会：
- 生成 `stats.html`（拖慢构建）
- 自动打开浏览器（CI 里直接报错）

### 2. 为什么用 `ANALYZE=true` 而不是 `mode === 'analyze'`

Vite 的 `mode` 是构建模式（development / production / staging 等），改成 analyze 会影响 env 文件加载、Sentry 插件判断等。用独立环境变量更干净：

```ts
const enableAnalyze = process.env.ANALYZE === 'true'
```

这样 `npm run build` 走正常流程，`npm run analyze` 才生成 stats.html，互不影响。

## 四、运行与查看

### 1. 生成 stats.html

```bash
npm run analyze
```

输出：

```
vite v7.3.5 building client environment for production...
✓ 367 modules transformed.
dist/assets/index-CYOxeN2H.js   159.87 kB │ gzip: 52.02 kB
✓ built in 947ms
```

### 2. 打开 stats.html

```bash
open stats.html       # macOS
xdg-open stats.html   # Linux
start stats.html      # Windows
```

### 3. 三种图表类型

| 类型 | 适合场景 |
| --- | --- |
| `treemap`（默认） | 看每个模块占比，矩形面积 = 体积，最直观 |
| `sunburst` | 看层级关系，外层是入口，内层是依赖 |
| `network` | 看模块间依赖关系 |

日常用 `treemap` 就够了。

## 五、本项目首次分析结果

### 1. 总体积

```
dist/assets/index-CYOxeN2H.js   159.87 kB │ gzip: 52.02 kB
```

gzip 后 52 kB，对一个 SPA 来说还在合理范围内（红线一般是 200 kB gzip）。

### 2. 主要占比

打开 stats.html 后能看到（按体积降序）：

| 模块 | 占比 | 说明 |
| --- | --- | --- |
| `@sentry/react` | ~50% | Sentry SDK 占大头，主要是 core + browser + tracing |
| `react` + `react-dom` | ~40% | React 运行时，固定开销 |
| 业务代码（App.tsx 等） | ~5% | 当前业务代码极少 |
| 其他 | ~5% | 工具函数、样式等 |

### 3. 关键观察

- **Sentry 占了一半体积**：这是接入了错误监控 + 性能监控（browserTracingIntegration）的代价。如果只接错误监控不接性能监控，可以减一些。
- **业务代码占比极低**：因为项目还是 demo 阶段，没有真实业务。后续真实业务代码上来了，这个比例会反转。
- **没有重复打包**：treemap 里没有看到同一个依赖出现两次，说明 Vite 的去重生效了。

## 六、什么时候该跑分析

| 场景 | 是否跑 |
| --- | --- |
| 新增依赖 | ✅ 跑一次，看新依赖占多少 |
| 怀疑打包体积变大 | ✅ 对比历史 stats.html |
| 优化前后对比 | ✅ 看优化效果 |
| 日常 build | ❌ 别跑，浪费时间 |
| CI 流水线 | ❌ 别跑，CI 不需要看图 |

## 七、常见误区与陷阱

### 1. 把 stats.html 提交到仓库

stats.html 是构建产物，体积大（几百 KB）、变化频繁、对其他开发者没用。**必须 gitignore**。

### 2. 在 CI 里开启分析

CI 跑 `npm run build` 而不是 `npm run analyze`，否则每次 CI 都生成 stats.html，浪费资源。

### 3. 只看 raw size 不看 gzip

浏览器实际传输的是 gzip 后的体积。一个 200 kB 的文件 gzip 后可能只有 60 kB。**优化决策看 gzip size**，不是 raw size。

### 4. 看到体积大就盲目优化

Sentry 占 50% 不代表要优化它——错误监控的价值远超 25 kB gzip。**先看 ROI**：
- 替换 Sentry → 节省 25 kB，但失去错误监控，不值
- 拆包按需加载 Sentry → 节省 25 kB 首屏，但出错时才加载，可能丢早期错误，需要权衡
- 删掉未使用的 lodash → 节省 20 kB，无副作用，必做

### 5. 忽略 brotli 体积

Brotli 比 gzip 多压 5-15%。如果服务器支持 Brotli（Cloudflare 默认支持），实际传输体积比 stats.html 里 gzip 列还小。看 brotli 列更接近真实。

## 八、后续可做的优化（基于本次分析）

按 ROI 排序：

### 1.（暂不需要）React 改用 production build
当前已经是 production build（vite 默认），无需操作。

### 2.（推荐）后续业务代码上来后做代码分割
等业务代码占比超过 30%，用 `React.lazy` + `Suspense` 把路由级代码分割出来，首屏只加载当前路由需要的代码。

### 3.（可选）Sentry tracing 采样率调整
当前 `tracesSampleRate: 0.1`（生产 10%），如果想再减体积，可以去掉 `browserTracingIntegration`，只保留错误监控，能省 ~15 kB。但会失去性能监控能力，需要权衡。

### 4.（暂不需要）依赖外置
当前没有用 CDN 加载 React，如果后续接 CDN，可以把 react / react-dom 外置（external），不打包进 bundle。但当前部署在 Cloudflare R2 + Worker，自己托管比 CDN 加载更可控。

## 九、参考链接

- rollup-plugin-visualizer: https://github.com/btd/rollup-plugin-visualizer
- Vite 构建优化: https://vitejs.dev/guide/build.html#chunking-strategy
- Bundle Analyzer 对比: https://bundlephobia.com/

## 十、验证清单

- [x] 安装 `rollup-plugin-visualizer` 作为 devDependency
- [x] `vite.config.ts` 用 `ANALYZE` 环境变量控制开关
- [x] `package.json` 添加 `analyze` 脚本
- [x] `.gitignore` 添加 `stats.html`
- [x] `npm run analyze` 能成功生成 `stats.html`
- [x] 浏览器打开 `stats.html` 能看到 treemap
- [x] 正常 `npm run build` 不受影响（不生成 stats.html）
