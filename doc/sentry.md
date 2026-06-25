# Sentry 错误监控接入实战

> 阶段五:性能优化与监控 —— 第一站:错误监控。
> 项目背景:React 18 + Vite + TypeScript SPA,已部署在 Cloudflare R2 + Worker。

## 为什么需要 Sentry?

### 没有 Sentry 时,前端错误怎么发现?

```
用户访问页面 ──> 白屏 / 报错 ──> 用户抱怨 / 静默离开
                                        │
                                        ▼
                                你完全不知道出错了
```

**痛点**:
- 用户的浏览器环境千差万别(Mac/Windows/iOS/Android + 各种浏览器版本),你本地复现不了
- 用户不会主动反馈,大部分直接离开
- 即使反馈了,你拿到的是"页面打不开"这种模糊描述,没法定位
- 浏览器 console 用户看不到,你也看不到

### 有 Sentry 后

```
用户访问页面 ──> JS 报错 ──> Sentry SDK 自动捕获
                                │
                                ▼
                        上报到 Sentry 服务器
                                │
                                ▼
                    Sentry 聚合错误,发邮件/Slack 通知你
                                │
                                ▼
                你在 Sentry 后台看到:
                - 错误堆栈(带 source map 还原成源码位置)
                - 用户环境(浏览器/OS/URL)
                - 用户行为轨迹(点击/请求 breadcrumb)
                - 影响用户数
                - 首次出现时间 / 最近出现时间
                - Release 版本(对应哪次发版)
```

## Sentry 是什么?

**Sentry = 错误监控 + 性能监控 + Release 追踪的 SaaS 平台**,支持 30+ 语言/平台。前端项目主要用它:

| 功能 | 说明 |
|------|------|
| 错误捕获 | JS 异常、未捕获 Promise、console.error |
| 性能监控 | 页面加载、API 请求耗时、Web Vitals |
| Source Map 还原 | 错误堆栈从压缩代码定位到源码 |
| Release 追踪 | 错误关联到具体发版,知道是哪次上线引入的 |
| 用户轨迹 | 用户点击、导航、请求等行为链路 |
| 告警规则 | 错误率突增 / 首次出现错误时邮件/Slack 通知 |

## 整体架构

```
浏览器(用户)
  │
  │  JS 报错
  ▼
Sentry SDK(@sentry/react)
  │
  │  POST 错误事件(含堆栈、环境、轨迹)
  ▼
Sentry 服务器(sentry.io)
  │
  │  关联 Release + Source Map 还原源码位置
  ▼
Sentry 后台(你看的界面)
  │
  │  告警通知
  ▼
你的邮箱 / Slack / 钉钉
```

**Source Map 上传路径**(独立于运行时,CI 时上传):

```
本地 / CI 构建
  │
  │  npm run build → 产出 dist/ + dist/assets/*.js.map
  ▼
sentry-cli / @sentry/vite-plugin
  │
  │  上传 source map 到 Sentry 服务器,关联 Release
  ▼
Sentry 服务器(按 Release 存 source map)
  │
  │  错误事件到达时,用 Release 找对应 source map 还原
  ▼
后台显示源码位置(不是压缩后的乱码)
```

## 选型:SaaS vs 自建

| 方式 | 优劣 | 适用 |
|------|------|------|
| **SaaS(sentry.io)** | 0 运维,免费额度够个人/小团队 | 学习项目、个人项目、中小团队 |
| **自建(self-hosted)** | 数据完全自己掌控,但要服务器 + 运维 | 大企业、敏感数据 |

**本项目用 SaaS**(sentry.io),免费额度:
- 5,000 errors/月
- 10,000 performance events/月
- 1 个项目
- 无限用户

学习项目完全够用。

## 前置准备

1. 注册 Sentry 账号:https://sentry.io/signup/(GitHub 登录最快)
2. 项目语言选 **JavaScript**,平台选 **React**
3. 拿到三个关键信息(后面要用):
   - **DSN**:形如 `https://xxxx@o12345.ingest.sentry.io/456`
   - **Organization Slug**:形如 `my-org`(创建组织时设的)
   - **Project Slug**:形如 `fe-depoly`(创建项目时设的)
4. 生成 Auth Token(给 CI 上传 source map 用):
   - Sentry 后台 → Settings → Auth Tokens → Create New Token
   - Scopes 勾选 `project:releases`、`project:write`
   - 复制 token(只显示一次)

## 步骤一:安装 Sentry SDK

```bash
# 运行时 SDK
npm i @sentry/react

# Vite 插件(构建时上传 source map)
npm i -D @sentry/vite-plugin
```

**关于 `@sentry/vite-plugin`**:它的作用是在 `vite build` 时,自动把 source map 上传到 Sentry,关联到 Release,然后**删除本地 source map**(避免泄露源码到生产环境)。

## 步骤二:配置 Vite 插件

修改 `vite.config.ts`:

```ts
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      // Sentry 插件:只在生产构建时启用
      process.env.SENTRY_AUTH_TOKEN &&
        sentryVitePlugin({
          org: env.SENTRY_ORG,
          project: env.SENTRY_ORG_PROJECT,
          authToken: process.env.SENTRY_AUTH_TOKEN,
          // Release 名,用 git commit SHA 最准确
          release: { name: process.env.VITE_APP_VERSION },
          // 自动给 release 注入 source map
          sourcemaps: {
            filesToDeleteAfterUpload: ['dist/**/*.map'],
          },
          // 关闭遥测,避免本地构建上报
          telemetry: false,
        }),
    ].filter(Boolean),
    build: {
      // 必须开 source map,否则 Sentry 还原不了源码
      sourcemap: true,
    },
  };
});
```

**关键点**:
- `sourcemap: true` 是必须的,否则 Sentry 拿不到源码映射,错误堆栈显示压缩后的乱码
- 用 `process.env.SENTRY_AUTH_TOKEN` 判断,本地开发时不启用插件(避免本地构建乱上传)
- `release.name` 用版本号,后续 CI 会注入 `VITE_APP_VERSION`

## 步骤三:初始化 Sentry SDK

新建 `src/sentry.ts`:

```ts
import * as Sentry from '@sentry/react';
import { BrowserTracing } from '@sentry/tracing';

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
const APP_ENV = import.meta.env.VITE_APP_ENV || 'development';
const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev';

export function initSentry() {
  // 没有 DSN 不初始化(本地开发可不开)
  if (!SENTRY_DSN) {
    console.warn('[Sentry] VITE_SENTRY_DSN not set, skipping initialization');
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    release: APP_VERSION,
    environment: APP_ENV,
    integrations: [
      new BrowserTracing({
        routingInstrumentation: Sentry.reactRouterV5Instrumentation,
      }),
    ],
    // 性能监控采样率(0-1),生产建议 0.1-0.3,避免额度用完
    tracesSampleRate: APP_ENV === 'production' ? 0.1 : 1.0,
    // 错误总是 100% 上报
    sampleRate: 1.0,
    // 发送前过滤,可以脱敏或丢弃某些错误
    beforeSend(event) {
      // 过滤掉某些不想上报的错误
      if (event.request?.url?.includes('localhost')) {
        return null;
      }
      return event;
    },
  });
}

// 暴露手动上报方法(给业务代码用)
export const captureException = Sentry.captureException;
export const captureMessage = Sentry.captureMessage;
```

在 `src/main.tsx` 里调用:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { initSentry } from './sentry';

// 初始化 Sentry(必须在 React 渲染前)
initSentry();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

## 步骤四:配置环境变量

不同环境的 DSN 可以相同(用 `environment` 字段区分),但建议生产用独立项目。

新建 `.env.development`、`.env.staging`、`.env.production`:

```bash
# .env.development(本地开发不开 Sentry,DSN 留空)
VITE_APP_ENV=development
VITE_APP_VERSION=dev
VITE_SENTRY_DSN=

# .env.staging
VITE_APP_ENV=staging
VITE_SENTRY_DSN=https://xxxx@o12345.ingest.sentry.io/456

# .env.production
VITE_APP_ENV=production
VITE_SENTRY_DSN=https://xxxx@o12345.ingest.sentry.io/456
```

**DSN 是公开的**(嵌在客户端代码里),不是敏感信息。但**Auth Token 是机密**,只能放 CI Secrets。

## 步骤五:用 Sentry 的 ErrorBoundary

`@sentry/react` 提供了 React ErrorBoundary 组件,捕获子树渲染错误。

修改 `src/App.tsx`:

```tsx
import * as Sentry from '@sentry/react';
import { useState } from 'react';

function App() {
  const [count, setCount] = useState(0);

  return (
    <Sentry.ErrorBoundary
      fallback={<div style={{ padding: 20 }}>页面出错了,请刷新重试</div>}
      onError={(error, componentStack) => {
        console.error('Caught by ErrorBoundary:', error, componentStack);
      }}
    >
      <header className="app-header">
        <h1>FE Deploy</h1>
        <p>前端工程化实践项目 · 部署 / CI-CD / CDN / 缓存</p>
      </header>
      <main className="app-main">
        <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
        <button onClick={() => {
          // 故意抛错,测试 Sentry 捕获
          throw new Error('Test error for Sentry');
        }}>
          Trigger Error
        </button>
      </main>
    </Sentry.ErrorBoundary>
  );
}

export default App;
```

## 步骤六:CI/CD 集成(关键)

CI 时要注入版本号和 Auth Token,让 vite 插件能上传 source map。

### 6.1 修改 deploy-r2-worker.yml

```yaml
name: Deploy to R2 + Worker

on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'public/**'
      - 'worker/**'
      - 'scripts/**'
      - 'index.html'
      - 'vite.config.ts'
      - 'vite.config.*.ts'
      - 'tsconfig.json'
      - 'tsconfig.*.json'
      - 'package.json'
      - 'package-lock.json'
      - '.github/workflows/deploy-r2-worker.yml'
  workflow_dispatch:

env:
  AWS_REGION: auto
  AWS_ENDPOINT_URL: ${{ secrets.R2_ENDPOINT }}
  AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - run: npm ci
      - run: npm run lint
      - run: npm run type-check
      - run: npm run test

      - name: Build with Sentry source map upload
        run: npm run build
        env:
          # 注入 Sentry 配置
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
          SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
          SENTRY_PROJECT: ${{ secrets.SENTRY_PROJECT }}
          VITE_APP_ENV: production
          VITE_APP_VERSION: ${{ github.sha }}
          VITE_SENTRY_DSN: ${{ secrets.VITE_SENTRY_DSN }}

      # 同步 dist/ 到 R2(注意:此时 source map 已被 vite 插件删除,不会上传到 R2)
      - name: Sync to R2
        run: |
          aws s3 sync dist/ s3://fe-depoly-assets/ \
            --delete \
            --cache-control "public, max-age=31536000, immutable" \
            --exclude "index.html" \
            --endpoint-url "$AWS_ENDPOINT_URL"
          aws s3 cp dist/index.html s3://fe-depoly-assets/index.html \
            --cache-control "public, max-age=0, must-revalidate" \
            --content-type "text/html; charset=utf-8" \
            --endpoint-url "$AWS_ENDPOINT_URL"

      # 部署 Worker
      - name: Deploy Worker
        working-directory: worker
        run: |
          npm ci
          npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

**关键改动**:
1. `Build` 步骤注入 5 个 Sentry 相关环境变量
2. `VITE_APP_VERSION: ${{ github.sha }}` 用 commit SHA 作版本号,精确到每次推送
3. Source map 上传后,`vite-plugin` 自动删除本地 .map 文件,所以同步到 R2 的就是干净的生产产物

### 6.2 GitHub Secrets 配置

仓库 Settings → Secrets and variables → Actions,加:

| Secret | 值 | 来源 |
|--------|---|------|
| `SENTRY_AUTH_TOKEN` | Auth Token | Sentry → Settings → Auth Tokens → Create New Token,scope 选 `project:releases` + `project:write` |
| `SENTRY_ORG` | 组织 slug | Sentry → Settings → Organizations,看 URL `sentry.io/orgs/<org-slug>/` |
| `SENTRY_PROJECT` | 项目 slug | Sentry → 项目页,看 URL `sentry.io/organizations/<org>/projects/<project>/` |
| `VITE_SENTRY_DSN` | DSN | Sentry → 项目设置 → Client Keys(DSN),形如 `https://xxxx@o12345.ingest.sentry.io/456` |

## 步骤七:创建 Release 标记(可选但推荐)

Sentry 的 Release 概念:**把每次发版标记成一个 Release,错误关联到 Release,知道哪次上线引入的**。

`@sentry/vite-plugin` 配置里 `release.name` 已经设了版本号,CI 用 `github.sha` 注入。Sentry 后台 Releases 页面就能看到:

```
Release: abc1234(git commit SHA)
  ├─ 首次部署: 2026-06-25 12:00
  ├─ 新增错误: 3 个
  ├─ 解决错误: 5 个
  └─ 影响用户: 12
```

**Source map 是按 Release 关联的**,所以 Release 名必须和 SDK 里的 `release` 字段一致。本项目两边都用 `VITE_APP_VERSION`,自动对齐。

## 步骤八:本地测试

### 8.1 测试构建

```bash
# 临时设置环境变量(本地测试)
export SENTRY_AUTH_TOKEN="你的 token"
export SENTRY_ORG="你的 org"
export SENTRY_PROJECT="你的 project"

# 构建(会触发 source map 上传)
VITE_APP_ENV=staging \
VITE_APP_VERSION=$(git rev-parse --short HEAD) \
VITE_SENTRY_DSN="你的 DSN" \
npm run build
```

构建输出应该看到:

```
> Build complete
> Sentry release created: abc1234
> Source maps uploaded: 5 files
```

去 Sentry 后台 → Releases,应看到新 Release 出现,点进去能看到上传的 source map 文件列表。

### 8.2 本地预览测试错误捕获

```bash
# 启动 preview(用 production 配置但本地跑)
VITE_APP_ENV=staging \
VITE_APP_VERSION=$(git rev-parse --short HEAD) \
VITE_SENTRY_DSN="你的 DSN" \
npm run preview
```

访问 `http://localhost:4173`,点 "Trigger Error" 按钮,触发 `throw new Error('Test error for Sentry')`。

等几秒,Sentry 后台 → Issues,应看到这个错误:

```
Error: Test error for Sentry
  at handleTriggerError (src/App.tsx:15:8)  ← source map 还原后显示源码位置
  at onClick (src/App.tsx:13:5)
  ...
```

如果看到的是 `App.tsx:1:12345` 这种乱位置,说明 source map 没上传成功。

## 步骤九:验证生产部署

推到 main 触发 CI,部署完成后:

1. **访问生产域名**,点 Trigger Error 按钮
2. **Sentry 后台 → Issues**,几秒内应看到错误
3. **检查错误详情**:
   - Environment: `production`
   - Release: 你的 commit SHA
   - 堆栈定位到源码行(不是压缩后的乱码)
   - 用户信息:IP、浏览器、OS、URL
   - Breadcrumbs:页面加载、点击事件轨迹

## 步骤十:告警配置

默认 Sentry 会发邮件,但建议配 Slack / 钉钉 / 企业微信通知。

### 10.1 邮件告警(默认就有)

Sentry → Project Settings → Alerts → 默认规则:
- Issue first seen(首次出现)→ 邮件
- Issue regression(已解决又复现)→ 邮件

### 10.2 Slack 通知

1. Sentry → Settings → Integrations → Slack → Enable
2. 选择 workspace,授权
3. Project Settings → Alerts → Create Alert Rule
4. Rule:`If an issue is first seen`,then `Send Slack message to #frontend-alerts`

### 10.3 自定义告警规则

常见规则:

| 规则 | 触发条件 | 动作 |
|------|--------|------|
| 首次出现 | Issue first seen | 邮件 + Slack |
| 错误率突增 | 错误率 > 5%(过去 1 小时) | 邮件 + Slack |
| 影响用户多 | 单 issue 影响 > 100 用户 | 邮件 + Slack |
| 高优先级 issue | Level = Fatal | 短信 / 电话(付费) |

## 步骤十一:性能监控(可选)

`@sentry/react` 自带性能监控,刚才初始化时已经配了 `tracesSampleRate`。性能数据在 Sentry 后台 → Performance:

| 指标 | 说明 |
|------|------|
| Page Load | 页面完整加载时间 |
| First Contentful Paint | 首次内容绘制 |
| Largest Contentful Paint | 最大内容绘制(核心 Web Vital) |
| INP | 交互响应延迟 |
| CLS | 累积布局偏移 |
| API Request | 每个 fetch 请求耗时 |

**采样率建议**:
- 开发环境:1.0(100% 采集,样本少,全采)
- 预发:0.5
- 生产:0.1(10% 采样,流量大时避免额度用完)

## 步骤十二:用户反馈(可选)

Sentry 提供用户反馈 widget,可以加到页面让用户主动报错:

```tsx
import * as Sentry from '@sentry/react';

function App() {
  return (
    <>
      <Sentry.FeedbackWidget
        buttonLabel="反馈问题"
        formTitle="遇到问题了?"
        submitButtonLabel="提交反馈"
        messagePlaceholder="描述你遇到的问题..."
      />
      {/* ... */}
    </>
  );
}
```

用户点按钮,弹表单填反馈,带截图自动上报到 Sentry,关联到当前用户最近的事件。

## 验收清单

部署完成后,逐项验证:

- [ ] 本地 `npm run build` 能上传 source map(看 Sentry Releases 有新版本)
- [ ] 本地 preview 点 Trigger Error,Sentry Issues 能看到错误
- [ ] 错误堆栈显示源码位置(不是压缩乱码)
- [ ] CI 自动构建时上传 source map 成功
- [ ] 生产环境点 Trigger Error,Sentry 收到错误,Environment=production
- [ ] Release 字段对应 commit SHA
- [ ] Issue 详情能看到用户环境(浏览器/OS/URL)
- [ ] Issue 详情能看到 Breadcrumbs(用户行为轨迹)
- [ ] 邮件告警收到(首次出现错误时)
- [ ] Performance 页面能看到页面加载耗时数据
- [ ] 本地 dist/ 不含 .map 文件(避免泄露源码)

## 常见坑

### 1. Source map 没上传,堆栈是乱码

**症状**:Sentry 显示的错误堆栈是 `App.a8f3b.js:1:12345`,不是源码位置。

**原因**:
- CI 没设 `SENTRY_AUTH_TOKEN`,vite 插件没启用
- `vite.config.ts` 里 `release.name` 没设
- SDK 里 `release` 字段和 vite 插件 `release.name` 不一致(必须完全相同)

**排查**:CI Build 步骤输出,应该有 "Source maps uploaded" 字样。

### 2. 本地构建乱上传 source map 到测试环境

**症状**:本地 `npm run build` 也在上传,污染 Sentry Releases。

**解决**:`vite.config.ts` 里加 `process.env.SENTRY_AUTH_TOKEN &&` 判断,本地不设这个环境变量,插件就不启用。

### 3. dist/ 里有 .map 文件被传到 R2

**症状**:R2 Bucket 里能看到 `.js.map` 文件,源码泄露。

**原因**:`@sentry/vite-plugin` 默认会上传后删除,但配置不对会保留。

**解决**:配置里加 `sourcemaps.filesToDeleteAfterUpload: ['dist/**/*.map']`。

### 4. 错误率突增,额度用完

**症状**:Sentry 免费额度 5000 errors/月,几天就用完,后续错误不上报。

**原因**:某个高频错误(如某个 API 一直失败)刷爆额度。

**解决**:
- `beforeSend` 过滤掉已知的高频噪音错误
- 给已知问题标 `resolved`,Sentry 不会重复上报
- 升级付费版($26/月起,50K errors)

### 5. iframe 里的错误不上报

**症状**:项目用 iframe 嵌入其他页面,iframe 里的错误没上报。

**原因**:Sentry SDK 默认只监听当前 window。

**解决**:iframe 里单独初始化 Sentry,或用 `Sentry.addGlobalEventProcessor` 处理跨 frame 事件。

### 6. CORS 问题导致上报失败

**症状**:浏览器 console 看到 `POST https://sentry.io/api/... 403`,Sentry 收不到错误。

**原因**:某些 CSP(内容安全策略)禁止向 sentry.io 发请求。

**解决**:在 `index.html` 的 CSP meta 里加 `connect-src https://*.sentry.io`:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; connect-src 'self' https://*.sentry.io; ...">
```

### 7. CI 构建失败:Auth Token 权限不够

**症状**:CI 报 `401 Unauthorized` 或 `403 Forbidden`。

**原因**:Auth Token 缺少 `project:releases` scope。

**解决**:Sentry → Settings → Auth Tokens → 编辑 token,勾上 `project:releases` + `project:write`。

### 8. 性能数据采样率太高,额度用完

**症状**:Performance 页面几天没新数据,免费额度 10K/月用完。

**解决**:`tracesSampleRate` 生产环境设 0.1 或更低,只采 10% 用户。

### 9. Release 没有关联 commit

**症状**:Sentry Releases 页面,release 没显示 commit 信息。

**解决**:
- Sentry → Settings → Integrations → GitHub → 安装集成
- 授权后,release 自动关联 commit SHA
- 可以看到 "这个 release 包含哪些 commit"

### 10. 用户身份信息缺失

**症状**:Sentry 事件里 user 是 anonymous,没有用户 ID。

**解决**:登录后调用 `Sentry.setUser`:

```ts
import * as Sentry from '@sentry/react';

// 用户登录后
Sentry.setUser({
  id: user.id,
  username: user.name,
  email: user.email,
});
```

之后所有事件都会带上这个用户信息,可以按用户搜索错误。

## 成本估算

| 项 | 免费额度 | 预估用量 | 是否收费 |
|----|---------|---------|---------|
| Errors | 5,000/月 | 学习项目 < 100 | 免费 |
| Performance Events | 10,000/月 | 视采样率,< 1000 | 免费 |
| Releases | 无限 | < 50/月 | 免费 |
| 用户数 | 无限 | 1 | 免费 |
| Attachment 大小 | 8MB/事件 | - | 免费 |

**结论:0 元**。流量稍大需要付费版时,Developer 套餐 $26/月,50K errors + 50K performance,够小团队用。

## 后续扩展

Sentry 跑通后,可以继续做:

| 扩展项 | 价值 |
|--------|------|
| **Session Replay** | 录屏回放用户出错时的操作过程,定位 bug 神器(付费功能) |
| **Cron Monitoring** | 监控定时任务是否按时执行,没执行就告警 |
| **Profiling** | 函数级性能 profiling,定位 JS 执行慢的根因 |
| **Mobile SDK** | 同一套 Sentry 后台监控 React Native / Flutter 移动端 |
| **Backend SDK** | 后端服务(Node/Python/Go)也接 Sentry,前后端错误关联 |

## 小结

Sentry 接入核心步骤:

1. **注册 Sentry 账号 + 创建 React 项目**,拿 DSN / Org / Project / Auth Token
2. **安装 `@sentry/react` + `@sentry/vite-plugin`**
3. **改 `vite.config.ts`**:启用插件,配 Release,开 sourcemap
4. **写 `src/sentry.ts`**:初始化 SDK,设 DSN / Release / 采样率
5. **`src/main.tsx` 调用 `initSentry()`**,在 React 渲染前
6. **`App.tsx` 用 `Sentry.ErrorBoundary` 包裹**,捕获渲染错误
7. **配 `.env.production`**:注入 DSN 和版本号
8. **改 CI workflow**:注入 4 个 Sentry 环境变量,构建时自动上传 source map
9. **本地测试**:点 Trigger Error 按钮,看 Sentry 收到错误且源码定位准确
10. **配置告警**:邮件 / Slack / 钉钉

接入 Sentry 后,前端错误从"用户抱怨才知道"变成"几秒内自动告警 + 源码定位",这是生产环境必备的监控能力。

下一步可以继续阶段五其他项:**Web Vitals 上报**、**产物体积分析**、**代码分割**、**图片资源优化**。
