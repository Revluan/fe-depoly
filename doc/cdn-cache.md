# 前端部署两种模式对比:自托管 Docker vs OSS/CDN

## 模式一:服务器 + Docker + 域名(自托管)

### 架构

```
用户 ──> 域名(DNS 解析)──> 服务器外网 IP:80/443
                                  │
                                  ▼
                            Nginx 容器(监听 80)
                                  │
                                  ▼
                            静态文件(dist/)
```

### 部署步骤

1. 服务器上 `docker run -d -p 80:80 my-frontend:v1`
2. 域名服务商配置 A 记录:`example.com → 服务器外网 IP`
3. (可选)Nginx 配置 HTTPS(Let's Encrypt 免费证书)
4. 用户访问域名 → DNS 解析到 IP → Nginx 返回静态文件

### 适用场景

- **需要 SSR / BFF / API 代理**:容器里能跑 Node 服务,Nginx 能反代后端
- **内网环境 / 私有部署**:公司机房、政企客户、私有云,资源不出公网
- **灰度 / 蓝绿 / 多版本并存**:容器化便于切流量、回滚(见 `docker-depoly.md`、`gray-depoly.md`)
- **强定制需求**:Nginx 改配置、加 WAF、加日志采集、加鉴权,都自己控制
- **流量小且稳定**:中小项目,单机够用,不想引入更多云服务

### 优点

- 完全可控,从镜像到 Nginx 到证书都是自己的
- 不依赖对象存储服务,不存在"OSS 欠费 / 限流 / 跨区访问慢"问题
- 一次镜像构建,任意环境(docker-compose、k8s、裸机)都能跑
- 改配置秒级生效(`nginx -s reload`),不用等 CDN 缓存刷新

### 缺点

- **带宽是瓶颈**:大文件(JS bundle、图片)占服务器出口带宽,高并发时扛不住
- **需要运维**:服务器、Docker、Nginx、证书、监控、防火墙都得自己管
- **全球用户慢**:单机房,海外访问延迟高,没有边缘加速
- **成本随流量线性涨**:服务器带宽费 + 流量费,流量大时比 CDN 贵
- **单点风险**:服务器宕机就全挂(除非上负载均衡 + 多机)

---

## 模式二:OSS / S3 + CDN(托管静态资源)

### 架构

```
用户 ──> CDN 边缘节点(全球几百个)
              │ (缓存未命中时回源)
              ▼
         OSS / S3 Bucket(存储 dist/)
              ▲
              │ 上传(构建后)
         CI/CD 流水线
```

### 部署步骤

1. `npm run build` 产出 `dist/`
2. 把 `dist/` 同步到 OSS Bucket(如 `aliyun oss cp -r dist/ oss://bucket/ --recursive`)
3. 开启 Bucket 静态网站托管(默认首页 `index.html`、默认 404)
4. CDN 控制台添加加速域名,源站指向 OSS Bucket
5. 域名 DNS CNAME 到 CDN 分配的域名
6. 用户访问 → 命中边缘节点 → 缓存有就直接返回,没有就回源 OSS

### 适用场景

- **纯静态站点**:文档站、博客、营销页、SPA(React/Vue build 产物)
- **流量大 / 全球用户**:CDN 边缘节点就近返回,降低延迟
- **不想运维服务器**:没有 SSR、没有 API,要服务器纯属浪费
- **突发流量**:CDN 自动扛峰值,OSS 不抖,服务器不会被打挂
- **成本敏感**:小流量基本免费(Cloudflare Pages / Vercel 免费额度足够个人项目)

### 优点

- **全球加速**:用户就近访问边缘节点,延迟低
- **无限带宽(几乎)**:CDN 分摊流量,单点不会被压垮
- **零运维**:不用管服务器、证书、Nginx,云厂商全包
- **便宜**:小流量免费额度内,大流量单价也比服务器带宽便宜
- **高可用**:OSS 多副本 + CDN 多节点,单点故障不影响整体

### 缺点

- **只适合静态**:SSR / 后端 API 还得另找地方跑
- **缓存刷新有延迟**:改了文件,CDN 边缘缓存可能要几分钟才过期(可手动刷新)
- **依赖云厂商**:服务可用性、计费、限流策略都受制于人
- **国内 OSS + 国外 CDN 跨境慢**:需要选同一云厂商或合适的源站位置
- **配置项多**:Bucket ACL、CDN 缓存规则、HTTPS 证书、CORS、SPA 回退都得配
- **国内域名需 ICP 备案**:阿里云 OSS + 域名要备案;Cloudflare 不需要但国内访问慢

---

## 对比表

| 维度 | Docker 自托管 | OSS + CDN |
|------|--------------|-----------|
| 适合内容 | 静态 + 动态(SSR/API) | 纯静态 |
| 全球加速 | ❌ 单机房 | ✅ 边缘节点 |
| 运维复杂度 | 高(服务器+Docker+Nginx+证书) | 低(配云服务即可) |
| 成本(小流量) | 服务器固定费 | 免费额度内 0 元 |
| 成本(大流量) | 带宽费贵 | CDN 流量费便宜 |
| 高并发 | 受服务器带宽限制 | CDN 扛得住 |
| 可控性 | 高 | 低(受云厂商限制) |
| 回滚 | 切镜像 / 切容器 | 切 OSS 文件版本 |
| 灰度 / 蓝绿 | 容易(多容器 + Nginx) | 较难(CDN 权重 / 路径分流) |
| 国内合规 | 自由 | OSS 域名需备案 |
| 上手门槛 | 中(要懂 Docker/Nginx) | 低(但概念多:Bucket/CDN/CNAME) |

---

## 选型建议

### 用 Docker 自托管,如果:

- 项目有 Node 服务(SSR、BFF、WebSocket)
- 给政企 / 内网客户部署,资源不能出公网
- 需要灰度、蓝绿、A/B 测试(容器切换最方便)
- 已经有服务器在跑别的服务,顺手部署
- 想完整学习部署链路(Docker → Nginx → DNS → HTTPS),作为学习项目

### 用 OSS + CDN,如果:

- 纯 SPA / 文档站 / 博客 / 营销页
- 用户分布广(全球或全国),要就近访问
- 不想运维服务器,只想要个能访问的网址
- 流量大或可能有突发流量(活动页、爆款文章)
- 成本敏感,小项目想白嫖免费额度

### 本项目(`fe-depoly`)的实际选择

这个学习项目把两种都做了一遍:

- **Docker 自托管**(`doc/docker-depoly.md`):服务器跑 Nginx 容器,域名解析到 IP,完整链路自己控制
- **OSS + CDN**(`doc/oss-depoly.md`):dist/ 上传阿里云 OSS,挂 Cloudflare CDN(阿里云 CDN 要备案,Cloudflare 不用)

学习目的下两种都值得做一遍,理解差异;生产项目按上面的选型建议选一种即可。

### 常见组合

实际生产中常见的是**混合模式**:

- 静态资源(JS/CSS/图片)走 OSS + CDN,享受边缘加速
- HTML 走服务器(便于灰度、A/B、动态注入)
- API 走服务器 / Serverless

这也是为什么大型项目通常不是"二选一",而是按资源类型分别走不同链路。


---

## 企业级 C 端项目(百万用户)部署方案

大型 C 端项目(百万用户、登录、多功能)的部署不是单一模式,而是**分层架构**。核心思路:静态资源走 CDN,HTML 走 SSR/边缘,API 走网关+服务集群,登录态在边缘或网关校验。

### 整体架构

```
用户 ──> CDN 边缘节点(全球几百个)
              │
              ├─ 静态资源(JS/CSS/图片/字体) ──> OSS/S3(hash 文件名,长缓存)
              ├─ HTML 入口 ──> SSR 容器集群 / Edge Function(注入登录态)
              ├─ API 请求 ──> API 网关 ──> 后端微服务集群
              │
              └─ 图片处理(裁剪/压缩/格式转换)在 CDN 边缘完成
```

### 分层详解

#### 1. 静态资源:OSS + CDN(必须)

- JS/CSS/图片/字体 全部上传 OSS,挂 CDN
- 文件名带 content hash(`app.3a7f9b.js`),设 1 年长缓存
- `index.html` 不缓存或短缓存(几秒~几分钟),保证发版即时生效
- 图片用 CDN 图片处理参数按需出图(`?x-oss-process=image/resize,w_200`)

**为什么**:百万用户 = 高并发 + 全球分布,单机房带宽扛不住。CDN 边缘节点就近返回,源站几乎零压力。

#### 2. HTML 入口:SSR 容器集群

C 端有登录态,纯 SPA 首屏体验差(白屏 + 客户端再请求),通常选 SSR:

| 方案 | 适用 | 登录态处理 |
|------|------|-----------|
| 纯 SPA + CDN | 简单应用 | 客户端读 token,首屏白屏 |
| SSR(Node 容器集群) | SEO + 首屏 + 登录态注入 | 服务端读 cookie,渲染时注入用户信息 |
| Edge SSR(Cloudflare Workers / Vercel Edge) | 全球低延迟 | 边缘节点跑轻量 SSR |

百万用户 C 端一般选 **SSR + 容器集群**(K8s),部署在多区域(华东 + 华北 + 海外),每区域多副本,前面挂 LB。Next.js / Nuxt 是主流选择。

#### 3. API:网关 + 微服务

- API 网关(APISIX / Kong / 阿里云 API 网关)统一入口
- 鉴权、限流、熔断、灰度在网关做
- 后端按业务拆微服务(用户、订单、内容…)
- 前端→API 走 HTTPS,网关→服务走内网

#### 4. 登录态:JWT + Refresh Token + Redis

- Access Token 短期(15 分钟),放 HttpOnly Cookie
- Refresh Token 长期(7 天),服务端存 Redis
- 网关或边缘节点做 Token 校验,失败回源刷新
- **不要放 localStorage**:XSS 风险

#### 5. 多区域 + 容灾

- 国内:华东 + 华北双区域,DNS 智能解析就近接入
- 海外:香港 / 新加坡 / 美西,按用户地理分布
- 数据库主从同步,跨区域只读副本
- 故障切换:DNS 健康检查,单区域挂了自动切备用

#### 6. 发布策略

- **金丝雀发布**:新版本先放 1% 流量,观察指标再放量
- **前端独立发布**:静态资源先上 CDN,HTML 后切,回滚只切 HTML
- **特性开关(Feature Flag)**:上线 ≠ 打开,运营/产品控制
- **灰度按用户 ID 哈希**:不要按时间,避免同一用户在新旧版本间反复跳

#### 7. 监控

- 前端 RUM:Sentry / 阿里 ARMS,采集首屏、白屏、JS 错误
- 后端 APM:SkyWalking / Jaeger,链路追踪
- 日志:ELK / Loki
- 业务大盘:QPS、错误率、登录成功率

### 技术选型参考

| 层 | 国内方案 | 海外方案 |
|----|---------|---------|
| CDN | 阿里云 CDN / 腾讯云 CDN | Cloudflare / Akamai |
| 对象存储 | 阿里云 OSS / 腾讯云 COS | AWS S3 / Cloudflare R2 |
| 容器编排 | 阿里云 ACK(K8s) | AWS EKS / GKE |
| SSR 服务 | Node + Docker on K8s | Vercel / Cloudflare Pages |
| API 网关 | APISIX / Higress | Kong / AWS API Gateway |
| 数据库 | RDS MySQL / PolarDB | Aurora / PlanetScale |
| 缓存 | Redis 集群 | ElastiCache / Upstash |
| 监控 | ARMS / SLS | Sentry / Datadog |

### 几个反直觉的点

1. **不要把所有东西塞进 SSR**:静态资源就该走 CDN,SSR 只渲染 HTML 骨架,数据和资源分离
2. **index.html 是发布单元,不是缓存单元**:它要能快速更新,所以缓存短;静态资源要长缓存
3. **登录态别放 localStorage**:HttpOnly Cookie + CSRF Token 才安全
4. **图片走 CDN 处理,不要前端自己压缩**:原图传 OSS,CDN 按参数出各种尺寸
5. **灰度按用户 ID 哈希,不是按时间**:保证用户体验一致

### 落地顺序建议

从零搭的话,按这个顺序逐步推进,每步独立验证:

1. 纯静态资源走通(OSS + CDN + 域名 + HTTPS)
2. 加 SSR 容器集群(单区域多副本)
3. 接 API 网关 + 后端服务
4. 上监控(RUM + APM + 日志)
5. 加多区域 + 容灾
6. 加金丝雀发布流程
7. 加边缘函数(优化首屏 + 鉴权下沉)

不要一上来就上全套架构,每层都有成本和复杂度,按业务规模逐步加。

### 小结

**百万级 C 端 ≠ 单一部署模式,而是「CDN 静态资源 + SSR 容器集群 + API 网关 + 多区域容灾」的组合**。上面"混合模式"是这套架构的雏形,企业级只是把它放大、加固、加监控、加容灾。

---

## 实战:React SPA 全套上 Cloudflare(无备案)

针对本项目(`fe-depoly`,React 18 + Vite + SPA,域名未备案),整套流程都在 Cloudflare 上跑完。Cloudflare 在国内访问速度一般,但**不需要备案、免费额度足够、配置简单**,非常适合学习和小型项目。

### 总体方案

```
用户 ──> Cloudflare CDN(全球 300+ 边缘节点)
              │
              ├─ 静态资源(JS/CSS/图片) ──> R2 Bucket(对象存储,hash 文件名长缓存)
              ├─ index.html / SPA 路由 ──> Cloudflare Pages(自动部署 + 回退路由)
              ├─ 图片处理 ──> Cloudflare Image Resizing(按参数出图)
              └─ 后端 API(暂无) ──> 后续可用 Cloudflare Workers / 外部 API
```

### 方案选型:Pages 直连 vs R2 + CDN

Cloudflare 上部署 SPA 有两种方式,本项目选 **方式 A(Pages 直连)**,简单够用:

| 方式 | 静态资源 | 入口 HTML | 适用 |
|------|---------|----------|------|
| **A. Pages 直连**(推荐) | Pages 自带托管 | Pages 自带 | 个人项目、学习、中小 SPA |
| **B. R2 + Pages/Worker** | R2 Bucket | Pages/Worker | 资源量大、需要跨项目复用、想模拟 OSS+CDN 架构 |

方式 A 一个产品搞定部署+CDN+HTTPS+回退路由,免费额度(500 次/月构建、无限请求、100 万 Workers 调用/天)对学习项目完全够用。方式 B 适合想完整体验"OSS + CDN 分离"架构的情况,后续可以再升级。

### 前置准备

1. **Cloudflare 账号**:注册 https://dash.cloudflare.com(免费即可)
2. **域名**:已购买,且**域名 NS 已切到 Cloudflare**(在 Cloudflare 控制台 Add Site,按提示去注册商改 NS)
3. **本地环境**:
   - Node.js ≥ 20
   - 项目能 `npm run build` 正常出 `dist/`
4. **GitHub 仓库**:代码已推到 GitHub(用于自动部署)

### 步骤一:本地构建验证

先确认本地构建产物正常,SPA 路由有回退到 `index.html` 的能力。

```bash
# 1. 本地构建
npm run build

# 2. 本地预览(模拟生产环境)
npm run preview
# 访问 http://localhost:4173,测试刷新子路由(如 /about)是否 404
```

Vite 默认 `preview` 不带 SPA 回退,生产环境由 Cloudflare Pages 处理(见步骤二)。如果本地子路由刷新 404,不用担心,Pages 会自动回退。

### 步骤二:Cloudflare Pages 部署(手动 + CLI)

#### 2.1 通过 Wrangler CLI 部署(推荐,可脚本化)

```bash
# 1. 安装 Wrangler
npm i -D wrangler

# 2. 登录(浏览器授权)
npx wrangler login

# 3. 首次部署(创建项目)
npx wrangler pages deploy dist --project-name=fe-depoly

# 输出会得到一个 https://fe-depoly.pages.dev 的域名,立即可访问
```

#### 2.2 通过 Git 集成自动部署(推荐长期使用)

1. 进入 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 授权 GitHub,选择仓库 `fe-depoly`
3. 配置构建:
   - **Framework preset**: Vite
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Node version**(环境变量): `NODE_VERSION = 20`
4. 点 **Save and Deploy**,首次构建完成后拿到 `*.pages.dev` 域名

之后每次 `git push main` 自动触发部署,PR 还能生成预览环境(`*.preview.pages.dev`)。

### 步骤三:绑定自定义域名

`*.pages.dev` 在国内**不稳定**(被墙概率高),必须绑自定义域名。

1. **Cloudflare Dashboard → 选中你的 Pages 项目 → Custom domains → Set up a custom domain**
2. 输入域名(如 `app.example.com`),Cloudflare 自动加 CNAME 记录指向 Pages
3. **因为域名 NS 已在 Cloudflare**,DNS 和 SSL 证书全自动配置,无需手动操作
4. 等 1~2 分钟,证书签发完成,访问 `https://app.example.com` 即可

**关键点**:
- 域名 NS 必须在 Cloudflare,否则要手动改 DNS 并自行处理证书
- SSL/TLS 模式选 **Full (strict)**(Pages 默认就是)
- 不要开 "Always Use HTTPS" 之外的额外选项,避免踩坑

### 步骤四:缓存策略配置

SPA 的缓存核心是 **静态资源长缓存 + HTML 短缓存**。Cloudflare Pages 默认行为已经接近最优,但建议显式调整。

#### 4.1 静态资源(默认已 OK)

Vite 构建产物 `assets/*.js`、`assets/*.css` 都带 hash,Pages 默认给长缓存(`Cache-Control: public, max-age=31536000, immutable`),无需额外配置。

#### 4.2 index.html(需要短缓存)

默认 Pages 对 HTML 给的是 `Cache-Control: public, max-age=0, must-revalidate`,每次都回源检查,**已经正确**,无需改动。

#### 4.3 自定义缓存规则(可选,Dashboard 配)

**Cloudflare Dashboard → 域名 → Caching → Cache Rules**,可加规则:

| 规则名 | 匹配 | 动作 |
|--------|------|------|
| 静态资源长缓存 | `URI Path starts with /assets/` | Edge TTL: 1 year, Browser TTL: 1 year |
| HTML 不缓存 | `URI Path equals / or /index.html` | Edge TTL: 1 minute, Browser TTL: 0 |
| 图片/Web 字体 | `URI Extension in {png, jpg, webp, woff2}` | Edge TTL: 1 month |

**注意**:Pages 自带的托管资源走 Pages 内部缓存,Cache Rules 主要影响**回源到 R2/外部**的资源。纯 Pages 项目一般不用动。

### 步骤五:SPA 路由回退

SPA 刷新子路由(如 `/users/123`)不能 404,必须回退到 `index.html`。

#### Cloudflare Pages 自动处理

Pages 默认配置了 SPA 回退:**所有未匹配静态文件的请求都返回 `index.html`**,无需额外配置。

#### 验证

部署后访问 `https://app.example.com/some/deep/route`,刷新页面,应该正常显示 SPA(不会 404)。

#### 自定义回退(可选)

如果需要更精细控制(如 API 路径不走回退),在项目根加 `_redirects` 文件:

```
# public/_redirects(Vite 项目放在 public/ 下,构建时复制到 dist/)
/api/*  https://api.example.com/:splat  200
/*      /index.html                       200
```

- 第一行:API 请求反代到后端(200 表示代理,不是跳转)
- 第二行:其他所有路径回退到 `index.html`

### 步骤六:环境变量与构建配置

不同环境(dev/staging/prod)前端配置不同,通过 Pages 环境变量注入。

#### 6.1 Dashboard 配置

**Pages 项目 → Settings → Environment variables**,按环境(Production / Preview)分别配:

| 变量名 | Production | Preview |
|--------|-----------|---------|
| `NODE_VERSION` | 20 | 20 |
| `VITE_API_BASE_URL` | `https://api.example.com` | `https://api-staging.example.com` |
| `VITE_APP_ENV` | `production` | `staging` |

Vite 构建时会读取 `VITE_` 前缀变量注入到代码里。

#### 6.2 代码中使用

```ts
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
const isProd = import.meta.env.VITE_APP_ENV === 'production';
```

### 步骤七:GitHub Actions CI/CD(可选,替代 Pages 自带 Git 集成)

如果想自己控制 CI(跑测试、lint、再部署),用 GitHub Actions + Wrangler:

```yaml
# .github/workflows/deploy-cloudflare-pages.yml
name: Deploy to Cloudflare Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      deployments: write
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npm run lint
      - run: npm run type-check
      - run: npm run test
      - run: npm run build

      - name: Deploy to Cloudflare Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy dist --project-name=fe-depoly
```

**需要的 Secrets**(GitHub 仓库 Settings → Secrets and variables → Actions):

| Secret 名 | 来源 |
|-----------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" 模板,加上 `Cloudflare Pages: Edit` 权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard 右下角 Account ID |

### 步骤八:Cloudflare Web Analytics(免费 RUM)

替代 Google Analytics,免费、隐私友好、无 Cookie。

1. **Cloudflare Dashboard → 域名 → Analytics & Logs → Web Analytics → Enable**
2. 拿到 `data-site-token`,把官方给的 `<script>` 加到 `index.html`:

```html
<!-- index.html -->
<head>
  ...
  <!-- Cloudflare Web Analytics -->
  <script
    defer
    src="https://static.cloudflareinsights.com/beacon.min.js"
    data-site-token="你的token"
  ></script>
</head>
```

部署后可在 Cloudflare 看访问量、页面、来源国家等。

### 步骤九:后续可选升级

学习项目跑通后,可以按需加这些:

| 升级项 | 价值 | 复杂度 |
|--------|------|--------|
| **R2 + 自定义 Worker** | 模拟完整 OSS+CDN 架构,资源存 R2 | 中 |
| **Cloudflare Workers 做 BFF** | 边缘节点跑 API 代理、鉴权、聚合 | 中 |
| **Cloudflare Access** | 给内部环境加 SSO 鉴权 | 低 |
| **Cloudflare Image Resizing** | CDN 边缘按参数出图 | 低 |
| **Cloudflare KV / D1** | 边缘存储,做轻量后端 | 中 |
| **Sentry 接入** | JS 错误监控(比 Web Analytics 更细) | 低 |
| **多环境发布** | Preview 环境 + Production 环境隔离 | 低 |

### 验收清单

部署完成后,逐项验证:

- [ ] `https://app.example.com` 能访问,HTTPS 证书有效
- [ ] 刷新子路由(如 `/about`)不 404,正常回到 SPA
- [ ] 静态资源 Response Headers 含 `Cache-Control: ... max-age=31536000`
- [ ] `index.html` Response Headers 含 `Cache-Control: ... max-age=0`
- [ ] `git push main` 后自动触发部署,1~2 分钟内生效
- [ ] PR 触发 Preview 环境,生成 `*.preview.pages.dev` 链接
- [ ] Web Analytics 能看到访问数据
- [ ] 部署回滚:Pages → Deployments → 选历史版本 → Roll back to this deployment

### 常见坑

1. **`*.pages.dev` 国内打不开**:必须绑自定义域名,且域名 NS 在 Cloudflare
2. **构建失败 NODE_VERSION 错误**:Dashboard 显式设 `NODE_VERSION=20` 环境变量
3. **路由刷新 404**:Pages 默认有 SPA 回退,如果还 404 检查 `_redirects` 文件是否被覆盖
4. **环境变量不生效**:Vite 只注入 `VITE_` 前缀变量;构建时注入,运行时不存在
5. **部署后看不到新代码**:浏览器缓存了 `index.html`,强刷(Cmd+Shift+R)或等几分钟
6. **自定义域名证书签发慢**:最长 24 小时,通常几分钟;如果一直 Pending,检查 DNS 记录是否正确
7. **API 跨域**:前端在 `app.example.com`,API 在 `api.example.com`,后端要配 CORS;或用 `_redirects` 代理(见步骤五)

### 成本估算

本项目流量不大,基本免费:

| 项 | 免费额度 | 预估用量 |
|----|---------|---------|
| Pages 构建 | 500 次/月 | < 100 次 |
| Pages 请求 | 无限 | - |
| Pages 带宽 | 无限 | - |
| Workers | 10 万 次/天 | < 1 万 |
| R2(若用) | 10 GB 存储 + 100 万次/月 | 远低于 |
| Web Analytics | 无限 | - |

**结论:0 元**。除非上 Workers 付费版或 R2 大量存储,否则不会产生费用。

### 小结

本项目走 **Cloudflare Pages 直连 + 自定义域名 + Git 自动部署**,核心步骤:

1. 本地 `npm run build` 跑通
2. Wrangler / Git 集成部署到 Pages
3. 绑自定义域名(NS 在 Cloudflare,全自动)
4. 配环境变量 + `_redirects` SPA 回退
5. (可选)GitHub Actions 自控 CI
6. (可选)Web Analytics 接入

这套流程对未备案域名友好、零成本、足够学习用;后续要模拟企业级架构,再升级到 **R2 + Workers + 自定义缓存规则** 即可。

---

## 实战:方式 B — R2 + Worker 模拟完整 OSS+CDN 架构

方式 A(Pages 直连)已经实践过,现在走方式 B:**静态资源全部存 R2(对象存储),Worker 在边缘做请求路由 + 缓存控制 + SPA 回退**。这套架构对应企业级里的「OSS + CDN + 边缘网关」,把每个角色都拆出来,理解更完整。

### 架构对比

```
方式 A(Pages 直连):
  用户 ──> Cloudflare Pages(同时承担:静态托管 + CDN + 路由回退 + HTTPS)

方式 B(R2 + Worker):
  用户 ──> Cloudflare CDN(边缘缓存)
              │
              ▼
         Worker(边缘网关,负责路由 + 缓存策略 + 鉴权 + 回退)
              │
              ├─ 静态资源(JS/CSS/图片) ──> R2 Bucket(对象存储,长缓存)
              └─ index.html / SPA 路由  ──> R2 Bucket(短缓存 + 回退)
```

**方式 B 把"托管 / CDN / 网关"三件事拆开**,每层都能独立配置,更接近真实生产架构。代价是配置更复杂,需要写 Worker 代码。

### 方式 B 的价值

- **理解 OSS+CDN 架构**:R2 = OSS,Worker = 网关/反代,CDN = 边缘缓存,角色清晰
- **跨项目复用资源**:多个项目共享一个 R2 Bucket,按路径前缀区分
- **精细缓存控制**:Worker 可以按文件类型、路径、查询参数动态决定缓存策略
- **可扩展鉴权**:Worker 能在边缘做 Token 校验、签名校验,类似企业级网关
- **后续接 Workers KV / D1**:边缘存储做 BFF、AB 测试、特性开关都很方便

### 总体流程

```
1. 创建 R2 Bucket,上传 dist/
2. 写 Worker 代码(路由 + 缓存 + SPA 回退)
3. Worker 绑定 R2 Bucket
4. Worker 部署 + 自定义域名
5. CI/CD 自动化(可选)
6. 验证 + 调优
```

### 前置准备

- 已完成方式 A 的项目设置(域名 NS 在 Cloudflare、`npm run build` 正常)
- Cloudflare 账号已绑支付方式(R2 免费额度够用,但**开通 R2 需要绑卡**,不扣费)
- 安装 Wrangler:`npm i -D wrangler`

### 步骤一:开通 R2 并创建 Bucket

#### 1.1 开通 R2

1. **Cloudflare Dashboard → R2 → Get started**(首次需要绑支付方式,免费额度内不扣费)
2. 免费额度:**10 GB 存储 + 100 万次 A 类操作/月 + 1000 万次 B 类操作/月**,本项目远低于

#### 1.2 创建 Bucket

```bash
# 用 Wrangler 创建(也可以在 Dashboard 点)
npx wrangler r2 bucket create fe-depoly-assets
```

输出 `Created bucket fe-depoly-assets` 即成功。

#### 1.3 记录 Bucket 名

后续 Worker 代码和 CI 都要用到:
- Bucket 名:`fe-depoly-assets`
- 账号 ID:Cloudflare Dashboard 右下角

### 步骤二:本地构建并上传到 R2

#### 2.1 构建产物

```bash
npm run build
# 产出 dist/
```

#### 2.2 手动上传首次(验证)

**关键:wrangler 4.x 默认上传到本地模拟器,必须加 `--remote` 才会传到真实 R2。** 不加 `--remote` 会看到 `Resource location: local`,文件没进 R2。

```bash
# 单文件上传(注意 --remote)
npx wrangler r2 object put fe-depoly-assets/index.html --file=dist/index.html --remote
npx wrangler r2 object put fe-depoly-assets/favicon.ico --file=dist/favicon.ico --remote
```

**批量上传脚本**:

⚠️ **zsh 交互模式注意**:zsh 默认不开 `INTERACTIVE_COMMENTS`,脚本里的 `#` 注释会被当成命令执行(`zsh: command not found: #`),破坏变量赋值。解决方式二选一:

- 方式一:在 zsh 里先开注释支持 `setopt interactive_comments`,再跑脚本
- 方式二:把脚本存成 `.sh` 文件执行(`bash upload-r2.sh`),sh 文件里 `#` 天然是注释

把下面的内容存为 `scripts/upload-r2.sh`:

```bash
#!/usr/bin/env bash
# scripts/upload-r2.sh
# 批量上传 dist/ 到 R2 Bucket
# 用法: bash scripts/upload-r2.sh

set -e

BUCKET="fe-depoly-assets"
DIST_DIR="dist"

if [ ! -d "$DIST_DIR" ]; then
  echo "❌ $DIST_DIR 不存在,请先 npm run build"
  exit 1
fi

echo "📤 上传 $DIST_DIR/ 到 R2 Bucket: $BUCKET"
find "$DIST_DIR" -type f | while IFS= read -r f; do
  # 去掉 dist/ 前缀作为 R2 key
  key="${f#$DIST_DIR/}"
  echo "  → $key"
  npx wrangler r2 object put "$BUCKET/$key" --file="$f" --remote --content-type="$(guess_ct "$key")"
done
echo "✅ 上传完成"

guess_ct() {
  case "${1##*.}" in
    html) echo "text/html; charset=utf-8" ;;
    js|mjs) echo "application/javascript; charset=utf-8" ;;
    css) echo "text/css; charset=utf-8" ;;
    json) echo "application/json; charset=utf-8" ;;
    svg) echo "image/svg+xml" ;;
    png) echo "image/png" ;;
    jpg|jpeg) echo "image/jpeg" ;;
    gif) echo "image/gif" ;;
    webp) echo "image/webp" ;;
    ico) echo "image/x-icon" ;;
    woff) echo "font/woff" ;;
    woff2) echo "font/woff2" ;;
    map) echo "application/json; charset=utf-8" ;;
    *) echo "application/octet-stream" ;;
  esac
}
```

执行:

```bash
chmod +x scripts/upload-r2.sh
bash scripts/upload-r2.sh
```

**更推荐**:正式部署用 `rclone` 或 AWS CLI(S3 兼容 API)批量上传,速度快很多,见步骤五 CI/CD。

#### 2.3 验证上传

```bash
# 列出 Bucket 内容
npx wrangler r2 object list fe-depoly-assets --remote
```

或在 Dashboard → R2 → `fe-depoly-assets` 查看文件列表。

### 步骤三:写 Worker 代码

Worker 是核心,负责:接收请求 → 查 CDN 缓存 → 缓存未命中查 R2 → 设置缓存头 → SPA 回退。

#### 3.1 创建 Worker 项目

在项目根新建 `worker/` 目录:

```
fe-depoly/
├── worker/
│   ├── src/
│   │   └── index.ts
│   ├── wrangler.toml
│   └── package.json
├── dist/           # Vite 构建产物
└── ...
```

#### 3.2 `worker/wrangler.toml`

```toml
name = "fe-depoly-edge"
main = "src/index.ts"
compatibility_date = "2026-06-01"

# 绑定 R2 Bucket
# - bucket_name:      生产环境用的远端 Bucket
# - preview_bucket_name: 本地 dev / Preview 环境用的 Bucket(可以是同一个,但 wrangler 强制要求显式声明)
[[r2_buckets]]
binding = "ASSETS_BUCKET"
bucket_name = "fe-depoly-assets"
preview_bucket_name = "fe-depoly-assets"

# 自定义域名路由(部署后在 Dashboard 配,这里先注释)
# routes = [
#   { pattern = "app.example.com/*", custom_domain = true }
# ]

# 环境变量(可选)
[vars]
ENVIRONMENT = "production"
```

**关于 `preview_bucket_name`**:wrangler 3.x+ 强制要求,即使和 `bucket_name` 相同也要写。不写就会报错:

```
In development, you should use a separate r2 bucket than the one you'd use in production.
Please create a new r2 bucket with "wrangler r2 bucket create <name>" and add its name as preview_bucket_name to the r2_buckets "ASSETS_BUCKET" in your wrangler.toml file
```

学习项目可以两个名字相同(共用一个 Bucket);真实生产建议另开一个 preview bucket,避免本地调试污染线上数据。

#### 3.3 `worker/src/index.ts`

```ts
interface Env {
  ASSETS_BUCKET: R2Bucket;
  ENVIRONMENT: string;
}

// 静态资源长缓存(1 年),HTML 不缓存
const CACHE_LONG = 'public, max-age=31536000, immutable';
const CACHE_SHORT = 'public, max-age=0, must-revalidate';

// 需要长缓存的文件类型(hash 文件名才安全)
const LONG_CACHE_EXTENSIONS = [
  'js', 'css', 'woff', 'woff2', 'ttf', 'eot',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg',
  'ico', 'map',
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;

    // 1. 根路径 → index.html
    if (path === '/') path = '/index.html';

    // 2. 尝试从 R2 取对象
    let object = await env.ASSETS_BUCKET.get(path.slice(1));

    // 3. SPA 回退:对象不存在且不是静态文件 → 返回 index.html
    const ext = path.split('.').pop()?.toLowerCase() || '';
    if (!object && !LONG_CACHE_EXTENSIONS.includes(ext)) {
      object = await env.ASSETS_BUCKET.get('index.html');
      // 回退的响应用短缓存
      if (object) {
        return new Response(object.body, {
          headers: buildHeaders(object, ext, true),
        });
      }
    }

    // 4. 对象不存在 → 404
    if (!object) {
      return new Response('Not Found', { status: 404 });
    }

    // 5. 返回对象 + 缓存头
    return new Response(object.body, {
      headers: buildHeaders(object, ext, false),
    });
  },
};

function buildHeaders(object: R2ObjectBody, ext: string, isHtml: boolean): Headers {
  const headers = new Headers();

  // Content-Type
  headers.set('Content-Type', getContentType(ext));

  // 缓存策略:HTML 短缓存,静态资源长缓存
  if (isHtml || ext === 'html') {
    headers.set('Cache-Control', CACHE_SHORT);
    headers.set('Cache-Tag', 'html');
  } else if (LONG_CACHE_EXTENSIONS.includes(ext)) {
    headers.set('Cache-Control', CACHE_LONG);
    headers.set('Cache-Tag', 'static');
  } else {
    headers.set('Cache-Control', CACHE_SHORT);
  }

  // ETag(R2 对象自带)
  if (object.httpEtag) {
    headers.set('ETag', object.httpEtag);
  }

  // 安全头
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  return headers;
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
  };
  return types[ext] || 'application/octet-stream';
}
```

#### 3.4 `worker/package.json`

```json
{
  "name": "fe-depoly-edge",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240620.0",
    "typescript": "^5.5.0",
    "wrangler": "^3.60.0"
  }
}
```

#### 3.5 `worker/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

### 步骤四:本地开发 + 部署 Worker

#### 4.1 本地调试

**关键:本地 dev 默认读本地 R2 模拟器,不是远端**。如果本地 R2 里没文件,访问 `http://localhost:8787/` 会返回 `Not Found`(因为 Worker 取不到对象)。

两种解决方式:

**方式 A:本地 dev 直连远端 R2(推荐,简单)**

wrangler 4.x 用 `--remote` 让本地 Worker 读远端 R2:

```bash
cd worker
npm install
npx wrangler dev --remote
```

`--remote` 模式下 Worker 跑在本地,但 R2 绑定直连远端 Bucket,直接复用步骤二上传的文件,不用重复上传。

**方式 B:本地 dev 读本地 R2(完全离线)**

如果要在本地 R2 模拟器里也存一份,上传时**不要加 `--remote`**(默认就是 local):

```bash
# 注意:这是上传到本地模拟器,不是远端
npx wrangler r2 object put fe-depoly-assets/index.html --file=dist/index.html
npx wrangler r2 object put fe-depoly-assets/favicon.ico --file=dist/favicon.ico

# 或用脚本批量上传到 local
bash scripts/upload-r2.sh  # 注意:脚本里带 --remote,要先去掉
```

然后:

```bash
npx wrangler dev --local
```

本地 R2 数据存在 `worker/.wrangler/state/v3/r2/`,删了就要重传。

**推荐用方式 A(`--remote`)**,直接复用已经上传到远端的文件,不用维护两份数据。

#### 4.1.1 验证本地 dev

启动后访问:

| URL | 期望 |
|------|------|
| `http://localhost:8787/` | SPA 首页(从 R2 读 `index.html`) |
| `http://localhost:8787/index.html` | 同上 |
| `http://localhost:8787/assets/index-xxxx.js` | JS 文件(带 hash) |
| `http://localhost:8787/users/123` | SPA 回退到 `index.html` |
| `http://localhost:8787/nonexistent.js` | 404(静态资源不回退) |

如果 `/` 仍然 `Not Found`,按下面排查:

1. **R2 里到底有没有文件**:`npx wrangler r2 object list fe-depoly-assets --remote`,应看到 `index.html`
2. **dev 模式是不是 `--remote`**:看终端启动日志 `Using remote R2 bucket...`,如果是 `local` 说明没加 `--remote`
3. **Worker 绑定变量名**:`wrangler.toml` 里 `binding = "ASSETS_BUCKET"`,代码里 `env.ASSETS_BUCKET`,两者必须一致
4. **加日志调试**:在 Worker 代码 fetch 开头加 `console.log({ path, hasObject: !!object })`,终端会实时打印

#### 4.2 部署 Worker

```bash
npx wrangler deploy
```

输出会得到一个 `https://fe-depoly-edge.<account>.workers.dev` 域名,可临时访问验证。

#### 4.3 绑定自定义域名

**Cloudflare Dashboard → Workers & Pages → 选中 `fe-depoly-edge` → Settings → Domains & Routes → Add → Custom Domain**

输入 `app.example.com`,Cloudflare 自动:
- 创建 DNS 记录(自定义域名模式,不走 CNAME)
- 签发 SSL 证书
- 把请求路由到 Worker

**注意**:Worker 自定义域名用的是 `custom_domain = true` 模式,请求直接到 Worker,不经过 Pages。

### 步骤五:CI/CD 自动化(推荐)

每次 `git push main`,自动构建 + 上传 R2 + 部署 Worker。用 GitHub Actions。

#### 5.1 R2 S3 兼容 API 凭证

R2 支持 S3 API,用 AWS CLI 同步文件比 wrangler 快很多。

**详细操作路径**(Cloudflare Dashboard 界面会调整,以实际为准,核心是找 R2 的 API Token 管理页):

1. 登录 https://dash.cloudflare.com
2. 左侧菜单点 **R2 Object Storage**(若没开通会显示 Get started)
3. 进入 R2 总览页后,**点右侧的 "Manage R2 API Tokens"**(在 R2 总览页右上角,不是 Bucket 内的 Settings)
   - 旧版界面:R2 总览页 → 右上角 "Manage API Tokens"
   - 新版界面:R2 总览页 → 点 **"API"** 标签或 **"Manage API Tokens"** 链接
4. 点 **Create API token**
5. 配置:
   - **Token name**:随意,如 `fe-depoly-ci`(仅用于识别,不影响凭证)
   - **Permissions**:选 **Object Read & Write**(读+写)
   - **Specify bucket**:选 **Apply to specific buckets only** → 勾选 `fe-depoly-assets`(限制 token 只能操作这个 Bucket,安全)
   - **TTL**:默认永不过期,或按需设过期时间
6. 点 **Create API Token**
7. **关键:创建后只显示一次,务必当场复制保存**:
   - **Access Key ID**(20 位字符,形如 `a1b2c3d4e5f6g7h8i9j0`)
   - **Secret Access Key**(40 位字符,只显示这一次,关掉就再也看不到)
   - **Endpoint**(形如 `https://<account_id>.r2.cloudflarestorage.com`,account_id 是 32 位 hex)
   - **Jurisdiction**(区域,通常是 `default`,特殊场景才有 `eu` / `fedramp`)

**保存后立即填到 GitHub Secrets**:

| GitHub Secret | 填什么 |
|--------------|--------|
| `R2_ACCESS_KEY_ID` | Access Key ID |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key |
| `R2_ENDPOINT` | Endpoint,如 `https://abcd1234.r2.cloudflarestorage.com` |

#### 5.1.1 找不到 "Manage API Tokens" 入口?

Cloudflare 改版后入口名称和位置不稳定,如果按上面找不到,试这几个方法:

1. **直接访问** `https://dash.cloudflare.com/?to=/:account/r2/api-tokens`(替换 `:account`)
2. **R2 总览页**按 `Cmd+F` 搜 "API",通常能定位
3. **Bucket 内** → Settings → 也有 S3 API Endpoint 显示,但创建 Token 的入口在**账户级**(不在 Bucket 内)
4. **My Profile → API Tokens → Create Token** 也可以创建 R2 token,但走 R2 专门的入口权限更清晰

#### 5.1.2 Secret 丢了怎么办

Secret Access Key **只显示一次**,关掉弹窗就再也看不到。如果忘了或丢了:

- 回到 R2 API Tokens 列表,**删除旧 token**
- **重新创建一个**,把新 Access Key ID + Secret 填到 GitHub Secrets
- 旧 token 删除后立即失效,CI 用旧凭证会 403

不会影响已经上传到 R2 的文件,token 只是访问凭证。

#### 5.2 GitHub Actions 配置

新增 `.github/workflows/deploy-r2-worker.yml`:

```yaml
name: Deploy to R2 + Worker

on:
  push:
    branches: [main]
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
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npm run lint
      - run: npm run type-check
      - run: npm run build

      # 同步 dist/ 到 R2(--delete 清理旧文件)
      - name: Sync to R2
        run: |
          aws s3 sync dist/ s3://fe-depoly-assets/ \
            --delete \
            --cache-control "public, max-age=31536000, immutable" \
            --exclude "index.html" \
            --endpoint-url "$AWS_ENDPOINT_URL"
          # index.html 单独上传,短缓存
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

#### 5.3 GitHub Secrets

仓库 Settings → Secrets and variables → Actions,加:

| Secret | 来源 |
|--------|------|
| `R2_ACCESS_KEY_ID` | R2 S3 API Token 的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | R2 S3 API Token 的 Secret |
| `R2_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens → Edit Cloudflare Workers 模板 |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard 右下角 |

#### 5.4 关于 `--delete` 的注意

`aws s3 sync --delete` 会删除 R2 里不在本地 dist/ 的文件。**风险点**:

- 旧版本静态资源(hash 文件名)会被删掉 → 正在用旧版本 HTML 的用户加载子资源会 404
- 解决:HTML 和静态资源**分批发布**——先传新静态资源,等几分钟旧 HTML 过期,再传新 HTML(参考步骤七)

CI 里简化版可以不开 `--delete`,但 R2 会累积旧文件,需要定期清理(或用 R2 生命周期规则自动删除 30 天前的 `assets/*`)。

### 步骤六:CDN 缓存调优

Worker 设置的 `Cache-Control` 头会指导 Cloudflare CDN 边缘缓存,但**默认情况下 Worker 的响应不会自动被 CDN 缓存**——需要显式用 Cache API。

#### 6.1 让 Worker 响应被 CDN 缓存(可选优化)

修改 `worker/src/index.ts`,加边缘缓存:

```ts
// 在 fetch 函数开头加一个 cacheKey
const cacheKey = new Request(url, request);
const cache = caches.default;

// 1. 先查边缘缓存(只缓存 GET 请求)
if (request.method === 'GET') {
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
}

// ... 原来的 R2 读取逻辑 ...

const response = new Response(object.body, {
  headers: buildHeaders(object, ext, isHtml),
});

// 2. 把响应写入边缘缓存(HTML 不缓存,静态资源缓存 1 年)
if (request.method === 'GET' && !isHtml) {
  response.headers.set('Cache-Control', CACHE_LONG);
  // ctx.waitUntil(cache.put(cacheKey, response.clone()));
  // 注意:put 后原始 response 不能再读 body,要用 clone
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
}

return response;
```

**Worker 函数签名也要改**,加上 `ctx: ExecutionContext`:

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ...
  },
};
```

#### 6.2 何时该用边缘缓存

- **不用**:R2 本身已经很快,Worker→R2 内网调用延迟 < 5ms,小流量项目边缘缓存收益不大
- **用**:流量大、静态资源被高频访问,边缘缓存能省 R2 B 类操作次数(计费项)

学习项目可以先不加边缘缓存,跑通后再加,对比效果。

#### 6.3 Dashboard 缓存规则(替代方案)

不想改 Worker 代码的话,用 **Dashboard → 域名 → Caching → Cache Rules** 配:

| 规则 | 匹配 | 动作 |
|------|------|------|
| 静态资源 | `URI Path starts with /assets/` | Edge TTL: 1 year |
| HTML | `URI Path equals / or /index.html` | Edge TTL: 1 min,Bypass cache on origin error |

效果类似,但灵活度不如 Worker 代码。

### 步骤七:发布策略(避免新旧版本错位)

SPA 发版时,如果先传新 HTML、再传新静态资源,会出现:

1. 用户加载新 HTML → 引用新 hash 的 JS
2. 新 JS 还没传到 R2 → 404
3. 用户白屏

**正确顺序**:

1. **先传新静态资源**(JS/CSS 到 R2,此时没人引用,无影响)
2. **等 1~2 分钟**(全球 R2 节点同步)
3. **再传新 index.html**(用户开始用新版本)
4. **等旧 HTML 缓存过期**(几分钟,期间旧用户继续用旧版本,新用户用新版本)
5. **(可选)清理旧静态资源**(`--delete` 或生命周期规则)

CI 里实现:把 `index.html` 单独上传步骤,加 `sleep 60` 或拆成两个 job。

### 步骤八:SPA 路由回退验证

部署后测试:

1. 访问 `https://app.example.com/` → 正常显示
2. 访问 `https://app.example.com/users/123` → 应该回到 SPA(不是 404)
3. 访问 `https://app.example.com/nonexistent.js` → 应该 404(不能回退到 HTML,否则会污染 MIME 类型)

Worker 代码里已经处理:`LONG_CACHE_EXTENSIONS` 之外的路径找不到才回退 HTML,静态资源找不到直接 404。

### 步骤九:常见坑

1. **R2 对象 key 没去掉 `dist/` 前缀**:
   - 错误:`dist/index.html`
   - 正确:`index.html`
   - `aws s3 sync dist/ s3://bucket/` 自动去掉前缀,`wrangler r2 object put bucket/dist/index.html` 会带前缀

2. **Worker 读不到 R2 对象**:
   - 检查 `wrangler.toml` 里 `binding` 和代码里用的变量名一致
   - 检查 `bucket_name` 拼写
   - 本地 dev 用 `--local` 才能读本地 R2,默认读远端会报权限错

3. **CDN 缓存了旧 HTML**:
   - HTML 响应头必须是 `max-age=0, must-revalidate`
   - 改了 HTML 不生效,Dashboard → Caching → Purge → Purge Everything(慎用)或按 URL 刷

4. **静态资源 404 但 R2 里有**:
   - 检查 Worker 路由是否覆盖了该路径(`/*` 通配符)
   - 检查 Worker 代码里的 path 处理逻辑(开头的 `/` 要 slice 掉)

5. **自定义域名 502**:
   - Worker 部署失败,查 `wrangler deploy` 输出
   - Worker 代码语法错,本地 `wrangler dev` 调试
   - R2 绑定没生效,Dashboard → Worker → Settings → Bindings 检查

6. **`aws s3 sync` 报错 region**:
   - R2 用 `--region auto` 和 `--endpoint-url`,不要用真实 AWS region
   - 必须 `AWS_ENDPOINT_URL` 环境变量或 `--endpoint-url` 参数

7. **Content-Type 错误**:
   - 上传时没指定 content-type,R2 默认 `application/octet-stream`,浏览器拒绝执行
   - 用 `aws s3 cp --content-type` 或 `wrangler r2 object put --content-type` 显式指定
   - Worker 代码里 `getContentType` 函数兜底(推荐,不依赖上传时的设置)

8. **Worker 内存/ CPU 超限**:
   - Worker CPU 时间限制:免费版 10ms / 付费版 50ms(单请求)
   - R2 大对象流式返回不占 CPU,但大量小对象并发要小心

### 步骤十:验收清单

- [ ] R2 Bucket `fe-depoly-assets` 已创建,`wrangler r2 object list` 能看到 dist 内容
- [ ] Worker `fe-depoly-edge` 部署成功,`*.workers.dev` 能访问
- [ ] 自定义域名 `app.example.com` 绑定成功,HTTPS 证书有效
- [ ] 访问根路径 → 正常显示 SPA
- [ ] 刷新子路由(如 `/about`)→ 不 404,正常回到 SPA
- [ ] 静态资源 Response Headers 含 `Cache-Control: max-age=31536000, immutable`
- [ ] `index.html` Response Headers 含 `Cache-Control: max-age=0, must-revalidate`
- [ ] 不存在的 `.js` 文件 → 404(不是 200 返回 HTML)
- [ ] `git push main` → CI 自动构建 + 上传 R2 + 部署 Worker,5 分钟内生效
- [ ] Dashboard → R2 → `fe-depoly-assets` 能看到文件 + 大小
- [ ] Dashboard → Worker → `fe-depoly-edge` → Metrics 能看到请求量

### 成本估算

| 项 | 免费额度 | 预估用量 | 是否收费 |
|----|---------|---------|---------|
| R2 存储 | 10 GB | < 50 MB | 免费 |
| R2 A 类操作(写) | 100 万/月 | < 500(CI 每次 ~50) | 免费 |
| R2 B 类操作(读) | 1000 万/月 | 视流量,学习项目 < 1 万 | 免费 |
| Worker 请求 | 10 万/天 | 视流量,通常 < 1 万 | 免费 |
| Worker CPU 时间 | 10ms/请求 | 远低于 | 免费 |
| CDN 带宽 | 无限 | - | 免费 |

**结论:0 元**。需要绑卡才能开通 R2,但免费额度内不扣费。

### 与方式 A 的对比小结

| 维度 | 方式 A(Pages 直连) | 方式 B(R2 + Worker) |
|------|-------------------|--------------------|
| 部署产物 | dist/ 直接上传 Pages | dist/ 上传 R2,Worker 做路由 |
| 角色清晰度 | 单一产品,角色混合 | OSS + 网关 + CDN 三层分离 |
| 缓存控制 | Pages 默认,可加 Cache Rules | Worker 代码完全可控 |
| SPA 回退 | Pages 自动 | Worker 代码处理 |
| 鉴权扩展 | 需要 Worker 函数 | Worker 天然支持 |
| 跨项目资源共享 | 不方便 | R2 按路径前缀,多项目共用一个 Bucket |
| 学习价值 | 中 | 高(对应企业级架构) |
| 配置复杂度 | 低 | 中(要写 Worker 代码) |
| 适合场景 | 个人项目、简单 SPA | 学习企业级架构、需要精细控制 |

### 后续扩展

方式 B 跑通后,可以继续加:

- **Workers KV**:边缘存储,做特性开关、配置中心
- **Workers D1**:边缘 SQLite,做轻量后端(用户偏好、计数器)
- **Cloudflare Access**:给 Worker 加 SSO 鉴权,内部环境用
- **Durable Objects**:做实时协作、状态同步
- **Cloudflare Queue**:异步任务,CI 通知、日志处理
- **R2 生命周期规则**:自动清理 30 天前的旧 `assets/*` 文件

这些都加上,就基本是一个完整的"边缘 BFF + 静态托管"架构,可以当企业级架构的沙盘。

### 小结

方式 B 的核心:**R2 当 OSS,Worker 当网关,Cloudflare CDN 当边缘缓存**。本项目的操作顺序:

1. 开通 R2 + 创建 Bucket
2. 写 Worker 代码(路由 + 缓存 + SPA 回退)
3. 本地 `wrangler dev` 调试
4. `wrangler deploy` 部署 Worker
5. 绑自定义域名(`custom_domain = true`)
6. GitHub Actions 自动化:构建 → `aws s3 sync` 到 R2 → `wrangler deploy`
7. 按发布顺序传资源(先静态、后 HTML)
8. 验收 + 监控

方式 B 比方式 A 复杂,但能完整理解"OSS + CDN + 边缘网关"三层架构,为后续学企业级部署(K8s + API 网关 + 多区域)打基础。

---

## 方式 B 完整请求路径流程图

以"用户访问 `https://app.example.com/users/123`"为例,画出从浏览器输入 URL 到页面渲染完成的完整链路,包含 DNS、CDN 边缘、Worker、R2、CI/CD 部署五条路径。

### 总览(一张图看全)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              用户访问完整链路                                      │
└──────────────────────────────────────────────────────────────────────────────────┘

  浏览器                                              Cloudflare 边缘节点                R2 源站
  ─────                                              ──────────────────                ────────
                                                          ┌──────────────┐
  1. 输入 https://app.example.com/users/123 ────────────> │ DNS 解析      │
                                                          │ (Cloudflare   │
                                                          │  权威 DNS)    │
                                                          └──────┬───────┘
                                                                 │ 返回边缘节点 IP
                                                                 ▼
                                                          ┌──────────────┐
  2. TLS 握手 + HTTP 请求 ──────────────────────────────> │ CDN 边缘节点  │
                                                          │ (全球 300+)   │
                                                          └──────┬───────┘
                                                                 │ 查边缘缓存(caches.default)
                                                                 ▼
                                                          ┌──────────────┐
                                                          │ 缓存命中?    │
                                                          └──────┬───────┘
                                                       是 │            │ 否
                                                          ▼            ▼
  3. 直接返回缓存 ─────────────────────────────────────── │     ┌──────────────┐
                                                          │     │ Worker 执行  │
                                                          │     │ fe-depoly-edge│
                                                          │     └──────┬───────┘
                                                          │            │ 路由 + 缓存策略
                                                          │            │ 取 R2 对象
                                                          │            ▼
                                                          │     ┌──────────────┐
                                                          │     │ R2 Bucket    │
                                                          │     │ fe-depoly-assets│
                                                          │     └──────┬───────┘
                                                          │            │ 返回对象
                                                          │            ▼
                                                          │     ┌──────────────┐
                                                          │     │ Worker 写缓存 │
                                                          │     │ + 返回响应    │
                                                          │     └──────┬───────┘
                                                          │            │
                                                          ▼<───────────┘
  4. 收到 HTTP 响应 <───────────────────────────────────── │
        - 200 OK
        - index.html (SPA 回退)
        - Cache-Control: max-age=0
                                                          ▼
  5. 浏览器解析 HTML,加载子资源 ────────────────────────> │
        /assets/index-xxxx.js                              │
        /assets/index-xxxx.css                             │
                                                          ▼
  6. JS 执行,React Router 接管 ───────────────────────── │
        路由 /users/123 客户端渲染                         │
                                                          ▼
  7. 页面显示完成 <────────────────────────────────────── │
```

### 详细分阶段拆解

#### 阶段 1:DNS 解析(浏览器 → Cloudflare 权威 DNS)

```
浏览器输入 https://app.example.com/users/123
        │
        ▼
┌──────────────────────────────────────────────┐
│ 1. 浏览器 DNS 缓存查询                        │
│    - 浏览器缓存 → 未命中                      │
│    - OS 缓存 → 未命中                         │
│    - 路由器缓存 → 未命中                      │
└──────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────┐
│ 2. 递归 DNS 查询                              │
│    根 DNS → .com DNS → Cloudflare 权威 DNS    │
└──────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────┐
│ 3. Cloudflare 权威 DNS 返回 A/AAAA 记录       │
│    返回离用户最近的 Cloudflare 边缘节点 IP     │
│    (Anycast 路由,自动就近)                   │
└──────────────────────────────────────────────┘
        │
        ▼
   拿到边缘节点 IP,如 104.21.x.x
```

**为什么 NS 要切到 Cloudflare**:DNS 解析权在 Cloudflare,才能用 Anycast 把用户路由到最近的边缘节点,这是 CDN 加速的第一步。NS 不在 Cloudflare 的话,自定义域名 Worker 拿不到流量。

#### 阶段 2:TLS 握手 + HTTP 请求(浏览器 → 边缘节点)

```
浏览器 ─────TCP 握手────> 边缘节点 IP:443
        │
        │  TLS 1.3 握手
        │  - SNI: app.example.com
        │  - Cloudflare 出示证书(自动签发,Universal SSL)
        │  - 协商出对称密钥
        │
        ▼
浏览器 ─────加密 HTTP 请求────> 边缘节点
        │
        │  GET /users/123 HTTP/2
        │  Host: app.example.com
        │  User-Agent: ...
        │  Accept: text/html,...
        │
        ▼
   边缘节点收到请求,准备路由到 Worker
```

**TLS 证书**:Cloudflare 自动签发,无需手动配置。因为 NS 在 Cloudflare,证书通过 DCV(DNS-01)自动验证。

#### 阶段 3: 执行(边缘节点内部)

这是核心环节,Worker 在边缘节点上跑,决定怎么处理请求。

```
边缘节点收到请求
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Worker: fe-depoly-edge 执行                              │
│                                                          │
│ 步骤 1: 查 CDN 边缘缓存(caches.default)                │
│   cacheKey = new Request(url, request)                   │
│   cached = await cache.match(cacheKey)                   │
│                                                          │
│   缓存命中?                                              │
│   ├─ 是 → 直接返回 cached (跳过 R2)                      │
│   └─ 否 ↓                                                 │
│                                                          │
│ 步骤 2: 解析路径                                         │
│   path = '/users/123'                                    │
│   ext = '' (无扩展名)                                    │
│                                                          │
│ 步骤 3: 从 R2 取对象                                     │
│   object = await env.ASSETS_BUCKET.get('users/123')      │
│   → null (R2 里没有这个 key)                             │
│                                                          │
│ 步骤 4: SPA 回退判断                                     │
│   ext 不在 LONG_CACHE_EXTENSIONS 里 → 触发回退           │
│   object = await env.ASSETS_BUCKET.get('index.html')     │
│   → 拿到 index.html                                      │
│                                                          │
│ 步骤 5: 构造响应                                         │
│   - Content-Type: text/html; charset=utf-8               │
│   - Cache-Control: public, max-age=0, must-revalidate    │
│   - ETag: <R2 对象的 ETag>                               │
│   - X-Content-Type-Options: nosniff                      │
│   - X-Frame-Options: DENY                                │
│                                                          │
│ 步骤 6: 写入边缘缓存(可选,HTML 不缓存)                │
│   if (!isHtml) ctx.waitUntil(cache.put(cacheKey, ...))   │
│                                                          │
│ 步骤 7: 返回响应                                         │
└──────────────────────────────────────────────────────────┘
        │
        ▼
   响应回到边缘节点的 HTTP 层,准备返回给浏览器
```

**Worker 的角色**:边缘网关,处理路由、缓存、回退、安全头。对应企业级架构里的 API 网关 + 反向代理。

#### 阶段 4:R2 取对象(Worker → R2)

```
Worker 调用 env.ASSETS_BUCKET.get(key)
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ R2 内部                                                  │
│                                                          │
│ 1. 路由到对应区域                                         │
│    R2 自动选择最近区域的副本                              │
│    (存储分区域,读取自动就近)                            │
│                                                          │
│ 2. 查找对象                                              │
│    bucket: fe-depoly-assets                              │
│    key: index.html                                       │
│                                                          │
│ 3. 返回 R2ObjectBody                                     │
│    - body: ReadableStream(流式返回,不占 Worker 内存)   │
│    - httpEtag: "etag"                                    │
│    - size: 1234                                          │
│    - uploaded: 时间戳                                    │
└──────────────────────────────────────────────────────────┘
        │
        ▼
   Worker 拿到对象,构造 Response
```

**关键**:
- Worker → R2 是 Cloudflare 内网调用,延迟 < 5ms
- R2 body 是流式返回,Worker 不需要把整个文件读进内存,大文件也不怕
- R2 不在边缘,但有区域副本,读取延迟低

#### 阶段 5:响应回浏览器(边缘节点 → 浏览器)

```
边缘节点收到 Worker 的 Response
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ 边缘节点 HTTP 层                                          │
│                                                          │
│ 1. 应用 CDN 缓存策略(如果 Worker 设了 Cache-Control)   │
│    - HTML: 不缓存或短缓存                                 │
│    - 静态资源: 长缓存,写入 caches.default               │
│                                                          │
│ 2. 压缩(如果浏览器支持)                                │
│    - 静态资源: br / gzip                                 │
│    - 已压缩的不再压缩                                     │
│                                                          │
│ 3. 返回 HTTP 响应                                         │
│    HTTP/2 200 OK                                         │
│    Content-Type: text/html; charset=utf-8                │
│    Content-Encoding: br                                  │
│    Cache-Control: public, max-age=0, must-revalidate     │
│    ETag: "abc123"                                        │
│    CF-Cache-Status: MISS (首次) / HIT (后续)             │
│    Server: cloudflare                                    │
│    CF-RAY: xxxxx-HKG (边缘节点代号)                      │
└──────────────────────────────────────────────────────────┘
        │
        ▼
浏览器收到 HTML,开始解析
```

#### 阶段 6:子资源加载(浏览器 → 边缘节点 → R2)

HTML 拿到后,浏览器会请求 HTML 里引用的子资源。

```
浏览器解析 index.html
        │
        │  <script src="/assets/index-C0NbY3df.js">
        │  <link href="/assets/index-BXl-3ClR.css">
        │  <img src="/vite.svg">
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ 并发请求 3 个子资源                                       │
│                                                          │
│ GET /assets/index-C0NbY3df.js                            │
│ GET /assets/index-BXl-3ClR.css                           │
│ GET /vite.svg                                            │
└──────────────────────────────────────────────────────────┘
        │
        ▼
每个请求重复阶段 2-5 的流程,但有差异:
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Worker 处理静态资源请求                                   │
│                                                          │
│ 1. 查边缘缓存                                             │
│    - 静态资源首次访问: MISS → 走 R2                      │
│    - 二次访问: HIT → 直接返回(跳过 R2 和 Worker 代码)  │
│                                                          │
│ 2. R2 取对象(首次)                                      │
│    env.ASSETS_BUCKET.get('assets/index-C0NbY3df.js')     │
│                                                          │
│ 3. 构造响应                                               │
│    - Content-Type: application/javascript                │
│    - Cache-Control: public, max-age=31536000, immutable  │
│    - ETag: "..."                                         │
│                                                          │
│ 4. 写入边缘缓存(因为不是 HTML)                          │
│    ctx.waitUntil(cache.put(cacheKey, response.clone()))  │
│                                                          │
│ 5. 返回响应                                               │
└──────────────────────────────────────────────────────────┘
        │
        ▼
浏览器拿到 JS/CSS/图片,继续渲染
```

**长缓存的优势**:`max-age=31536000, immutable` 让浏览器**一年内不再请求这个 URL**,直接用本地缓存。文件名带 hash(`index-C0NbY3df.js`),发版后 hash 变了,新文件新 URL,不会用旧缓存。

#### 阶段 7:客户端路由(浏览器内部)

```
浏览器加载完 JS
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ React 应用启动                                            │
│                                                          │
│ 1. ReactDOM.createRoot(root).render(<App />)             │
│                                                          │
│ 2. React Router 接管路由                                 │
│    当前 URL: /users/123                                  │
│    匹配 <Route path="/users/:id" element={<UserDetail}/>}│
│                                                          │
│ 3. 渲染 UserDetail 组件                                  │
│    - 可能触发 API 请求(本项目暂无)                      │
│    - 更新 DOM                                            │
│                                                          │
│ 4. 页面显示完成                                           │
└──────────────────────────────────────────────────────────┘
        │
        ▼
   用户看到 /users/123 页面内容
```

**关键**:刷新 `/users/123` 时,浏览器向边缘节点请求这个 URL,Worker 通过 SPA 回退返回 `index.html`,React 再次接管路由。整个过程用户感知不到"回退",体验一致。

### 部署路径(CI/CD,独立于访问链路)

部署和访问是两条独立链路,部署完成后才影响访问链路。

```
开发者 git push main
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ GitHub Actions 触发 deploy-r2-worker.yml                 │
│                                                          │
│ Job: build-and-deploy                                    │
│                                                          │
│ Step 1: checkout 代码                                    │
│ Step 2: setup Node 22                                    │
│ Step 3: npm ci                                           │
│ Step 4: npm run lint / type-check / build                │
│         → 产出 dist/                                     │
└──────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Step 5: aws s3 sync dist/ → R2                           │
│                                                          │
│ 5.1 同步静态资源(长缓存)                                │
│     aws s3 sync dist/ s3://fe-depoly-assets/             │
│       --exclude "index.html"                             │
│       --cache-control "max-age=31536000, immutable"      │
│                                                          │
│ 5.2 单独上传 index.html(短缓存)                         │
│     aws s3 cp dist/index.html s3://fe-depoly-assets/     │
│       --cache-control "max-age=0, must-revalidate"       │
│                                                          │
│ 5.3 --delete 清理旧 hash 文件(可选)                    │
└──────────────────────────────────────────────────────────┘
        │
        ▼
        ┌────────────────┐
        │  R2 Bucket     │
        │ fe-depoly-assets│ <── 新版本文件就位
        └────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Step 6: cd worker && npx wrangler deploy                 │
│                                                          │
│ - 编译 Worker TypeScript                                  │
│ - 上传 Worker 代码到 Cloudflare                          │
│ - 更新 Worker 路由(绑定的自定义域名不变)              │
│ - 旧 Worker 版本保留,可回滚                             │
└──────────────────────────────────────────────────────────┘
        │
        ▼
        ┌────────────────┐
        │ Worker         │
        │ fe-depoly-edge │ <── 新版本代码就位
        └────────────────┘
        │
        ▼
   部署完成,1~2 分钟内全球生效
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ 边缘缓存失效策略                                          │
│                                                          │
│ - 静态资源: 文件名带 hash,新版本是新 URL,旧缓存自然过期 │
│ - index.html: max-age=0,下次请求强制回源,拿到新版本    │
│ - 用户端: 浏览器看到新 hash 的 JS URL,请求新文件        │
└──────────────────────────────────────────────────────────┘
```

### 关键节点说明

| 节点 | 角色 | 对应企业级架构 |
|------|------|---------------|
| Cloudflare DNS | 权威 DNS + Anycast 路由 | 智能 DNS(BGP DNS) |
| Cloudflare 边缘节点 | CDN + TLS 终止 + Worker 运行时 | CDN + API 网关 |
| Worker | 路由 + 缓存策略 + SPA 回退 + 安全头 | API 网关 / 反向代理(Nginx) |
| R2 Bucket | 静态文件存储 | OSS / S3 |
| `caches.default` | 边缘缓存(每节点独立) | CDN 边缘缓存 |
| 浏览器缓存 | 客户端缓存 | N/A(企业级不管) |

### 性能数据(参考值)

| 阶段 | 首次访问 | 二次访问(缓存命中) |
|------|---------|-------------------|
| DNS | 50-200ms | < 5ms(浏览器缓存) |
| TLS 握手 | 50-100ms | 0ms(HTTP/2 连接复用) |
| Worker 执行 | 1-5ms | 0ms(缓存命中跳过 Worker) |
| R2 读取 | 5-20ms | 0ms |
| 网络传输(RTT) | 视用户位置 | 视用户位置 |
| **总耗时(典型)** | **100-300ms** | **20-50ms** |

### 缓存层次(从近到远)

```
浏览器缓存(最近)
    │ 未命中
    ▼
Cloudflare 边缘缓存(用户最近的节点)
    │ 未命中
    ▼
R2 源站(区域存储)
    │
    ▼
返回数据,逐层写缓存
```

每一层缓存命中,都跳过后续所有层,直接返回。静态资源带 hash 文件名,可以放心在所有层长缓存,命中率极高。

### 小结

方式 B 的请求路径可以浓缩成一句:**DNS → 边缘节点 → Worker → R2 → 原路返回,缓存贯穿全程**。

理解这条链路后,排查问题就有方向:
- 慢 → 看是哪一段慢(DNS? TLS? Worker? R2?)
- 不更新 → 看是哪层缓存没失效(浏览器? 边缘? R2?)
- 404 → 看是 Worker 路由错还是 R2 没文件
- 502 → 看 Worker 是否部署成功、绑定是否生效

把这条链路画出来贴墙上,出问题对照排查,比看文档快得多。
