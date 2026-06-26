# 企业级灰度平台:按 userId 选构建产物

> 配套文档:`doc/gray-depoly.md`(蓝绿/金丝雀基础)、`doc/hybrid-depoly.md`(混合部署架构)、`doc/cdn-cache.md`(缓存策略)。
> 本文回答一个问题:**为什么企业里的灰度平台可以「选某个时间点的构建产物 + 指定某些 userId」**,而本项目的 `CANARY_PERCENT` 只能按百分比随机切?

## 一、本项目当前灰度 vs 企业灰度平台

### 当前实现(`worker/src/index.ts:77`)

```ts
const inCanary = hashUserId(userId) % 100 < Number(env.CANARY_PERCENT || 0)
```

- 灰度规则:**百分比**(改 `CANARY_PERCENT` 环境变量,重新部署 Worker 才生效)
- 产物选择:**没有**,只有当前一份 `index.html`,所有命中灰度的用户都看这份
- 命中灰度后:**前端代码读 `window.__APP_CONFIG__.canary` 决定走新逻辑**(代码层 if/else)
- 回滚:改 `CANARY_PERCENT=0` 重新部署

**本质是「同一份代码,不同用户开关不同」**,不是「不同版本,不同用户看到不同产物」。

### 企业灰度平台的能力

| 能力 | 当前项目 | 企业平台 |
|------|---------|---------|
| 选构建产物 | ❌ 只有当前版本 | ✅ 历史任意一次构建可选 |
| 灰度范围 | 百分比 | userId 列表 / 白名单 / 地域 / UA / 自定义规则 |
| 切流方式 | 改环境变量重新部署 | 平台点按钮,秒级生效 |
| 多灰度并存 | ❌ 只能一条 | ✅ 可同时跑多条实验 |
| 灰度产物 | 同一份 HTML | 新旧两份 HTML,各自独立 |
| 回滚 | 改百分比重部署 | 平台一键回滚到 0% |

**核心差异**:企业平台是「**多版本产物共存 + 规则中心 + 边缘路由**」三位一体,本项目目前只有「单版本 + 硬编码规则」。

## 二、企业灰度平台的四大支柱

```
┌─────────────────────────────────────────────────────────────┐
│                    灰度平台 Admin Web                       │
│  新建灰度 → 选产物 → 配规则 → 放量 → 监控 → 回滚           │
└──────────────────────┬──────────────────────────────────────┘
                       │ 写入规则
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  规则中心 (Config/KV)                       │
│  {                                                          │
│    "exp-123": {                                             │
│      artifactId: "build-2026-06-25-abcd123",                │
│      rules: [                                               │
│        { type: "userIdList", values: ["u1","u2","u3"] },    │
│        { type: "percent", value: 10 }                       │
│      ]                                                      │
│    }                                                        │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
                       │ 边缘 Worker 读规则
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              边缘路由层 (Worker / Nginx / 网关)             │
│  请求来 → 提取 userId → 查规则 → 决定用哪份产物            │
└──────────────────────┬──────────────────────────────────────┘
                       │ 按版本号取对应产物
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              产物仓库 (R2 / OSS,多版本共存)                │
│  /artifacts/build-2026-06-25-abcd123/index.html             │
│  /artifacts/build-2026-06-25-abcd123/assets/index-a1b2.js   │
│  /artifacts/build-2026-06-26-efgh456/index.html             │
│  /artifacts/build-2026-06-26-efgh456/assets/index-c3d4.js   │
└─────────────────────────────────────────────────────────────┘
```

四大支柱:
1. **产物仓库**:每次 CI 构建产物都保留,按 `buildId` 索引,不互相覆盖
2. **规则中心**:存「哪条灰度用哪个产物 + 命中哪些用户」,可动态增删改
3. **边缘路由**:Worker 每次请求时读规则 → 决定回哪份产物
4. **可观测 + 回滚**:每条灰度的流量、错误率、转化率实时上报,出问题一键关

## 三、产物仓库:多版本共存

### 当前项目的问题

CI 用 `aws s3 sync --delete` 上传 `dist/`,**新构建直接覆盖旧的**:

```
R2 Bucket:
  index.html            ← 永远只有一份,新版本覆盖旧版本
  assets/index-a1b2.js  ← 旧 hash 文件被 --delete 删了
  assets/index-c3d4.js  ← 新 hash 文件
```

发版后旧用户(浏览器缓存了旧 HTML)请求旧 hash JS → 404。本项目靠「HTML 短缓存 + 静态资源长缓存」勉强能跑,但**做不了灰度**:灰度需要新旧产物同时存在。

### 企业做法:按 buildId 隔离

每次构建产物放到独立目录,不互相覆盖:

```
R2 Bucket:
  artifacts/
    build-2026-06-25-abcd123/         ← v1,git SHA = abcd123
      index.html
      assets/index-a1b2.js
      assets/index-a1b2.css
    build-2026-06-26-efgh456/         ← v2,git SHA = efgh456
      index.html
      assets/index-c3d4.js
      assets/index-c3d4.css
  current → build-2026-06-25-abcd123  ← 软链/指针,指向当前全量版本
```

**关键点**:
- 每次构建产物按 `build-{date}-{gitSha}` 命名,**永不覆盖**
- `current` 是个指针(可以用 KV 存,也可以用一个小文件存),指向当前全量版本
- 灰度版本不动 `current`,而是在规则里指定 `artifactId: build-2026-06-26-efgh456`
- 旧产物用 OSS 生命周期规则自动清理(比如 30 天没引用就删)

### CI 改造

```yaml
# .github/workflows/deploy-r2-worker.yml
- name: Build
  run: npm run build
  env:
    VITE_BUILD_ID: build-${{ github.run_id }}-${{ github.sha }}

- name: Upload to R2 (versioned, no --delete)
  run: |
    BUILD_ID="build-${{ github.run_id }}-${GITHUB_SHA::7}"
    aws s3 sync dist/ s3://fe-depoly-assets/artifacts/$BUILD_ID/ \
      --cache-control "public, max-age=31536000, immutable" \
      --endpoint-url "$AWS_ENDPOINT_URL"
    # 不再 --delete,不再上传到根目录

- name: Register artifact
  run: |
    # 把这次构建注册到产物列表(KV 或数据库)
    curl -X POST https://api.example.com/admin/artifacts \
      -H "Authorization: Bearer ${{ secrets.ADMIN_TOKEN }}" \
      -d "{
        \"buildId\": \"$BUILD_ID\",
        \"gitSha\": \"${{ github.sha }}\",
        \"branch\": \"${{ github.ref_name }}\",
        \"commitMessage\": \"${{ github.event.head_commit.message }}\",
        \"buildTime\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
        \"size\": $(du -sb dist/ | cut -f1)
      }"
```

注意:
- **不再 `--delete`**,多版本才能共存
- **不再上传到根目录**,所有产物在 `artifacts/{buildId}/` 下
- CI 跑完,**不会自动把 `current` 指向新版本**——这步要灰度平台手动点(或全量发布流程点)

## 四、规则中心:KV / 数据库存规则

规则是动态的(产品同学点按钮就改),不能写死在 Worker 代码或环境变量里。

### 规则数据结构

```ts
interface GrayRelease {
  id: string                    // 灰度 ID,如 "exp-123"
  name: string                  // "首页改版灰度"
  artifactId: string            // "build-2026-06-26-efgh456"
  status: 'draft' | 'running' | 'paused' | 'finished' | 'rolled-back'
  rules: GrayRule[]             // 命中规则,OR 关系
  createdAt: string
  createdBy: string
  updatedAt: string
}

interface GrayRule {
  type: 'userIdList' | 'percent' | 'segment' | 'header' | 'ipRange'
  // userIdList: 精确命中
  values?: string[]             // ["u1", "u2", "u3"]
  // percent: 哈希百分比
  value?: number                // 10 = 10%
  // segment: 用户画像(地域/年龄段/会员等级)
  segmentKey?: string           // "region"
  segmentValues?: string[]      // ["beijing", "shanghai"]
  // header: 自定义请求头
  headerKey?: string
  headerValues?: string[]
}

interface Artifact {
  buildId: string
  gitSha: string
  branch: string
  commitMessage: string
  buildTime: string
  size: number
  status: 'registered' | 'in-use' | 'archived'
}
```

### 存储选型

| 存储 | 适合 | 延迟 | 成本 |
|------|------|------|------|
| **Cloudflare KV** | 读多写少,规则不常变 | 边缘 ~1ms,最终一致 60s | 低 |
| Cloudflare D1 | 关系型,要 JOIN 查询 | 边缘 ~5ms | 低 |
| Workers Variables | 静态配置,极少改 | 0ms | 免费 |
| 外部 MySQL/PG | 已有数据库,复杂查询 | 50-200ms(回源) | 已有 |

**推荐 KV**:灰度规则是「读多写少 + 全球分布」,KV 天然适合。Worker 边缘读 KV,~1ms 出结果,不用回源。

### KV 结构

```
KV Namespace: GRAY_RULES
  key: "release:exp-123"       → value: GrayRelease JSON
  key: "release:exp-124"       → value: GrayRelease JSON
  key: "active-releases"       → value: ["exp-123", "exp-124"]  (索引)
  key: "current-artifact"      → value: "build-2026-06-25-abcd123"  (全量版本)
  key: "artifact:build-2026-06-26-efgh456" → value: Artifact JSON
  key: "artifact-list"         → value: ["build-...", "build-..."]  (索引)
```

Worker 读规则:
```ts
// 边缘读 KV,毫秒级
const activeIds = await env.GRAY_RULES.get('active-releases', 'json') as string[]
const releases = await Promise.all(
  activeIds.map(id => env.GRAY_RULES.get(`release:${id}`, 'json'))
)
```

### Admin API

```
POST   /admin/artifacts              注册新产物(CI 调用)
GET    /admin/artifacts              列出所有产物
GET    /admin/artifacts/:buildId     查看产物详情

POST   /admin/releases               新建灰度
GET    /admin/releases               列出所有灰度
PATCH  /admin/releases/:id           更新灰度(改规则、放量、暂停)
POST   /admin/releases/:id/rollback  回滚到 0%
POST   /admin/releases/:id/finish    完成灰度,升级为全量
```

Admin API 走鉴权(内部 token / SSO),只有研发/产品能调。生产环境通常再加一层审批流(改 → 提交 → 审批 → 生效)。

## 五、边缘路由:Worker 决定用哪份产物

### 路由逻辑

```ts
async function handleStatic(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  let path = url.pathname
  if (path === '/') path = '/index.html'

  // 1. 提取 userId(从 Cookie / Token / Header)
  const userId = getUserIdFromRequest(request)

  // 2. 查所有活跃灰度,看命中哪条
  const release = await matchGrayRelease(userId, request, env)

  // 3. 决定用哪份产物
  let artifactId: string
  if (release) {
    // 命中灰度 → 用灰度产物
    artifactId = release.artifactId
  } else {
    // 未命中 → 用全量产物
    artifactId = await env.GRAY_RULES.get('current-artifact') as string
  }

  // 4. 从 R2 取对应产物
  // 静态资源:assets/index-a1b2.js → artifacts/{artifactId}/assets/index-a1b2.js
  // HTML:index.html → artifacts/{artifactId}/index.html
  const objectKey = `artifacts/${artifactId}/${path.slice(1)}`
  let object = await env.ASSETS_BUCKET.get(objectKey)

  // 5. SPA 回退:对象不存在且不是静态文件 → 当前 artifactId 的 index.html
  const ext = path.split('.').pop()?.toLowerCase() || ''
  if (!object && !LONG_CACHE_EXTENSIONS.includes(ext)) {
    object = await env.ASSETS_BUCKET.get(`artifacts/${artifactId}/index.html`)
  }
  if (!object) return new Response('Not Found', { status: 404 })

  // 6. HTML 注入灰度标识(可选,用于前端做差异渲染)
  const isHtml = ext === 'html' || path === '/index.html'
  let body = object.body
  if (isHtml) {
    const html = await object.text()
    body = html.replace(
      '</head>',
      `<script>window.__APP_CONFIG__=${JSON.stringify({
        artifactId,
        releaseId: release?.id || null,
        releaseName: release?.name || null,
        version: artifactId,
      })};</script></head>`,
    )
  }

  // 7. 边缘缓存(注意:HTML 不缓存,静态资源按 artifactId 缓存)
  const cacheKey = new Request(request.url, { method: 'GET' })
  const cache = caches.default
  if (request.method === 'GET' && !isHtml) {
    const cached = await cache.match(cacheKey)
    if (cached) return cached
  }

  const response = new Response(body, { headers: buildHeaders(object, ext, isHtml) })
  if (request.method === 'GET' && !isHtml) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()))
  }
  return response
}

async function matchGrayRelease(userId: string, request: Request, env: Env): Promise<GrayRelease | null> {
  const activeIds = await env.GRAY_RULES.get('active-releases', 'json') as string[] | null
  if (!activeIds || activeIds.length === 0) return null

  // 优先级:userIdList > segment > header > percent
  // 通常配置成「先匹配精确规则,再匹配百分比」
  for (const id of activeIds) {
    const release = await env.GRAY_RULES.get(`release:${id}`, 'json') as GrayRelease
    if (release.status !== 'running') continue

    for (const rule of release.rules) {
      if (matchRule(rule, userId, request)) {
        return release
      }
    }
  }
  return null
}

function matchRule(rule: GrayRule, userId: string, request: Request): boolean {
  switch (rule.type) {
    case 'userIdList':
      return rule.values?.includes(userId) ?? false
    case 'percent':
      return hashUserId(userId) % 100 < (rule.value ?? 0)
    case 'segment':
      // 需要查用户画像服务,这里简化
      return checkUserSegment(userId, rule.segmentKey!, rule.segmentValues!)
    case 'header':
      const hv = request.headers.get(rule.headerKey!)?.toLowerCase()
      return hv ? rule.headerValues!.map(v => v.toLowerCase()).includes(hv) : false
    case 'ipRange':
      const ip = request.headers.get('CF-Connecting-IP') || ''
      return checkIpInRanges(ip, rule.values || [])
    default:
      return false
  }
}
```

### 为什么不能用 URL 路径区分版本

直觉做法:`v1.example.com` 和 `v2.example.com`,或者 `example.com/v2/`。**企业里不这么做**,原因:

1. **用户看到的 URL 不变**:`example.com` 永远是同一个域名,改 URL 会丢分享链接、SEO、收藏夹
2. **Cookie/Token 自动带**:同域名才自动带 Cookie,跨子域名要配 CORS
3. **CDN 缓存键统一**:URL 不变,CDN 缓存策略统一,不用为每个版本配独立缓存

所以**版本切换在边缘层透明完成**,用户感知不到 URL 变化。

### 关键:HTML 不能缓存(否则灰度失效)

```
❌ 错误:HTML 边缘缓存 1 小时
  用户 A 命中灰度 → Worker 返回 v2 的 HTML → 边缘节点缓存
  用户 B 未命中灰度 → Worker 想返回 v1 的 HTML → 但边缘缓存了 v2 → 错乱

✅ 正确:HTML 不缓存
  每次请求都到 Worker,Worker 按用户决定版本
  静态资源(带 hash)可以放心缓存,因为不同版本的 hash 不同,缓存键天然隔离
```

本项目 `worker/src/index.ts:92` 已经这么做了(`!isHtml` 才写缓存),正确。

## 六、完整工作流:新建一条按 userId 的灰度

```
1. 研发 push 代码 → CI 触发
   ├─ 构建产物 → 上传到 R2 artifacts/build-{run_id}-{sha}/
   ├─ 注册到规则中心:artifactId=build-..., gitSha=..., branch=main
   └─ 不动 current-artifact,不自动全量发布

2. 研发登录灰度平台 Admin Web
   ├─ 看到产物列表,选择 build-2026-06-26-efgh456
   ├─ 新建灰度:
   │   name: "首页改版灰度"
   │   artifactId: build-2026-06-26-efgh456
   │   rules:
   │     - type: userIdList
   │       values: ["user-u1", "user-u2", "user-u3"]   ← 内部测试账号
   │   status: running
   └─ 平台调 Admin API → 写入 KV:release:exp-123

3. user-u1 访问 example.com
   ├─ Worker 收到请求 → 提取 userId=user-u1
   ├─ Worker 读 KV active-releases → [exp-123]
   ├─ Worker 读 KV release:exp-123 → 命中 userIdList 规则
   ├─ Worker 从 R2 取 artifacts/build-2026-06-26-efgh456/index.html
   └─ 返回 v2 的 HTML(注入 __APP_CONFIG__.releaseId=exp-123)

4. 其他用户访问
   ├─ Worker 收到请求 → 提取 userId=user-x
   ├─ 不命中任何灰度规则
   ├─ Worker 读 KV current-artifact → build-2026-06-25-abcd123
   ├─ Worker 从 R2 取 artifacts/build-2026-06-25-abcd123/index.html
   └─ 返回 v1 的 HTML

5. 研发观察监控
   ├─ Sentry 错误率:user-u1/u2/u3 有没有新错误
   ├─ 业务指标:点击率、转化率(上报 releaseId 维度)
   └─ 出问题:平台点「回滚」→ status=rolled-back → KV 秒级生效

6. 灰度验证通过 → 平台点「全量发布」
   ├─ 改 KV current-artifact → build-2026-06-26-efgh456
   ├─ 改 release status → finished
   └─ 所有用户开始看到新版本(无需重新部署 Worker)
```

整个流程**没有一次重新部署**,全靠改 KV 规则。从「点按钮」到「生效」几秒钟。

## 七、相比当前项目的改造点

### 改造 1:CI 不再 `--delete`,按 buildId 上传

```yaml
# .github/workflows/deploy-r2-worker.yml
- name: Sync to R2 (versioned, no --delete)
  run: |
    BUILD_ID="build-${{ github.run_id }}-${GITHUB_SHA::7}"
    aws s3 sync dist/ s3://fe-depoly-assets/artifacts/$BUILD_ID/ \
      --cache-control "public, max-age=31536000, immutable" \
      --endpoint-url "$AWS_ENDPOINT_URL"
    # 不删旧文件,不动根目录
```

### 改造 2:Worker 加 KV 绑定 + 规则匹配

```toml
# worker/wrangler.toml
[[kv_namespaces]]
binding = "GRAY_RULES"
id = "你的 KV namespace id"
preview_id = "预览 KV id"
```

### 改造 3:Worker 路由按规则选产物

把 `worker/src/index.ts` 的 `handleStatic` 改造成「查 KV → 选 artifactId → 取对应产物」,代码见上面第五节。

### 改造 4:加 Admin API(单独一个 Worker 或同 Worker 加路径)

```ts
// 在 handleApi 里加 /admin/* 路径
if (path.startsWith('/admin/')) {
  return handleAdmin(request, env)  // 调 KV 增删改规则
}
```

### 改造 5:Admin Web(可选,初期可用脚本)

初期可以用 `curl` 调 Admin API 验证流程,跑通后再做 Web 界面。Web 界面就是个 React SPA,调 Admin API,功能:
- 产物列表(表格:buildId / gitSha / commitMessage / buildTime / 状态)
- 灰度列表(表格:ID / 名称 / 产物 / 规则 / 状态 / 操作)
- 新建灰度表单(选产物 + 配规则)
- 实时监控(错误率、流量,接 Sentry / Prometheus)

## 八、真实企业平台参考

| 平台 | 特点 |
|------|------|
| **阿里云 MSE 全链路灰度** | 跟随 RPC/消息灰度,前端 + 后端 + DB 联动,适合微服务架构 |
| **美团 DEF / Nemo** | 内部自研,前端灰度 + A/B + 多环境管理 |
| **字节 飞书前端灰度平台** | 基于 TT(内部框架),支持 userId 白名单 + 实验对照 |
| **腾讯 CodeDog / STKE** | 容器灰度 + 前端灰度,跟 K8s 集成 |
| **Vercel Edge Config + Flags** | 国外主流,Cloudflare 类似,边缘 KV + Feature Flags |
| **LaunchDarkly / Split.io** | SaaS Feature Flag 服务,支持复杂规则、AB 实验 |

这些平台的共性:
1. **产物多版本共存**(对象存储按 buildId 隔离)
2. **规则中心**(KV / 数据库存规则)
3. **边缘路由**(Worker / 网关按规则选产物)
4. **可观测 + 回滚**(监控 + 一键回滚)

本项目走的是 **Vercel/Cloudflare** 这套边缘原生的路子,跟 LaunchDarkly 思路一致,只是规模小。

## 九、关键陷阱

### 1. HTML 被边缘缓存,灰度错乱

**问题**:HTML 配了 `max-age=60`,用户 A 命中灰度拿到 v2 HTML,边缘节点缓存 60 秒;用户 B 在这 60 秒内访问,命中同一缓存,看到 v2,但 B 不该是灰度用户。

**解决**:HTML 必须 `max-age=0, must-revalidate`,或者干脆 `Cache-Control: no-store`。代价是每次请求都到 Worker,但 Worker 边缘执行只几毫秒,可接受。

### 2. 静态资源 hash 冲突

**问题**:v1 和 v2 都叫 `assets/index-a1b2.js`,但内容不同(极少见,只有 hash 算法碰撞或手动改文件名才会)。

**解决**:Vite/Webpack 默认用 content hash,不同内容必然不同 hash。只要不手动改文件名,不会冲突。**保险做法**:把产物放到 `artifacts/{buildId}/` 子目录,不同 buildId 的同 hash 文件互不影响。

### 3. 灰度规则缓存导致切流不生效

**问题**:Worker 读 KV 后内存缓存 5 分钟,改了规则 5 分钟才生效。

**解决**:
- KV 本身有 60 秒最终一致,可接受
- Worker 内存缓存最多 60 秒,跟 KV 一致
- 紧急回滚:加一个 `?bypass-cache=1` 参数(管理员用),或 Worker 监听 KV 变更主动清缓存

### 4. 同一用户在灰度期间访问新旧交替

**问题**:用户 A 第一次访问命中灰度看到 v2,5 分钟后再次访问,边缘缓存失效后重新匹配规则,如果规则改了(比如把 A 从 userIdList 移除),A 看到旧版 v1,**体验割裂**。

**解决**:
- 灰度期间规则不改(只增不减,移除用户走「全量发布」或「回滚」整条灰度)
- 或用「粘性灰度」:用户首次命中灰度后,在 Cookie 里写 `release=exp-123`,后续请求带这个 Cookie,Worker 看到 Cookie 直接走对应版本(不重新匹配规则)
- 粘性灰度的代价:用户清 Cookie 会切版本,但概率低

### 5. 灰度产物引用了不存在的静态资源

**问题**:灰度产物 `build-2026-06-26-efgh456/index.html` 引用 `assets/index-c3d4.js`,但 R2 上传时漏了,Worker 取不到 → 白屏。

**解决**:
- CI 上传后做完整性校验:`aws s3 ls` 列出所有文件,跟 `dist/` 比对
- 上传失败重试,失败报警,灰度平台不让注册产物
- Worker 取不到静态资源时,fallback 到 `current-artifact` 的同名文件(降级)

### 6. 多灰度并存的优先级冲突

**问题**:用户 A 同时命中 exp-123(userIdList)和 exp-124(percent 10%),应该走哪个?

**解决**:
- 灰度平台设计时约定「一次只跑一条灰度」(简单,够用)
- 或定义优先级:`userIdList > segment > header > percent`,Worker 按优先级匹配,命中即返回
- 复杂场景(AB 实验互斥):用「实验分桶」——同一用户始终进同一实验桶,避免重叠

## 十、跟当前项目的对比总结

| 维度 | 当前项目 | 改造后(企业级) |
|------|---------|---------------|
| 产物 | 单版本,`--delete` 覆盖 | 多版本共存,按 buildId 隔离 |
| 规则 | 硬编码在 Worker(百分比) | KV 动态存储(多种规则类型) |
| 切流 | 改环境变量 + 重新部署 Worker | 平台改 KV,秒级生效 |
| 范围 | 仅百分比 | userId 列表 / 百分比 / 画像 / Header / IP |
| 多灰度 | ❌ 只能一条 | ✅ 多条并存(带优先级) |
| 回滚 | 改 `CANARY_PERCENT=0` 重部署 | 平台一键回滚 |
| 前端感知 | `window.__APP_CONFIG__.canary` | `window.__APP_CONFIG__.releaseId` |
| Admin | ❌ 无 | ✅ API + Web 界面 |

**改造成本**(基于本项目现状):
- CI 改造:0.5 天(去 `--delete` + 按 buildId 上传)
- Worker 改造:1 天(加 KV 绑定 + 规则匹配逻辑)
- Admin API:1-2 天(增删改查 + 鉴权)
- Admin Web:3-5 天(React SPA,可选)
- 监控接入:1 天(Sentry / 业务指标按 releaseId 维度上报)

跑通 MVP(CI + Worker + KV + curl 调 API)2-3 天就够,生产级(带 Web 界面 + 审批流 + 监控)1-2 周。

## 十一、最小可行实现:3 天跑通

如果只想验证流程,不做 Admin Web,用 curl 调 API:

**Day 1**:
- 改 CI:按 buildId 上传,注册产物到 KV
- 改 Worker:读 KV `current-artifact`,从 `artifacts/{buildId}/` 取产物

**Day 2**:
- Worker 加规则匹配:读 KV `active-releases`,按 userId 哈希 + userIdList 匹配
- 加 Admin API:`POST /admin/releases` 新建灰度(用 Bearer token 鉴权)

**Day 3**:
- 用 `curl` 模拟操作:注册产物 → 新建灰度 → 测试命中 → 回滚
- 接 Sentry,按 `releaseId` 维度上报错误,验证可观测

跑通后,要做 Admin Web 再补,不做也能用(命令行工具)。

## 十二、小结

企业级灰度平台的核心 = **多版本产物共存 + 规则中心 + 边缘路由**。

- **产物仓库**:R2 按buildId 隔离,CI 不删旧文件
- **规则中心**:KV 存灰度规则,Worker 边缘读取
- **边缘路由**:Worker 查规则 → 选产物 → 透明返回(用户看不到 URL 变化)
- **Admin**:API + Web 增删改规则,平台点按钮秒级生效
- **可观测 + 回滚**:监控按 releaseId 维度,出问题一键回滚到 0%

跟当前项目的「百分比灰度」相比,本质区别是:
1. **从「同一份代码,开关不同」升级为「不同产物,版本不同」**
2. **从「改环境变量重部署」升级为「改 KV 秒级生效」**
3. **从「单一百分比规则」升级为「多类型规则 + 多灰度并存」**

本项目当前的 `worker/src/index.ts` 已经搭好了「边缘路由 + HTML 注入」的骨架,改造的核心是**把规则从环境变量搬到 KV + 把产物从单版本改为多版本共存**,其他逻辑变化不大。
