# 混合部署方案:静态 + HTML + API 分流

> 对应 `cdn-cache.md` 里提到的「常见组合」——大型项目不是纯 OSS+CDN 也不是纯服务器,而是按资源类型分别走不同链路。本文把这套架构拆开讲清楚:为什么分、怎么分、分完怎么管。

## 一、什么是混合部署

纯模式有两种:
- **纯服务器部署**:所有资源(JS/CSS/HTML/API)都从一台服务器出
- **纯 OSS+CDN 部署**:所有资源都放对象存储,CDN 边缘返回

混合部署的核心:**按资源类型拆分链路,每种资源走最适合它的通道**。

```
                      ┌─ 静态资源(JS/CSS/图片/字体) ──> OSS + CDN
用户 ──> 接入层 ──────┼─ HTML 入口 ──> SSR 容器 / 边缘函数
                      └─ API 请求 ──> API 网关 + 后端服务
```

三条链路独立部署、独立缓存、独立扩缩容,各自走最优路径。

## 二、为什么需要拆分

不同资源类型对"部署、缓存、动态性"的需求完全不同,塞进一个通道必然有牺牲。

| 资源类型 | 变更频率 | 缓存策略 | 是否需要动态处理 | 适合通道 |
|---------|---------|---------|----------------|---------|
| 带 hash 的静态资源 | 每次发版 | 1 年长缓存 | 否(纯文件) | OSS + CDN |
| `index.html` | 每次发版 | 短缓存/不缓存 | 看场景(SSR 要,SPA 不用) | 服务器 / 边缘 |
| API 响应 | 实时 | 不缓存 / 协商缓存 | 是(业务逻辑) | 服务器 / Serverless |
| 图片处理(裁剪/压缩) | 按需 | 长缓存(同 URL) | 是(参数化出图) | CDN 边缘处理 |

**关键矛盾点**:
- 静态资源想要 CDN 边缘加速 → 必须放 OSS
- HTML 想要灰度/A/B 注入 → 必须走服务器(纯 OSS 做不到)
- API 想要鉴权/限流/业务逻辑 → 必须跑后端服务

把三者塞进一个服务器:静态资源占带宽、HTML 无法灰度、API 跟静态资源抢 CPU。
把三者全放 OSS:HTML 没法动态注入、API 没法跑业务逻辑。

所以大型项目都是拆开的。

## 三、整体架构

```
                          ┌─────────────────────────────┐
                          │       用户(浏览器/App)      │
                          └──────────────┬──────────────┘
                                         │
                                         ▼
                          ┌─────────────────────────────┐
                          │      DNS 智能解析            │
                          │  (按地理 / 健康检查分流)    │
                          └──────────────┬──────────────┘
                                         │
                                         ▼
                          ┌─────────────────────────────┐
                          │   CDN 边缘节点(全球 300+)  │
                          │  - TLS 终止                 │
                          │  - 静态资源缓存             │
                          │  - 图片处理                 │
                          │  - WAF / DDoS 防护          │
                          └──────┬──────────────┬───────┘
                                 │              │
                  静态资源命中   │              │ 缓存未命中 / 动态请求
                       ┌─────────┘              └──────────┐
                       ▼                                   ▼
          ┌────────────────────────┐         ┌──────────────────────────┐
          │  OSS / S3 Bucket       │         │  反向代理 / API 网关      │
          │  (静态资源源站)         │         │  (Nginx / APISIX / Kong) │
          │  - JS/CSS/图片/字体    │         │                          │
          │  - hash 文件名         │         │  路由分流:               │
          │  - 长缓存              │         │  /            → SSR      │
          └────────────────────────┘         │  /api/*      → 后端服务  │
                                             │  /assets/*   → OSS 回源 │
                                             └──────┬───────────────────┘
                                                    │
                                       ┌────────────┼────────────┐
                                       ▼            ▼            ▼
                              ┌──────────────┐ ┌──────────┐ ┌──────────────┐
                              │ SSR 容器集群 │ │ API 服务 │ │ 其他后端服务 │
                              │ (Node + K8s) │ │ (微服务) │ │ (Java/Go等) │
                              │ - 渲染 HTML  │ │          │ │              │
                              │ - 注入登录态 │ │          │ │              │
                              └──────────────┘ └──────────┘ └──────────────┘
                                                    │
                                                    ▼
                                          ┌──────────────────┐
                                          │ 数据库 / 缓存    │
                                          │ (MySQL / Redis)  │
                                          └──────────────────┘
```

## 四、三条链路详解

### 链路 1:静态资源 → OSS + CDN

**资源范围**:
- `assets/*.js`、`assets/*.css`(Vite/Webpack 构建产物,文件名带 hash)
- 图片(`*.png`、`*.webp`、`*.avif`)
- 字体(`*.woff2`)
- 其他媒体文件

**链路**:
```
浏览器请求 /assets/index-a1b2c3.js
    │
    ▼
CDN 边缘节点 ──缓存命中──> 直接返回(跳过 OSS)
    │
    │ 缓存未命中
    ▼
OSS Bucket(源站)
    │
    ▼
返回文件 + Cache-Control: max-age=31536000, immutable
    │
    ▼
CDN 写入边缘缓存,返回浏览器
```

**关键点**:
- 文件名带 content hash,内容变文件名变,可以放心 1 年长缓存
- 浏览器 + CDN 双层缓存,二次访问直接走浏览器缓存,零网络开销
- OSS 只在 CDN 未命中时被回源,流量被 CDN 大幅削减
- 发版时新 hash 的文件是新 URL,旧缓存自然过期,不需要主动 purge

### 链路 2:HTML 入口 → SSR 容器 / 边缘函数

**为什么 HTML 不能放 OSS**:
- **灰度发布**:1% 用户看新版,99% 看旧版,需要服务器判断
- **A/B 测试**:不同用户看到不同实验组,需要动态注入
- **登录态注入**:SSR 时读 Cookie,渲染时直接把用户信息塞进 HTML,避免客户端再请求
- **动态 meta**:SEO 场景下,根据 URL 动态生成 `<title>`、`og:image`
- **CDN 回源控制**:HTML 短缓存,改了能即时生效

**链路**:
```
浏览器请求 / 或 /users/123
    │
    ▼
CDN 边缘节点(HTML 不缓存或短缓存)
    │
    ▼
反向代理(Nginx / API 网关)
    │
    │ 判断:是 SSR 路由还是静态资源?
    │ - 路径 / 或 /users/* → SSR 容器
    │ - 路径 /assets/*     → OSS 回源
    │ - 路径 /api/*        → API 服务
    ▼
SSR 容器集群(Node + Next.js / Nuxt)
    │
    │ 1. 读 Cookie 拿到用户 token
    │ 2. 调内部 API 拿首屏数据(可选)
    │ 3. 渲染 React/Vue 组件为 HTML 字符串
    │ 4. 注入用户信息、灰度标识、特性开关
    │
    ▼
返回 HTML + Cache-Control: max-age=0, must-revalidate
    │
    ▼
浏览器收到 HTML,开始加载 JS + 客户端 hydrate
```

**SSR vs 边缘函数**:

| 方案 | 适合 | 登录态处理 |
|------|------|-----------|
| SSR(Node 容器集群) | SEO + 首屏 + 复杂业务 | 服务端读 Cookie |
| Edge Function(Cloudflare Workers / Vercel Edge) | 全球低延迟 + 轻量逻辑 | 边缘节点读 Cookie |
| 纯 SPA + CDN | 简单应用,不需要 SSR | 客户端读 token |

百万用户 C 端通常选 SSR 容器集群,部署在多区域,前面挂 LB。本项目当前是纯 SPA,HTML 也走 OSS+Worker(见 `cdn-cache.md` 方式 B),后续要灰度/AB 时再升级到 SSR。

### 链路 3:API → 网关 + 微服务

**为什么 API 不能跟静态资源一起放 OSS**:OSS 只能存静态文件,API 需要跑业务逻辑(数据库查询、鉴权、计算)。

**链路**:
```
浏览器请求 /api/users/123
    │
    ▼
CDN 边缘节点(API 不缓存,直接透传)
    │
    ▼
API 网关(APISIX / Kong / 阿里云 API 网关)
    │
    │ 1. 鉴权(JWT 校验、API Key 校验)
    │ 2. 限流(每用户 100 QPS、每 IP 1000 QPS)
    │ 3. 熔断(后端异常时快速失败)
    │ 4. 灰度路由(1% 流量到新版本服务)
    │ 5. 日志采集(请求量、错误率、延迟)
    │
    ▼
后端微服务集群(用户服务、订单服务、内容服务...)
    │
    ▼
数据库 / 缓存 / 消息队列
    │
    ▼
返回 JSON 响应
```

**关键点**:
- 网关统一入口,前端不直连后端服务
- 鉴权、限流、熔断在网关做,后端服务只关心业务逻辑
- 灰度按用户 ID 哈希(保证同一用户稳定在新版或旧版,不要按时间)
- API 响应不缓存,或只对幂等 GET 请求做短缓存(几秒)

## 五、路由分流策略

三条链路怎么在接入层分流?有两种方式。

### 方式 1:按路径分流(推荐,单域名)

同一个域名,按 URL 路径分流:

```
app.example.com/
    │
    ├─ /assets/*          → CDN → OSS(静态资源)
    ├─ /api/*             → API 网关 → 后端服务
    ├─ /static/*          → CDN → OSS(图片等)
    └─ /*(其他)           → SSR 容器(HTML 入口)
```

**优点**:
- 用户只看到一个域名,体验统一
- Cookie / Token 在所有请求中自动带上,无需跨域
- HTTPS 证书只需一张

**缺点**:
- 接入层路由配置复杂
- 静态资源和 API 抢同一个域名的连接数(浏览器对单域名有 6 个并发限制,HTTP/2 后缓解)

### 方式 2:按域名分流(适合大项目)

不同子域名走不同链路:

```
app.example.com         → SSR 容器(HTML 入口)
assets.example.com      → CDN → OSS(静态资源)
api.example.com         → API 网关 → 后端服务
```

**优点**:
- 每条链路独立配置,互不影响
- 静态资源可以用专门的无 Cookie 域名,减少请求体积
- 各链路独立扩缩容、独立监控

**缺点**:
- 多域名 → 多张证书(或用通配符证书)
- 跨域问题:API 请求要配 CORS
- DNS 解析次数多,首屏可能慢一点

**实际选择**:中小项目用方式 1(单域名),大型项目用方式 2(多域名)。本项目当前用方式 1,`/assets/*` 走 R2,`/*` 走 Worker SPA 回退(见 `cdn-cache.md` 方式 B)。

## 六、缓存策略(按层)

混合部署的缓存是分层的,每一层缓存策略不同。

```
浏览器缓存(最近)
    │ 未命中
    ▼
CDN 边缘缓存(每节点独立)
    │ 未命中
    ▼
源站(OSS / SSR / API)
```

| 资源类型 | 浏览器缓存 | CDN 边缘缓存 | 源站 |
|---------|-----------|-------------|------|
| 带 hash 的静态资源 | 1 年,immutable | 1 年 | OSS |
| `index.html` | 不缓存(max-age=0) | 短缓存(1 分钟)或不缓存 | SSR / OSS |
| API GET 请求 | 不缓存 | 不缓存(默认) | 后端服务 |
| API POST/PUT/DELETE | 不缓存 | 不缓存 | 后端服务 |
| 图片(原图) | 长缓存 | 长缓存 | OSS |
| 图片(处理后,如 `?w=200`) | 长缓存 | 长缓存(同 URL 命中) | CDN 边缘处理 |

**关键原则**:
- **静态资源**:文件名带 hash → 所有层都长缓存,命中率极高
- **HTML**:不能长缓存(改了要即时生效)→ 浏览器不缓存,CDN 短缓存
- **API**:实时数据 → 都不缓存(或仅几秒短缓存)

## 七、发布策略(按层)

三条链路独立发布,顺序很关键,避免新旧版本错位。

### 正确的发布顺序

```
1. 先传新静态资源到 OSS
   - 新 hash 的 JS/CSS 上传
   - 此时没人引用,无影响
   - 等几分钟全球 R2/OSS 节点同步

2. 再发新 HTML(SSR 镜像或 index.html)
   - 用户开始用新版本
   - 新 HTML 引用新 hash 的静态资源(CDN 命中新文件)
   - 旧用户继续用旧 HTML(浏览器缓存),引用旧 hash 静态资源(还在 OSS)

3. 等旧 HTML 缓存过期(几分钟)
   - 期间旧用户逐步切到新版本
   - 旧 hash 静态资源继续保留在 OSS

4. (可选)清理旧静态资源
   - 等没有用户用旧版本后再删
   - 或用 OSS 生命周期规则自动删除 30 天前的 assets/*

5. API 后端发布
   - 通常独立发布,保证向后兼容
   - 新 API 上线,旧前端仍能调用(向后兼容期)
   - 旧 API 下线前确认没有前端调用
```

### 错误的发布顺序

```
❌ 先传新 HTML,再传新静态资源
   - 用户加载新 HTML → 引用新 hash JS
   - 新 JS 还没传到 OSS → 404
   - 用户白屏

❌ 同时传新 HTML 和删除旧静态资源
   - 旧 HTML 缓存未过期的用户 → 引用旧 hash JS
   - 旧 JS 已删 → 404
   - 旧用户白屏
```

### 灰度发布(混合部署的优势)

纯 OSS+CDN 难做灰度(HTML 静态,无法分流),混合部署天然支持:

```
SSR 容器集群(灰度发布)
    │
    │ 1. 新版本镜像先部署到 1 个 Pod
    │ 2. 网关按用户 ID 哈希,1% 流量到新 Pod
    │ 3. 观察指标(错误率、延迟、业务转化)
    │ 4. 逐步放量:1% → 10% → 50% → 100%
    │ 5. 出问题随时回滚到 0%
    │
    ▼
静态资源同时传新旧两套 hash 的文件到 OSS
    - 新 HTML 引用新 hash
    - 旧 HTML 引用旧 hash
    - 两套都保留,互不影响
```

## 八、与纯模式的对比

| 维度 | 纯 OSS+CDN | 纯服务器 | 混合部署 |
|------|-----------|---------|---------|
| 静态资源加速 | ✅ 边缘 | ❌ 单机房 | ✅ 边缘 |
| HTML 灰度/AB | ❌ 难 | ✅ 容器切换 | ✅ SSR 控制 |
| API 业务逻辑 | ❌ 不支持 | ✅ 支持 | ✅ 支持 |
| 全球低延迟 | ✅ | ❌ | ✅(部分,看 SSR 部署区域) |
| 运维复杂度 | 低 | 中 | 高 |
| 成本(小流量) | 低 | 中 | 高 |
| 成本(大流量) | 低 | 高 | 中 |
| 适合项目 | 纯 SPA / 文档站 | 内网 / 私有部署 | C 端中大型项目 |

## 九、适用场景

### 适合用混合部署

- **C 端中大型项目**:有 SEO 需求、有登录态、有灰度/AB、用户分布广
- **电商 / 内容站**:首屏体验关键(SSR)+ 静态资源多(CDN)+ 后端业务重(API)
- **多团队协作**:前端、SSR、后端各自独立部署,互不阻塞
- **需要灰度/AB**:SSR 容器按比例分流,纯 OSS 做不到

### 不适合用混合部署

- **纯 SPA 内部工具**:没 SEO 需求、没灰度需求,纯 OSS+CDN 够用
- **纯静态文档站**:博客、文档,直接 OSS+CDN,加 HTML 就过度设计
- **内网私有部署**:资源不出公网,CDN 用不上,直接服务器部署
- **学习/个人项目**:复杂度高,先用纯模式跑通,再考虑混合

## 十、真实案例参考

### 案例一:电商 C 端(百万用户)

```
app.example.com(单域名)
    │
    ├─ /assets/*         → 阿里云 OSS + CDN(静态资源)
    ├─ /static/*         → 阿里云 OSS + CDN(图片,带处理参数)
    ├─ /api/*            → API 网关(APISIX)+ 微服务集群
    └─ /*                → SSR 容器集群(Next.js on K8s)

部署:
- 静态资源:CI 直接 sync 到 OSS
- SSR:CI 构建镜像 → 推到镜像仓库 → K8s 滚动更新
- API:独立 CI,独立部署,保证向后兼容

灰度:
- 网关按用户 ID 哈希,1% → 新 SSR Pod
- 同时 OSS 传新旧两套静态资源
- 出问题网关切回 100% 旧版
```

### 案例二:企业内部系统(几千用户)

```
internal.example.com(单域名,内网访问)
    │
    ├─ /assets/*         → Nginx 直接服务静态文件
    ├─ /api/*            → 反代到 Java 后端
    └─ /*                → Nginx 返回 index.html(SPA 回退)

特点:
- 不需要 CDN(内网,无地理分布)
- 不需要 SSR(内部系统,SEO 无关)
- 不需要灰度(用户少,直接发)
- 单台 Nginx + 单台后端,够用

这种场景纯服务器部署就够,没必要混合部署。
```

### 案例三:本项目当前状态

```
app.example.com(单域名)
    │
    ├─ /assets/*         → Cloudflare R2(长缓存)
    ├─ /*                → Worker → R2(SPA 回退到 index.html)

特点:
- 纯 SPA,无 SSR
- 无后端 API(暂未做)
- 静态资源 + HTML 都在 R2,Worker 做路由
- 这是混合部署的"雏形":静态资源和 HTML 已经分开处理,但都走 R2

后续升级方向:
- 加 SSR:Worker 把 /* 路由到 SSR 容器,而不是 R2
- 加 API:Worker 把 /api/* 路由到后端服务
- 此时就是完整的混合部署
```

## 十一、常见陷阱

### 1. HTML 缓存过长导致发版不生效

**问题**:HTML 设了 `max-age=3600`(1 小时),发版后用户 1 小时内还看到旧版。

**解决**:HTML 必须 `max-age=0, must-revalidate`,或最多几分钟短缓存。

### 2. 静态资源用 `--delete` 删旧文件,旧用户白屏

**问题**:CI 用 `aws s3 sync --delete` 清理 R2,旧 hash 文件被删,旧 HTML 缓存未过期的用户加载旧 JS → 404。

**解决**:
- 不开 `--delete`,用生命周期规则自动删 30 天前的 `assets/*`
- 或拆成两个 job:先传新静态资源,等旧 HTML 过期,再删旧静态资源

### 3. API 跟静态资源抢同一个域名的连接

**问题**:单域名下,浏览器对 `app.example.com` 最多 6 个并发(HTTP/1.1),JS/CSS/图片/API 互相阻塞。

**解决**:
- 升级到 HTTP/2 或 HTTP/3(多路复用,无并发限制)
- 或把 API 拆到 `api.example.com`(跨域,但独立连接池)

### 4. SSR 集群挂了,全站白屏

**问题**:HTML 走 SSR,SSR 容器全挂了,用户访问 `/` 直接 500。

**解决**:
- SSR 集群多副本 + 健康检查,挂的 Pod 自动剔除
- CDN 配置"源站故障时返回降级页面"(Cloudflare Workers 可做)
- 极端情况:CDN 缓存一份 HTML 兜底(牺牲实时性换可用性)

### 5. 跨域 Cookie / Token 丢失

**问题**:`app.example.com` 的前端要调 `api.example.com`,Cookie 默认不跨域带上。

**解决**:
- 用 `SameSite=None; Secure` 的 Cookie(需 HTTPS)
- 或改用 Authorization Header + Token(前端手动塞)
- 或用路径分流(单域名),避免跨域

### 6. 灰度按时间而不是按用户

**问题**:9:00-9:30 切新版,9:30 后切全量。但同一用户可能在 9:29 和 9:31 分别访问,看到不同版本,体验割裂。

**解决**:按用户 ID 哈希,保证同一用户始终在新版或旧版,不要按时间切。

## 十二、落地建议

### 从零搭的话,按这个顺序逐步推进

1. **先跑通纯 OSS+CDN**:静态资源 + HTML 都放 OSS,验证基础链路
2. **加反向代理**:在 OSS 前面加 Nginx 或 Worker,做路径分流
3. **加 API 后端**:把 `/api/*` 反代到后端服务
4. **加 SSR**:把 `/*` 从 OSS 切到 SSR 容器(此时 HTML 不再放 OSS)
5. **加监控**:RUM(前端错误)+ APM(后端链路)+ 日志
6. **加灰度**:网关按用户 ID 哈希分流
7. **加多区域容灾**:多区域部署 + DNS 智能解析

每步独立验证,不要一上来就上全套架构。

### 对本项目(`fe-depoly`)的演进路径

```
当前状态:
  R2 + Worker(静态资源 + HTML 都在 R2,Worker 做路由)
  ↓
演进 1:加 API
  Worker 把 /api/* 反代到外部 API 或 Cloudflare Workers
  ↓
演进 2:加 SSR
  Worker 把 /* 从 R2 切到 SSR 容器(Cloudflare Pages Functions 或外部 Node 服务)
  ↓
演进 3:加灰度
  Worker 按用户 ID 哈希,1% 流量到新 SSR 版本
  ↓
演进 4:加多区域
  Cloudflare 边缘节点天然多区域,但 SSR 容器要部署在多区域
```

每一步都能用 Cloudflare 一套搞定,不用跨云厂商,适合学习。

## 十三、小结

混合部署的本质是**让每种资源走最适合它的通道**:

- **静态资源**想要边缘加速 → OSS + CDN
- **HTML** 想要灰度/动态注入 → SSR 容器
- **API** 想要业务逻辑 → 网关 + 微服务

不要把所有东西塞进一个通道,也不要为了"混合"而混合。项目规模到了再拆,规模没到用纯模式就够。

本项目当前是混合部署的雏形(静态资源 + HTML 都在 R2,Worker 做路由),后续要加 API、SSR、灰度时,沿着 `cdn-cache.md` 方式 B 的架构演进即可。

---

## 十四、实战:把本项目改造为混合部署

> 本项目当前是「R2 + Worker」雏形(静态资源 + HTML 都在 R2,Worker 只做路由 + SPA 回退)。下面给出一套**完整、可落地**的改造方案,把它升级为真正的混合部署:**静态资源走 R2 + CDN、API 走 Cloudflare Workers(轻量 BFF)、HTML 走 R2 但 Worker 注入动态内容(模拟 SSR 灰度)**。
>
> 改造分 4 个阶段,每个阶段独立可验证,跑不通就停在上一阶段,不会破坏现有部署。

### 改造目标

```
改造前(当前):
  用户 ──> Worker ──> R2(静态资源 + HTML)
  Worker 只做路由 + SPA 回退,无业务逻辑

改造后(混合):
  用户 ──> Worker(边缘网关)
              │
              ├─ /assets/*      → R2(静态资源,长缓存)
              ├─ /api/*         → 后端服务(Cloudflare Workers 模拟 BFF)
              ├─ /              → R2(index.html)+ Worker 注入灰度标识
              └─ /*             → R2(SPA 回退)
  Worker 承担:路由 + 缓存 + 鉴权 + 灰度 + BFF
```

**为什么不直接上 SSR 容器**:本项目是学习项目,跑一个 Node 容器成本高(要服务器或 Cloudflare Pages Functions),收益有限。用 **Worker 在边缘注入动态内容** 能学到混合部署的核心(分流 + 动态处理),又不引入额外基础设施。后续要真 SSR,把 Worker 里的注入逻辑换成调用 SSR 服务即可。

### 阶段一:Worker 加路径分流(基础)

把 Worker 从「所有请求都查 R2」改为「按路径分流」,这是混合部署的骨架。

#### 1.1 改造 `worker/src/index.ts`

```ts
interface Env {
  ASSETS_BUCKET: R2Bucket
  API_ORIGIN?: string // 后端 API 地址,阶段二用
  ENVIRONMENT: string
}

const CACHE_LONG = 'public, max-age=31536000, immutable'
const CACHE_SHORT = 'public, max-age=0, must-revalidate'

const LONG_CACHE_EXTENSIONS = [
  'js', 'css', 'woff', 'woff2', 'ttf', 'eot',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'map',
]

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // 1. 路径分流
    if (path.startsWith('/api/')) {
      return handleApi(request, env)
    }
    return handleStatic(request, env, ctx)
  },
}

// 静态资源 + HTML + SPA 回退
async function handleStatic(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  let path = url.pathname
  if (path === '/') path = '/index.html'

  let object = await env.ASSETS_BUCKET.get(path.slice(1))

  const ext = path.split('.').pop()?.toLowerCase() || ''
  if (!object && !LONG_CACHE_EXTENSIONS.includes(ext)) {
    object = await env.ASSETS_BUCKET.get('index.html')
    if (object) {
      return new Response(object.body, { headers: buildHeaders(object, ext, true) })
    }
  }
  if (!object) return new Response('Not Found', { status: 404 })
  return new Response(object.body, { headers: buildHeaders(object, ext, false) })
}

// API 反代(阶段二实现具体逻辑)
async function handleApi(request: Request, env: Env): Promise<Response> {
  return new Response(JSON.stringify({ message: 'API not implemented' }), {
    status: 501,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function buildHeaders(object: R2ObjectBody, ext: string, isHtml: boolean): Headers {
  // ...原逻辑不变
}
function getContentType(ext: string): string {
  // ...原逻辑不变
}
```

#### 1.2 验证

部署后:
- `https://app.example.com/` → 正常显示 SPA(走 R2)
- `https://app.example.com/api/anything` → 返回 `{"message":"API not implemented"}`(走 Worker API 处理)
- `https://app.example.com/assets/index-xxxx.js` → 静态资源(走 R2)

此时 Worker 已经是「边缘网关」,按路径分流,这是混合部署的第一步。

### 阶段二:加 BFF(Workers 做 API)

Worker 直接当 BFF,跑轻量后端逻辑,不需要额外服务器。用 Cloudflare Workers 内置的 KV / D1 做存储(可选)。

#### 2.1 加一个简单的 API 端点

修改 `handleApi`:

```ts
async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  // 路由表
  if (path === '/api/health') {
    return jsonResponse({ status: 'ok', env: env.ENVIRONMENT, timestamp: Date.now() })
  }
  if (path === '/api/version') {
    return jsonResponse({
      version: env.CURRENT_VERSION || 'unknown',
      deployTime: env.DEPLOY_TIME || 'unknown',
    })
  }
  if (path === '/api/count' && request.method === 'POST') {
    // 示例:调用外部 API 或操作 KV/D1
    return jsonResponse({ ok: true })
  }

  // 反代到外部后端(可选,如果有真实后端服务)
  if (env.API_ORIGIN) {
    const targetUrl = env.API_ORIGIN + path.replace('/api', '')
    return fetch(targetUrl, request)
  }

  return jsonResponse({ message: 'Not Found' }, 404)
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
```

#### 2.2 在 `wrangler.toml` 注入环境变量

```toml
[vars]
ENVIRONMENT = "production"
CURRENT_VERSION = "v1.0.0"
DEPLOY_TIME = "2026-06-25"
# API_ORIGIN = "https://your-backend.example.com"  # 如果有真实后端,取消注释
```

#### 2.3 前端调用 API

修改 `src/App.tsx`,加一个调用 BFF 的按钮:

```tsx
const [apiResult, setApiResult] = useState<string>('')

const callApi = async () => {
  const res = await fetch('/api/version')
  const data = await res.json()
  setApiResult(JSON.stringify(data))
}

// JSX 里加
<button onClick={callApi}>Call BFF</button>
<p>BFF Response: {apiResult}</p>
```

#### 2.4 验证

- 点 "Call BFF" 按钮 → 显示 `{"version":"v1.0.0","deployTime":"2026-06-25"}`
- 访问 `https://app.example.com/api/health` → 返回健康检查 JSON
- 此时静态资源走 R2,API 走 Worker BFF,**已经是混合部署的核心形态**

### 阶段三:Worker 注入动态内容(模拟 SSR 灰度)

不引入 SSR 容器,但让 Worker 在返回 `index.html` 时注入动态内容(灰度标识、特性开关、用户态),这是混合部署里「HTML 走服务器」的轻量实现。

#### 3.1 改造 `handleStatic`,在 HTML 注入灰度标识

```ts
async function handleStatic(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  let path = url.pathname
  if (path === '/') path = '/index.html'

  let object = await env.ASSETS_BUCKET.get(path.slice(1))
  const ext = path.split('.').pop()?.toLowerCase() || ''

  // SPA 回退
  if (!object && !LONG_CACHE_EXTENSIONS.includes(ext)) {
    object = await env.ASSETS_BUCKET.get('index.html')
  }

  if (!object) return new Response('Not Found', { status: 404 })

  // 对 index.html 做动态注入
  const isHtml = ext === 'html' || path === '/index.html'
  if (isHtml) {
    const html = await object.text()

    // 按用户 ID 哈希做灰度(从 Cookie 取 userId,没有就随机)
    const userId = getUserIdFromRequest(request)
    const inExperiment = hashUserId(userId) % 100 < Number(env.CANARY_PERCENT || 0)

    // 注入全局变量,前端代码读取后决定走新逻辑还是旧逻辑
    const injected = html.replace(
      '</head>',
      `<script>window.__APP_CONFIG__ = ${JSON.stringify({
        env: env.ENVIRONMENT,
        version: env.CURRENT_VERSION,
        canary: inExperiment, // 灰度标识
        deployTime: env.DEPLOY_TIME,
      })};</script></head>`
    )

    return new Response(injected, {
      headers: buildHeaders(object, ext, true),
    })
  }

  return new Response(object.body, { headers: buildHeaders(object, ext, false) })
}

function getUserIdFromRequest(request: Request): string {
  const cookie = request.headers.get('Cookie') || ''
  const match = cookie.match(/user_id=([^;]+)/)
  return match ? match[1] : 'anonymous-' + Math.random().toString(36).slice(2)
}

function hashUserId(userId: string): number {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}
```

#### 3.2 前端读取注入的配置

修改 `src/App.tsx`:

```tsx
declare global {
  interface Window {
    __APP_CONFIG__?: {
      env: string
      version: string
      canary: boolean
      deployTime: string
    }
  }
}

function App() {
  const config = window.__APP_CONFIG__
  return (
    <div className="app">
      <header>
        <h1>FE Deploy {config?.canary ? '(Canary)' : ''}</h1>
        <p>Version: {config?.version} · Env: {config?.env}</p>
      </header>
      {/* ... */}
    </div>
  )
}
```

#### 3.3 配置灰度比例

`wrangler.toml`:

```toml
[vars]
CANARY_PERCENT = "10"  # 10% 用户走灰度
```

#### 3.4 验证

- 用 `curl -H "Cookie: user_id=test123" https://app.example.com/` 查看返回的 HTML
- HTML 里应该包含 `<script>window.__APP_CONFIG__ = {env:..., canary:true/false}...</script>`
- 不同 `user_id` 的 `canary` 值不同(按哈希分流)
- 浏览器访问,看右上角是否显示 "(Canary)" 标识

**这就是混合部署的核心能力**:HTML 在边缘被动态处理,不同用户看到不同版本,而静态资源还是走 R2 长缓存。

### 阶段四:边缘缓存优化(可选)

让静态资源在 CDN 边缘缓存,减少 R2 读取次数。

#### 4.1 改造 `handleStatic`,加边缘缓存

```ts
async function handleStatic(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const cacheKey = new Request(url, request)
  const cache = caches.default

  // 只缓存 GET 请求
  if (request.method === 'GET') {
    const cached = await cache.match(cacheKey)
    if (cached) return cached
  }

  // ...原逻辑取 R2 对象、构造 response...

  const response = new Response(...)

  // 静态资源写入边缘缓存(HTML 不缓存)
  const isHtml = ext === 'html' || path === '/index.html'
  if (request.method === 'GET' && !isHtml) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()))
  }

  return response
}
```

#### 4.2 验证

- 第一次访问 `https://app.example.com/assets/index-xxxx.js` → Response Header `CF-Cache-Status: MISS`
- 第二次访问 → `CF-Cache-Status: HIT`(走边缘缓存,没回源 R2)
- HTML 永远 `MISS`(不缓存,保证发版即时生效)

### 完整的 `worker/src/index.ts`(改造后)

```ts
interface Env {
  ASSETS_BUCKET: R2Bucket
  API_ORIGIN?: string
  ENVIRONMENT: string
  CURRENT_VERSION: string
  DEPLOY_TIME: string
  CANARY_PERCENT: string
}

const CACHE_LONG = 'public, max-age=31536000, immutable'
const CACHE_SHORT = 'public, max-age=0, must-revalidate'

const LONG_CACHE_EXTENSIONS = [
  'js', 'css', 'woff', 'woff2', 'ttf', 'eot',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'map',
]

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env)
    }
    return handleStatic(request, env, ctx)
  },
}

async function handleStatic(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  let path = url.pathname
  if (path === '/') path = '/index.html'

  // 边缘缓存查询
  const cacheKey = new Request(url, request)
  const cache = caches.default
  if (request.method === 'GET') {
    const cached = await cache.match(cacheKey)
    if (cached) return cached
  }

  let object = await env.ASSETS_BUCKET.get(path.slice(1))
  const ext = path.split('.').pop()?.toLowerCase() || ''

  // SPA 回退
  if (!object && !LONG_CACHE_EXTENSIONS.includes(ext)) {
    object = await env.ASSETS_BUCKET.get('index.html')
  }
  if (!object) return new Response('Not Found', { status: 404 })

  const isHtml = ext === 'html' || path === '/index.html'

  let body: ReadableStream<Uint8Array> | string = object.body
  if (isHtml) {
    // HTML 注入动态配置
    const html = await object.text()
    const userId = getUserIdFromRequest(request)
    const inCanary = hashUserId(userId) % 100 < Number(env.CANARY_PERCENT || 0)
    body = html.replace(
      '</head>',
      `<script>window.__APP_CONFIG__=${JSON.stringify({
        env: env.ENVIRONMENT,
        version: env.CURRENT_VERSION,
        canary: inCanary,
        deployTime: env.DEPLOY_TIME,
      })};</script></head>`
    )
  }

  const response = new Response(body, { headers: buildHeaders(object, ext, isHtml) })

  // 静态资源写入边缘缓存
  if (request.method === 'GET' && !isHtml) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()))
  }

  return response
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === '/api/health') {
    return jsonResponse({ status: 'ok', env: env.ENVIRONMENT, ts: Date.now() })
  }
  if (path === '/api/version') {
    return jsonResponse({
      version: env.CURRENT_VERSION,
      deployTime: env.DEPLOY_TIME,
      canaryPercent: Number(env.CANARY_PERCENT || 0),
    })
  }
  if (env.API_ORIGIN) {
    const targetUrl = env.API_ORIGIN + path.replace('/api', '')
    return fetch(targetUrl, request)
  }
  return jsonResponse({ message: 'Not Found' }, 404)
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function getUserIdFromRequest(request: Request): string {
  const cookie = request.headers.get('Cookie') || ''
  const match = cookie.match(/user_id=([^;]+)/)
  return match ? match[1] : 'anon-' + Math.random().toString(36).slice(2)
}

function hashUserId(userId: string): number {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function buildHeaders(object: R2ObjectBody, ext: string, isHtml: boolean): Headers {
  const headers = new Headers()
  headers.set('Content-Type', getContentType(ext))
  if (isHtml || ext === 'html') {
    headers.set('Cache-Control', CACHE_SHORT)
    headers.set('Cache-Tag', 'html')
  } else if (LONG_CACHE_EXTENSIONS.includes(ext)) {
    headers.set('Cache-Control', CACHE_LONG)
    headers.set('Cache-Tag', 'static')
  } else {
    headers.set('Cache-Control', CACHE_SHORT)
  }
  if (object.httpEtag) headers.set('ETag', object.httpEtag)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  return headers
}

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    eot: 'application/vnd.ms-fontobject',
    map: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
  }
  return types[ext] || 'application/octet-stream'
}
```

### 完整的 `worker/wrangler.toml`(改造后)

```toml
name = "fe-depoly-edge"
main = "src/index.ts"
compatibility_date = "2026-06-01"

[[r2_buckets]]
binding = "ASSETS_BUCKET"
bucket_name = "fe-depoly-assets"
preview_bucket_name = "fe-depoly-assets"

[vars]
ENVIRONMENT = "production"
CURRENT_VERSION = "v1.0.0"
DEPLOY_TIME = "2026-06-25"
CANARY_PERCENT = "10"
# API_ORIGIN = "https://your-backend.example.com"
```

### CI/CD 调整

`.github/workflows/deploy-r2-worker.yml` 里 Worker 部署步骤不变,但建议把版本号和环境变量通过 CI 注入,而不是写死在 `wrangler.toml`:

```yaml
- name: Deploy Worker
  working-directory: worker
  run: |
    npm ci
    npx wrangler deploy --var CURRENT_VERSION:${{ github.sha }} --var DEPLOY_TIME:$(date -u +%Y-%m-%dT%H:%M:%SZ)
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

这样每次部署版本号自动是 git commit SHA,部署时间是构建时间,不用手动改 `wrangler.toml`。

### 前端改造(`src/App.tsx` 完整版)

```tsx
import * as Sentry from '@sentry/react'
import { useState } from 'react'
import './App.css'

declare global {
  interface Window {
    __APP_CONFIG__?: {
      env: string
      version: string
      canary: boolean
      deployTime: string
    }
  }
}

function App() {
  const [count, setCount] = useState(0)
  const [apiResult, setApiResult] = useState('')
  const config = window.__APP_CONFIG__

  const triggerError = () => {
    throw new Error('Test error for Sentry')
  }

  const callApi = async () => {
    const res = await fetch('/api/version')
    const data = await res.json()
    setApiResult(JSON.stringify(data))
  }

  return (
    <Sentry.ErrorBoundary
      fallback={<div style={{ padding: 20 }}>页面出错了,请刷新重试</div>}
    >
      <div className="app">
        <header className="app-header">
          <h1>FE Deploy {config?.canary ? '(Canary)' : ''}</h1>
          <p>前端工程化实践项目 · 混合部署</p>
          <p>
            Version: {config?.version} · Env: {config?.env} · Deploy: {config?.deployTime}
          </p>
        </header>
        <main className="app-main">
          <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
          <button onClick={triggerError}>Trigger Error</button>
          <button onClick={callApi}>Call BFF</button>
          <p>BFF Response: {apiResult}</p>
        </main>
      </div>
    </Sentry.ErrorBoundary>
  )
}

export default App
```

### 改造后的完整架构

```
用户访问 https://app.example.com
    │
    ▼
Cloudflare 边缘节点
    │
    ├─ /assets/*  ──> Worker ──> 查边缘缓存 ──> R2(静态资源)
    │                   └─ 边缘缓存命中 → 直接返回(跳过 R2)
    │
    ├─ /api/*     ──> Worker ──> BFF 逻辑 / 反代后端
    │                   └─ /api/health, /api/version 等内置端点
    │
    └─ /*         ──> Worker ──> R2(index.html)
                        └─ 注入 window.__APP_CONFIG__(灰度标识、版本、环境)
                            然后返回 HTML(短缓存,max-age=0)
```

三层分流,Worker 承担:路由 + 缓存 + BFF + 灰度注入,完全在 Cloudflare 边缘完成,无额外基础设施。

### 验收清单

改造完成后逐项验证:

**路径分流**
- [ ] `https://app.example.com/` 正常显示 SPA
- [ ] `https://app.example.com/assets/index-xxxx.js` 返回 JS(`Cache-Control: max-age=31536000`)
- [ ] `https://app.example.com/index.html` 返回 HTML(`Cache-Control: max-age=0, must-revalidate`)
- [ ] `https://app.example.com/api/health` 返回 `{"status":"ok",...}`
- [ ] `https://app.example.com/api/version` 返回版本信息
- [ ] `https://app.example.com/nonexistent` 回退到 `index.html`(SPA 路由)
- [ ] `https://app.example.com/nonexistent.js` 返回 404(静态资源不回退)

**动态注入**
- [ ] `curl https://app.example.com/` 返回的 HTML 含 `<script>window.__APP_CONFIG__=...</script>`
- [ ] 不同 `user_id` Cookie 的 `canary` 值不同(按哈希分流)
- [ ] 前端能读到 `window.__APP_CONFIG__`,显示版本和灰度标识

**边缘缓存**
- [ ] 静态资源二次访问 `CF-Cache-Status: HIT`
- [ ] HTML 二次访问 `CF-Cache-Status: MISS`(不缓存)
- [ ] API 响应不缓存(每次都执行 BFF 逻辑)

**BFF**
- [ ] 点 "Call BFF" 按钮能拿到 `/api/version` 响应
- [ ] BFF 响应包含 CI 注入的 `CURRENT_VERSION` 和 `DEPLOY_TIME`

**CI/CD**
- [ ] `git push main` 触发 workflow
- [ ] 静态资源同步到 R2
- [ ] Worker 部署成功,版本号 = git SHA
- [ ] 部署后访问 `/api/version` 返回新版本号

### 改造的收益

| 能力 | 改造前 | 改造后 |
|------|--------|--------|
| 路径分流 | ❌ 全走 R2 | ✅ /assets /api /  分流 |
| 边缘缓存 | ❌ 每次回源 R2 | ✅ 静态资源边缘缓存 |
| BFF | ❌ 无 | ✅ Worker 跑轻量 API |
| 灰度注入 | ❌ 无 | ✅ HTML 注入灰度标识 |
| 动态内容 | ❌ 纯静态 HTML | ✅ HTML 含动态配置 |
| 版本可观测 | ❌ 看不到 | ✅ 前端显示版本+部署时间 |

### 后续演进方向

改造完成后再往下走:

1. **接真实后端**:在 `wrangler.toml` 配 `API_ORIGIN`,Worker 把 `/api/*` 反代到真实后端服务
2. **加 KV / D1**:Worker 用 KV 做配置中心、D1 做轻量数据库,实现特性开关
3. **加鉴权**:Worker 在边缘校验 JWT,失败直接 401,不回源
4. **真 SSR**:Worker 把 `/*` 从 R2 切到 Cloudflare Pages Functions 或外部 Node 服务
5. **多环境**:Preview / Staging / Production 用不同 Worker,通过环境变量区分

每步都是渐进式,不需要推翻重来。

### 改造的安全网

每阶段独立验证,跑不通就回滚到上一阶段:

| 阶段 | 风险 | 回滚方式 |
|------|------|---------|
| 阶段一:路径分流 | API 路由错把静态资源也劫持 | Worker 代码回滚到上一版,`wrangler deploy` 上一 commit |
| 阶段二:加 BFF | BFF 逻辑有 bug | 把 `handleApi` 改回返回 501,前端按钮临时禁用 |
| 阶段三:HTML 注入 | 注入逻辑破坏 HTML | 跳过注入分支,直接返回 `object.body` |
| 阶段四:边缘缓存 | 缓存了不该缓存的 | 跳过 `cache.put` 逻辑,改成 `cache.delete` 清缓存 |

Worker 部署是秒级回滚(`wrangler deploy` 上一版本),CI 失败不影响线上(旧版本继续服务),改造风险可控。

### 小结

本项目的混合部署改造核心:**Worker 从单纯的路由器升级为边缘网关**,承担路径分流、BFF、灰度注入、边缘缓存四项职责。改造分 4 个阶段,每阶段独立可验证,不需要引入新基础设施,完全在 Cloudflare 一套搞定。

改造完成后,本项目就是完整的混合部署沙盘:**静态资源走 R2+CDN、API 走 Worker BFF、HTML 走 R2 但被 Worker 动态注入**——对应企业级架构里的 OSS+CDN + 网关 + 边缘 SSR 的角色划分,只是规模更小、成本更低,适合学习。
