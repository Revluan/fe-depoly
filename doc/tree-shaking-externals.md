# Tree Shaking 与依赖外置

> 阶段五·性能优化与监控的第 4 步:把第三方依赖与业务代码在产物层面解耦,最大化长缓存命中率,降低首屏 JS 体积。
> 配套文档:`doc/bundle-analysis.md`(产物体积分析)、`doc/sentry.md`(错误监控)。

## 一、为什么要做

### 1. 问题背景

阶段五产物分析(`doc/bundle-analysis.md`)显示首屏单一 `index-[hash].js` gzip 后 52 kB,其中:
- `@sentry/react` 占 ~50%
- `react` + `react-dom` 占 ~40%
- 业务代码 < 10%

每次业务代码变动,整个 bundle 的 hash 漂移,即使用户本地已缓存过相同版本的第三方代码,浏览器仍要重新下载全部 52 kB。

### 2. 优化目标

- **vendor 代码与业务代码分离**:React/Sentry 拆到独立 chunk,业务代码变动不影响 vendor chunk 的长缓存
- **依赖外置(可选)**:通过 CDN 加载 React,bundle 里不再打包 React 运行时
- **Tree Shaking 显式声明**:确保未使用的代码被 shake 掉
- **环境变量开关**:本地开发不依赖 CDN,生产可秒级回滚

## 二、配置方式

### 1. Tree Shaking 显式声明

**`package.json`** 顶层添加 `sideEffects` 字段:

```json
{
  "dependencies": { ... },
  "sideEffects": ["*.css", "*.svg", "*.png", "*.jpg"]
}
```

告诉构建工具:除了列出的文件类型,其他 JS/TS 模块都是纯函数,可以放心 Tree Shake。

**`vite.config.ts`** 显式开启 Rollup 的 treeshake:

```ts
build: {
  rollupOptions: {
    treeshake: true,  // Rollup 默认开启,显式声明 + sideEffects 配合
  },
},
```

### 2. 手动分包(manualChunks)

把 `react`/`react-dom` 拆成 `vendor-react` chunk,`@sentry/react` 拆成 `vendor-sentry` chunk:

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks(id) {
        if (id.includes('node_modules')) {
          if (
            !enableExternals &&
            (id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/'))
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
```

**关键设计:用函数式而非对象式 manualChunks**

对象式 `manualChunks: { 'vendor-react': ['react', 'react-dom'] }` 在 `external` 模式下会报错:

```
"react" cannot be included in manualChunks because it is resolved as an external module
```

函数式可以在 `enableExternals=true` 时跳过 react 分组,让 Rollup 不报错。

### 3. 依赖外置(externals + importmap)

**`vite.config.ts` 顶部读取环境变量:**

```ts
const enableExternals = process.env.EXTERNALS_CDN === 'true'
```

**`build.rollupOptions.external`** 把 react 加入外置:

```ts
build: {
  rollupOptions: {
    ...(enableExternals
      ? { external: ['react', 'react-dom', 'react-dom/client'] }
      : {}),
  },
},
```

**inline 插件 `externalsImportMap()` 注入 importmap:**

```ts
function getReactVersion(): string {
  const pkgPath = path.resolve(__dirname, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  return pkg.dependencies.react.replace(/^[^0-9]+/, '')
}

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
      return html.replace('<head>', `<head>${importMapTag}`)
    },
  }
}
```

**`plugins` 数组中条件性加入:**

```ts
plugins: [
  react(),
  // ...其他插件
  ...(enableExternals ? [externalsImportMap()] : []),
],
```

**`.env.production` 添加:**

```bash
EXTERNALS_CDN=true
```

### 4. 环境变量说明

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `EXTERNALS_CDN` | `false` | `true` 时外置 react/react-dom 到 esm.sh CDN |
| `ANALYZE` | `false` | `true` 时生成 stats.html 体积分析 |
| `SENTRY_AUTH_TOKEN` | - | CI 注入,触发 Sentry source map 上传 |

### 5. 部署链路(无变化)

多 chunk 不改 Worker 路由逻辑。CI 仍是:
- `aws s3 sync dist/ s3://fe-depoly-assets/` (全量版本,根目录)
- `aws s3 sync dist/ s3://fe-depoly-assets/artifacts/{BUILD_ID}/` (多版本共存)

多 chunk 自动随 `dist/` 上传。Worker 对 `/assets/*` 的处理仍是"按 artifactId 从 R2 取文件 + 设长缓存",零改动。

## 三、CDN 选型测速

### 1. 测试方法

```bash
curl -w "%{time_total}\n" -o /dev/null -s https://esm.sh/react@18.3.1
curl -w "%{time_total}\n" -o /dev/null -s https://cdn.jsdelivr.net/npm/react@18.3.1/+esm
curl -w "%{time_total}\n" -o /dev/null -s https://unpkg.com/react@18.3.1/?module
```

### 2. 测试结果(2026-06-29,上海电信)

| CDN | 第 1 次 | 第 2 次 | 第 3 次 | 平均 |
| --- | --- | --- | --- | --- |
| **esm.sh** | 0.128s | 0.128s | 0.126s | **0.127s** |
| jsdelivr | 0.146s | 0.133s | 0.135s | 0.138s |
| unpkg | 0.447s | 0.148s | 0.148s | 0.248s |

### 3. 结论

esm.sh 最快且最稳定,选 esm.sh 作为 CDN。

**esm.sh 的额外优势**:
- 专门为 ESM 优化,自动处理 `react-dom/client` 子路径
- 自动提供 dependency resolution,不需要 `?module` 后缀
- 边缘节点国内访问延迟可控

## 四、产物体积对比

### 1. 优化前(单一 bundle)

```
dist/assets/index-CYOxeN2H.js   159.87 kB │ gzip: 52.02 kB
```

### 2. manualChunks 分包后(默认模式,不外置)

| chunk | raw | gzip | 说明 |
| --- | --- | --- | --- |
| `index-[hash].js` | 10.03 kB | 3.74 kB | 业务代码 |
| `vendor-react-[hash].js` | 141.76 kB | 45.57 kB | react + react-dom |
| `vendor-sentry-[hash].js` | 16.43 kB | 5.74 kB | @sentry/react |
| `index-[hash].css` | 5.19 kB | 1.45 kB | 样式 |
| **合计** | 163.41 kB | **51.00 kB** | gzip 与优化前基本一致 |

**关键收益**:总体积没变,但业务代码变动后只有 `index-[hash].js` 的 hash 变,`vendor-react` 和 `vendor-sentry` 的 hash 保持稳定,浏览器长缓存命中率从 0% 提升到 ~92%(51-4=47 kB 命中缓存)。

### 3. externals + CDN 模式(`EXTERNALS_CDN=true`)

| chunk | raw | gzip | 说明 |
| --- | --- | --- | --- |
| `index-[hash].js` | 10.62 kB | 4.12 kB | 业务代码 |
| `vendor-sentry-[hash].js` | 16.44 kB | 5.74 kB | @sentry/react |
| `index-[hash].css` | 5.19 kB | 1.45 kB | 样式 |
| **自托管合计** | 32.25 kB | **11.31 kB** | gzip 后仅 11 kB |
| (CDN 加载) react+react-dom | - | ~13 kB | 浏览器从 esm.sh 加载,命中浏览器缓存后零成本 |

**关键收益**:自托管 bundle 从 52 kB gzip 降到 11 kB gzip(降 78%),首屏只下载 11 kB 自托管 + 13 kB CDN React。后续访问 React 命中浏览器缓存,首屏 JS 仅 11 kB。

## 五、踩坑点

### 1. 对象式 manualChunks 与 external 冲突

**问题**:用对象式 `manualChunks: { 'vendor-react': ['react', 'react-dom'] }`,当 `external: ['react']` 时 Rollup 报错:

```
"react" cannot be included in manualChunks because it is resolved as an external module
```

**解决**:改用函数式 manualChunks,在 `enableExternals=true` 时跳过 react 分组。

### 2. importmap 必须在 module script 之前解析

**问题**:如果 importmap 在 `<script type="module">` 之后,浏览器会报错:

```
Failed to resolve module specifier 'react'
```

**解决**:`transformIndexHtml` 中把 importmap 注入到 `<head>` 标签后,确保在所有 module script 之前。

### 3. react-dom/client 子路径必须单独映射

**问题**:只映射 `react` 和 `react-dom`,业务代码 `import { createRoot } from 'react-dom/client'` 会失败,因为 esm.sh 不自动解析子路径。

**解决**:importmap 显式映射 `react-dom/client`:

```json
{
  "imports": {
    "react": "https://esm.sh/react@18.3.1",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client"
  }
}
```

### 4. CI 构建时 Sentry 插件不能影响 externals

**问题**:Sentry vite-plugin 默认会处理所有 chunk 的 source map。externals 模式下 react 不在 chunk 里,Sentry 上传时找不到 react 的 source map,但这不是问题——Sentry 只关心业务代码的错误堆栈,React 内部错误用户上报时由 esm.sh 自己的 source map 负责(浏览器会自动加载)。

**解决**:无需特殊处理,Sentry 插件自动跳过 external 模块。

### 5. 浏览器兼容性

importmap 要求:
- Chrome 89+ (2021-03)
- Firefox 108+ (2022-12)
- Safari 16.4+ (2023-03)

本项目目标浏览器为现代浏览器,无需 polyfill。如果未来要支持旧浏览器,加 `es-module-shims` polyfill。

## 六、ROI 分析

### 1. 收益

| 维度 | 优化前 | manualChunks | externals+CDN |
| --- | --- | --- | --- |
| 首屏自托管 JS(gzip) | 52 kB | 51 kB(分块) | **11 kB** |
| 长缓存命中率(业务变动后) | 0% | 92% | 60%(仅 sentry + business) |
| 浏览器后续访问首屏 JS | 52 kB | 4 kB(命中缓存) | 11 kB(React 命中浏览器缓存) |
| 版本回滚兼容性 | 单 bundle | 多 chunk | 多 chunk |

### 2. 成本

- 代码改动:`vite.config.ts` ~50 行,`package.json` 加 sideEffects 字段
- 部署改动:零(Worker 路由不变,R2 多几个文件)
- 运维改动:多一个环境变量 `EXTERNALS_CDN`,出问题可秒级回滚

### 3. 何时该开 externals

| 场景 | 推荐 |
| --- | --- |
| 国内用户为主 | ✅ esm.sh 国内访问 0.13s,可接受 |
| 海外用户为主 | ✅ esm.sh 边缘节点遍布全球 |
| 强 SRI(防 CDN 篡改)需求 | ⚠️ 暂未加 SRI,后续可加 |
| 离线/内网部署 | ❌ 关闭 externals,用 manualChunks 即可 |
| 浏览器需支持 Safari < 16.4 | ❌ 加 `es-module-shims` polyfill 或关闭 externals |

## 七、回滚策略

### 1. 环境变量回滚(需重新部署)

把 `EXTERNALS_CDN` 改为 `false`,重新 push 到 main,CI 自动重新构建部署。React 重新打包进 `vendor-react-[hash].js`。

### 2. KV 指针回滚(秒级,无需重新 build)

```bash
# 列出历史 BUILD_ID
wrangler kv key list --namespace-id=<KV_ID> --prefix=artifacts/ | head

# 切回旧 BUILD_ID(秒级生效)
wrangler kv key put current-artifact <旧BUILD_ID> --namespace-id=<KV_ID>
```

或通过 admin UI 一键切换。R2 的 `artifacts/{BUILD_ID}/` 多版本共存,旧版本的所有 chunk 仍在,无需重新 build。

## 八、验证清单

- [x] `package.json` 添加 `sideEffects` 字段
- [x] `vite.config.ts` 显式 `treeshake: true`
- [x] `manualChunks` 函数式配置,vendor-react/vendor-sentry 分包
- [x] `EXTERNALS_CDN` 环境变量开关
- [x] `externalsImportMap()` 插件注入 importmap
- [x] `.env.production` 添加 `EXTERNALS_CDN=true`
- [x] `EXTERNALS_CDN=true npm run build` 产物无 react chunk
- [x] esm.sh vs jsdelivr vs unpkg 测速对比,选 esm.sh
- [x] `npm run lint` / `type-check` / `test` 通过
- [ ] push 到 main,CI 部署后访问生产域名验证
- [ ] 修改 App.tsx 文案重新部署,确认 vendor chunk hash 不变
- [ ] 24h Sentry 错误率监控

## 九、参考链接

- Vite 构建优化:https://vitejs.dev/guide/build.html#chunking-strategy
- Rollup manualChunks:https://rollupjs.org/configuration-options/#output-manualchunks
- importmap 规范:https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap
- esm.sh:https://esm.sh/
- Tree Shaking 原理:https://webpack.js.org/guides/tree-shaking/
