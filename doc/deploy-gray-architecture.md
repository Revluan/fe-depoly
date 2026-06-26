# 前端部署与灰度发布架构

> 本文档总结 `fe-depoly` 项目当前的 CI/CD、部署、灰度管理三层架构,作为系统总览。细节实现散落在 `cicd.md` / `deploy.md` / `hybrid-depoly.md` / `gary-by-userId.md` / `admin-ui-plan.md` 等文档,本文把它们串成一张图。

## 1. 总体架构

```
┌────────────────────────────────────────────────────────────────────────────┐
│                            GitHub (源码仓库)                                │
│                                                                            │
│   push to main  ──►  .github/workflows/deploy-r2-worker.yml                │
│                       (path filter: src/ worker/ vite.config 等)            │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                          GitHub Actions Runner                             │
│                                                                            │
│  1. checkout                                                               │
│  2. compute BUILD_ID = build-{run_id}-{sha:7}                              │
│  3. npm ci                                                                 │
│  4. npm run lint / type-check / build                                      │
│       └─ Vite build  →  dist/                                              │
│           ├─ 注入 VITE_APP_VERSION = BUILD_ID                              │
│           ├─ 生成 source map                                               │
│           └─ Sentry vite-plugin 上传 sourcemap,关联 Release = BUILD_ID     │
│              上传后删除 dist/**/*.map(避免源码泄露到 R2)                    │
│  5. aws s3 sync dist/ → R2 根目录(全量版本,短/长缓存分离)                  │
│  6. aws s3 sync dist/ → R2 artifacts/{BUILD_ID}/ (多版本共存)              │
│  7. wrangler deploy worker/  (注入 CURRENT_VERSION / DEPLOY_TIME var)      │
│  8. wrangler kv key put current-artifact = BUILD_ID  (KV 指针更新)         │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  │
            ┌─────────────────────┼──────────────────────┐
            ▼                     ▼                      ▼
   ┌─────────────────┐   ┌─────────────────┐    ┌─────────────────┐
   │   R2 Bucket     │   │   Worker        │    │   KV Namespace  │
   │ fe-depoly-assets│   │ fe-depoly-edge  │    │   GRAY_RULES    │
   │                 │   │                 │    │                 │
   │ /index.html     │◄──┤   fetch handler │────┤ current-artifact│
   │ /assets/*.js    │   │   ├─ static     │    │ active-releases │
   │ /assets/*.css   │   │   ├─ /api/*     │    │   (GrayRelease[])│
   │ /artifacts/     │   │   └─ /api/admin │    │                 │
   │   {buildId}/    │   │                 │    │                 │
   │     index.html  │   │   env:          │    │                 │
   │     assets/*    │   │   ASSETS_BUCKET │    │                 │
   │                 │   │   GRAY_RULES    │    │                 │
   │                 │   │   API_ORIGIN?   │    │                 │
   │                 │   │   CURRENT_VER   │    │                 │
   └─────────────────┘   └────────┬────────┘    └─────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                              浏览器(SPA)                                   │
│                                                                            │
│   首次请求 GET /                                                            │
│     └─ Worker 选 artifactId(灰度命中 → release.artifactId,否则 KV 指针)    │
│     └─ 从 R2 取 artifacts/{artifactId}/index.html                          │
│     └─ 注入 window.__APP_CONFIG__ = {version, artifactId, canary, ...}     │
│     └─ 返回 HTML(Cache-Control: no-cache)                                  │
│                                                                            │
│   后续请求 GET /assets/*.js                                                 │
│     └─ Worker 同样按 artifactId 路由到 artifacts/{artifactId}/assets/...    │
│     └─ 命中边缘缓存(caches.default),长缓存 immutable                       │
│                                                                            │
│   运行时                                                                    │
│     ├─ Sentry SDK 读 __APP_CONFIG__.version 作为 Release                    │
│     ├─ 「灰度管理」按钮 → /api/admin/* CRUD                                 │
│     └─ 「Call BFF」按钮 → /api/version (Worker 内置或反代 API_ORIGIN)       │
└────────────────────────────────────────────────────────────────────────────┘
```

## 2. 三层职责划分

| 层 | 组件 | 职责 |
|---|---|---|
| **CI/CD** | GitHub Actions | 构建、校验、上传产物、部署 Worker、更新 KV 指针 |
| **部署** | Cloudflare R2 + Worker + KV | 静态资源托管、边缘路由、版本选择、BFF |
| **灰度管理** | Admin UI + Worker Admin API | 规则 CRUD、按规则选 artifactId |

## 3. CI/CD 流水线

### 3.1 触发条件

```yaml
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
```

只改 `doc/` 或 `README.md` 不会触发部署 —— 文档变更不该让生产环境重跑一遍。

### 3.2 构建产物标识:BUILD_ID

```
BUILD_ID = build-{github.run_id}-{github.sha前7位}
```

例如 `build-12345678901-a1b2c3d`。这个 ID 同时用作:

- `VITE_APP_VERSION`:注入到客户端代码,Sentry SDK 读它作 Release
- Sentry Release 名:上传 source map 时关联
- Worker `CURRENT_VERSION` var:`/api/version` 返回
- R2 `artifacts/{BUILD_ID}/` 目录名
- KV `current-artifact` 值:全量版本指针
- Admin UI 「产物版本」下拉选项(由 `/api/admin/artifacts` 扫 R2 列出)

一个 ID 贯穿构建-上传-部署-灰度-监控五条链路,排查问题时拿着这个 ID 就能定位到具体 commit、具体产物目录、具体 Sentry Release。

### 3.3 步骤详解

| 步骤 | 命令 | 说明 |
|---|---|---|
| 1 | `actions/checkout@v4` | 拉代码 |
| 2 | `actions/setup-node@v4` | Node 22,启用 npm cache |
| 3 | 计算 `BUILD_ID` | 输出到 `GITHUB_OUTPUT`,后续步骤引用 |
| 4 | `npm ci` | 严格按 lockfile 安装 |
| 5 | `npm run lint` | ESLint |
| 6 | `npm run type-check` | `tsc --noEmit` |
| 7 | `npm run build` | `tsc -b && vite build`,注入 env、上传 sourcemap |
| 8 | `aws s3 sync dist/ s3://.../` | 全量版本写到根目录(过渡期安全网) |
| 9 | `aws s3 sync dist/ s3://.../artifacts/{BUILD_ID}/` | 版本化产物,所有历史都保留 |
| 10 | `wrangler deploy` | 部署 Worker,注入 `CURRENT_VERSION` / `DEPLOY_TIME` var |
| 11 | `wrangler kv key put current-artifact {BUILD_ID}` | 更新 KV 全量指针 |

### 3.4 关键设计决策

**不用 `--delete` 同步 R2**

```bash
aws s3 sync dist/ s3://fe-depoly-assets/ \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "index.html" \
  --endpoint-url "$AWS_ENDPOINT_URL"
```

旧构建的 `assets/index-abc123.js` 必须保留,因为旧版本用户浏览器缓存的 HTML 还引用着这个 hash 文件。如果 `--delete`,旧用户白屏。灰度上线后,新旧产物要共存,更不能删。

**index.html 单独上传,短缓存**

```bash
aws s3 cp dist/index.html s3://fe-depoly-assets/index.html \
  --cache-control "public, max-age=0, must-revalidate"
```

HTML 是入口,必须每次都回源。Worker 拿到 HTML 后会动态注入 `__APP_CONFIG__`,所以 HTML 永远不能被边缘缓存(只缓存静态资源)。

**Sentry source map 上传后删除本地 .map**

```ts
sourcemaps: {
  filesToDeleteAfterUpload: ['dist/**/*.map'],
}
```

避免 `.map` 文件被同步到 R2,泄露源码。

**KV 写入要 `--preview false`**

```bash
npx wrangler kv key put current-artifact "${BUILD_ID}" \
  --binding GRAY_RULES \
  --preview false \
  --remote
```

`wrangler.toml` 里同时配了 `id` 和 `preview_id`(学习项目复用同一 namespace),wrangler 要求显式指定写哪个,否则报错。

## 4. 部署架构

### 4.1 Cloudflare 三件套

```
┌────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Edge                               │
│                                                                    │
│   ┌──────────────────────────────────────────────────────────┐    │
│   │  Worker: fe-depoly-edge                                   │    │
│   │                                                            │    │
│   │  export default {                                          │    │
│   │    async fetch(request, env, ctx) {                        │    │
│   │      if (pathname.startsWith('/api/'))                     │    │
│   │        return handleApi(request, env)                     │    │
│   │      return handleStatic(request, env, ctx)               │    │
│   │    }                                                       │    │
│   │  }                                                         │    │
│   │                                                            │    │
│   │  绑定:                                                      │    │
│   │  ├─ ASSETS_BUCKET  → R2 Bucket (静态资源)                  │    │
│   │  ├─ GRAY_RULES     → KV Namespace (灰度规则 + 指针)         │    │
│   │  └─ vars: CURRENT_VERSION, DEPLOY_TIME, ENVIRONMENT        │    │
│   └──────────────────────────────────────────────────────────┘    │
│                          │       │                                  │
│                          ▼       ▼                                  │
│   ┌────────────────────────┐  ┌────────────────────────┐           │
│   │  R2: fe-depoly-assets  │  │  KV: GRAY_RULES         │           │
│   │  ┌──────────────────┐  │  │  ┌──────────────────┐  │           │
│   │  │ /index.html      │  │  │  │ current-artifact │  │           │
│   │  │ /assets/*.js     │  │  │  │   = build-123-a1b │  │           │
│   │  │ /artifacts/      │  │  │  │ active-releases  │  │           │
│   │  │   build-123-a1b/ │  │  │  │   = [{...}, ...] │  │           │
│   │  │     index.html   │  │  │  └──────────────────┘  │           │
│   │  │     assets/*     │  │  └────────────────────────┘           │
│   │  │   build-124-c2d/ │  │                                        │
│   │  │   build-125-e3f/ │  │                                        │
│   │  └──────────────────┘  │                                        │
│   └────────────────────────┘                                        │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 请求处理流程

**静态资源请求 `GET /` 或 `GET /assets/xxx.js`**

```
                  ┌──────────────────┐
                  │  Request 进 Edge │
                  └────────┬─────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │ 是 /api/* ?             │───► handleApi
              └────────┬───────────────┘
                       │ 否
                       ▼
              ┌────────────────────────┐
              │ 是 GET 且非 HTML?       │
              │ 查 caches.default      │
              └────────┬───────────────┘
                       │
              ┌────────┴────────┐
              │                 │
           命中缓存          未命中
              │                 │
              ▼                 ▼
         返回缓存      ┌────────────────────────┐
                       │ getUserIdFromRequest    │
                       │ (Cookie user_id 或匿名) │
                       └────────┬───────────────┘
                                │
                                ▼
                       ┌────────────────────────┐
                       │ matchGrayRelease        │
                       │ 读 KV active-releases   │
                       │ 按 userId/header/percent│
                       │ 匹配                    │
                       └────────┬───────────────┘
                                │
                       ┌────────┴────────┐
                       │                 │
                    命中灰度          未命中
                       │                 │
                       ▼                 ▼
            artifactId =         artifactId = KV.get(
              release.artifactId   'current-artifact')
                       │                 │
                       └────────┬────────┘
                                │
                                ▼
                       ┌────────────────────────┐
                       │ R2.get(                │
                       │  artifacts/{id}{path}) │
                       │  fallback R2.get(path) │
                       └────────┬───────────────┘
                                │
                       ┌────────┴────────┐
                       │                 │
                    命中              未命中 + 非静态ext
                       │                 │
                       │                 ▼
                       │       SPA fallback:
                       │       R2.get(artifacts/{id}/index.html)
                       │       fallback R2.get('index.html')
                       │                 │
                       └────────┬────────┘
                                │
                                ▼
                       ┌────────────────────────┐
                       │ 是 HTML?               │
                       │ 注入 window.__APP_CONFIG__
                       │ - env, version         │
                       │ - artifactId           │
                       │ - releaseId, canary    │
                       │ - deployTime           │
                       └────────┬───────────────┘
                                │
                                ▼
                       ┌────────────────────────┐
                       │ buildHeaders           │
                       │ - Content-Type         │
                       │ - Cache-Control        │
                       │   (HTML: short         │
                       │    静态: long immutable)│
                       │ - ETag                 │
                       │ - 安全头               │
                       └────────┬───────────────┘
                                │
                                ▼
                       ┌────────────────────────┐
                       │ ctx.waitUntil(         │
                       │  cache.put(...))       │
                       │ (仅 GET 且非 HTML)      │
                       └────────┬───────────────┘
                                │
                                ▼
                            Response
```

### 4.3 缓存策略

| 资源类型 | Cache-Control | 边缘缓存 | 原因 |
|---|---|---|---|
| `index.html` | `public, max-age=0, must-revalidate` | **不缓存** | Worker 要动态注入 `__APP_CONFIG__`,缓存会让灰度失效 |
| `.js` / `.css` / 字体 / 图片 | `public, max-age=31536000, immutable` | 缓存 | 文件名带 hash,内容变文件名就变,可以永久缓存 |
| 其他 | `public, max-age=0, must-revalidate` | 不缓存 | 兜底 |

边缘缓存命中时直接返回,跳过 R2 读和 KV 读,延迟最低。HTML 永远回源,保证灰度规则实时生效。

### 4.4 BFF(Backend for Frontend)

Worker 内置了 `/api/*` 路由:

| 路径 | 行为 |
|---|---|
| `GET /api/health` | 返回 `{status, env, ts}` |
| `GET /api/version` | 返回当前全量版本信息(version / artifactId / deployTime / canaryPercent) |
| `GET/POST/PATCH/DELETE /api/admin/*` | 灰度规则 CRUD(见下节) |
| 其他 `/api/*` | 反代到 `env.API_ORIGIN`(若配置) |

前端不直接调后端,所有 API 都走 Worker 同源。好处:跨域问题消失、能在边缘做鉴权/限流/协议转换、灰度规则也能影响 API 路由(未来扩展)。

## 5. 灰度管理

### 5.1 数据模型

```ts
// KV key: active-releases
// value: GrayRelease[]
interface GrayRelease {
  id: string          // exp-{Date.now()}-{random4},例如 exp-1719400000000-a1b2
  name: string        // 人类可读名,如 "首页改版灰度"
  artifactId: string  // 指向 R2 artifacts/{artifactId}/
  status: 'draft' | 'running' | 'paused' | 'finished' | 'rolled-back'
  rules: GrayRule[]   // OR 关系,命中任一即生效
}

interface GrayRule {
  type: 'userIdList' | 'percent' | 'header'
  // userIdList 用
  values?: string[]
  // percent 用
  value?: number  // 0-100
  // header 用
  headerKey?: string
  headerValues?: string[]
}

// KV key: current-artifact
// value: string,如 "build-12345678901-a1b2c3d"
// 全量版本指针,CI 每次部署都更新
```

### 5.2 规则匹配优先级

```
读 KV active-releases
    │
    ▼
按数组顺序遍历每个 release
    │
    ├─ status !== 'running' → 跳过
    │
    └─ status === 'running' → 遍历 rules
            │
            ├─ userIdList:用户 id 在 values 数组里 → 命中,返回此 release
            ├─ header:请求头包含指定值 → 命中,返回此 release
            └─ percent:hash(userId) % 100 < value → 命中,返回此 release
    │
    ▼
遍历完没命中 → 返回 null,Worker 用 current-artifact 全量版本
```

- **多灰度并存**:数组里多条 `running` 灰度,按顺序匹配,先命中先返回
- **同 release 多规则**:OR 关系,任一规则命中即生效
- **稳定分桶**:`hash(userId) % 100` 用确定性哈希,同一用户始终落到同一桶,不会刷新一下就跳到灰度组

### 5.3 Admin UI 与 Admin API

```
┌────────────────────────────────────────────────────────────────────┐
│                          浏览器(SPA)                               │
│                                                                    │
│   App.tsx                                                          │
│   ├─ view === 'app'    → 主页(count、Trigger Error、Call BFF)      │
│   └─ view === 'admin'  → AdminPage                                  │
│                                                                    │
│   AdminPage.tsx                                                     │
│   ├─ useEffect: listReleases() + listArtifacts()                    │
│   ├─ 表格:ID / 名称 / 产物 / 状态(badge) / 规则摘要 / 编辑           │
│   ├─ 顶部「+ 新增灰度」按钮 → ReleaseModal(release=null)            │
│   └─ 行内「编辑」按钮 → ReleaseModal(release=current)               │
│                                                                    │
│   ReleaseModal.tsx                                                  │
│   ├─ 名称 / artifactId(select) / 状态(select) / rules(动态数组)    │
│   ├─ 规则类型切换时清空无关字段(避免脏数据)                          │
│   ├─ userIdList:textarea(每行一个 userId)                          │
│   ├─ percent:number input(0-100)                                   │
│   ├─ header:两个 input(key + 逗号分隔的 values)                    │
│   ├─ 保存:POST 或 PATCH                                              │
│   ├─ 删除:两步确认(避免误删)                                        │
│   └─ Esc 键关闭                                                     │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ fetch /api/admin/*
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│                       Worker Admin API                              │
│                                                                    │
│   GET    /api/admin/artifacts     扫 R2 artifacts/ 前缀,去重 buildId│
│   GET    /api/admin/releases      读 KV active-releases             │
│   POST   /api/admin/releases      normalizeRule 校验 → append → 写 KV│
│   PATCH  /api/admin/releases/:id  找到 → 合并字段 → 写 KV            │
│   DELETE /api/admin/releases/:id  过滤掉对应 id → 写 KV              │
│                                                                    │
│   注:无鉴权(学习项目,生产环境加 token 校验)                       │
│   注:KV 写并发风险(读-改-写),学习项目可接受                      │
└────────────────────────────────────────────────────────────────────┘
```

### 5.4 端到端验证流程

1. **打开站点**:主页 header 显示 `Version: build-xxx` / `Artifact: build-xxx`,无 Canary 标识
2. **进入灰度管理**:点主页「灰度管理」按钮 → AdminPage 列表(初始为空)
3. **新建灰度**:
   - 名称:`test-canary`
   - 产物版本:从下拉选一个 `build-xxx`(由 `/api/admin/artifacts` 扫 R2 列出)
   - 状态:`running`
   - 规则:`userIdList`,values 填 `test-user`
   - 保存
4. **设置 cookie**:DevTools → Application → Cookies → 加 `user_id=test-user`
5. **刷新主页**:header 应显示 `FE Deploy (Canary)` + `Release: test-canary`
6. **改 cookie**:`user_id=other`,刷新,回到全量版本(无 Canary)
7. **删除灰度**:在弹窗里点删除,`test-user` 也回到全量版本

### 5.5 已知限制(学习项目范围内可接受)

| 限制 | 影响 | 生产环境方案 |
|---|---|---|
| Admin API 无鉴权 | 任何人能改灰度规则 | 加 token / 接入 SSO |
| KV 读-改-写无锁 | 并发 POST 可能丢一条 | Durable Object 串行化,或加版本号 CAS |
| 无审计日志 | 谁改的、什么时候改的、改了啥,无记录 | 写入 D1 / 外部日志服务 |
| 无监控大盘 | 灰度命中率、错误率没可视化 | Sentry Release 维度 + Grafana |
| R2 list 单次 1000 个对象 | 超过 ~50 个 buildId 会截断 | 加 cursor 翻页 |
| 无实验分桶/互斥 | 多灰度按顺序匹配,不能"组 A 见实验 1,组 B 见实验 2" | 引入分桶层(如 Hashids + 互斥规则) |

## 6. 关键文件清单

```
fe-depoly/
├── .github/workflows/
│   └── deploy-r2-worker.yml          # CI/CD 主流水线
│
├── worker/
│   ├── wrangler.toml                  # Worker 配置:R2/KV 绑定、vars
│   └── src/index.ts                   # Worker 入口:静态服务 + Admin API + BFF
│
├── src/
│   ├── App.tsx                        # 入口,view 状态切换 app/admin
│   ├── App.css                        # 含 admin 页面样式
│   ├── AdminPage.tsx                  # 灰度列表页
│   ├── ReleaseModal.tsx               # 灰度表单弹窗
│   └── api.ts                         # /api/admin/* fetch 封装
│
├── vite.config.ts                     # Vite + Sentry + visualizer 配置
├── package.json                       # scripts: lint / type-check / build / test
│
└── doc/
    ├── cicd.md                        # CI/CD 基础(早期方案)
    ├── deploy.md                      # R2 + Worker 部署细节
    ├── hybrid-depoly.md               # 混合部署(BFF + canary)演进
    ├── gary-by-userId.md              # 企业灰度平台设计参考
    ├── admin-ui-plan.md               # Admin UI 实施方案(本架构的灰度部分)
    ├── sentry.md                      # 错误监控 + source map
    ├── bundle-analysis.md             # 产物体积分析
    └── deploy-gray-architecture.md    # 本文档:总览
```

## 7. 演进路线

```
[已完成]
  ├─ CI:基础 build + deploy(单版本)
  ├─ 部署:R2 + Worker 静态服务
  ├─ 监控:Sentry 错误捕获 + source map
  ├─ 产物体积分析:rollup-plugin-visualizer
  ├─ 多版本共存:artifacts/{BUILD_ID}/ + KV 指针
  ├─ 灰度规则引擎:userIdList / percent / header
  ├─ BFF:Worker 内置 /api/* 反代
  └─ Admin UI:规则 CRUD + 动态表单

[下一步]
  ├─ Admin API 鉴权(SSO / token)
  ├─ 灰度命中率监控(Sentry Release 维度 + 自定义事件)
  ├─ 一键回滚 UI(选历史 buildId,立即更新 current-artifact)
  ├─ R2 list 翻页(超过 50 个 buildId 时)
  └─ 实验分桶层(支持互斥实验)

[远期]
  ├─ 多环境(staging / prod)隔离
  ├─ Durable Object 串行化 KV 写
  ├─ 审计日志 + 操作历史
  └─ 实时灰度指标大盘(Grafana / Sentry Dashboards)
```
