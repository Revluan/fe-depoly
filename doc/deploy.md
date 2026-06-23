# 阶段三：部署与托管

> 配套文档：`doc/plan.md` 阶段三。本仓库阶段二已用 GitHub Pages 跑通了最小闭环，阶段三在此基础上扩展到生产级托管方案。
> 已读前置：`doc/cicd.md`（理解 CI/CD、分支策略、artifact 概念）。

## 一、本仓库当前状态

阶段二已落地：

- 静态产物 `dist/` 由 Vite 构建产出
- `deploy-staging.yml` / `deploy-production.yml` 通过 GitHub Pages 完成 staging / production 部署
- 分支策略：`staging` → Pages 预发；`main` 打 `v*.*.*` tag → Pages 生产

阶段三要解决的问题：**GitHub Pages 只适合 demo / 文档站点，生产环境需要更专业的托管方案**。下面 5 个方案按"上手成本从低到高、可控性从弱到强"排列，每个方案都给出完整操作步骤。

## 二、方案对比总览

| 方案 | 上手成本 | 可控性 | 适合场景 | 月成本（小流量） |
| --- | --- | --- | --- | --- |
| ① Vercel / Netlify / Cloudflare Pages | 极低 | 低 | 个人项目、SaaS、SSR | 免费档够用 |
| ② Nginx 自建 | 中 | 高 | 内网部署、定制需求 | 服务器钱 |
| ③ Docker + Compose | 中 | 高 | 多服务编排、环境隔离 | 服务器钱 |
| ④ 对象存储 OSS / S3 + CDN | 中 | 中 | 纯静态站点、大流量 | 几元起 |
| ⑤ 灰度 + 回滚 | 高 | 高 | 生产环境必备 | 看方案 |

> 推荐组合：**个人项目用 ①；企业生产用 ④ + ⑤；有 BFF / SSR 用 ③**。

## 三、方案一：Vercel / Netlify / Cloudflare Pages

三个平台都提供"连 GitHub 仓库 → 自动 CI/CD → 全球 CDN"的一站式托管。区别在生态和细节。

### 3.1 Vercel（推荐，React 生态最友好）

**操作步骤：**

1. 注册 [vercel.com](https://vercel.com)，用 GitHub 账号登录
2. 点 `Add New Project` → 导入 `fe-depoly` 仓库
3. Framework Preset 自动识别为 `Vite`，确认配置：
   - Build Command：`npm run build -- --mode production`
   - Output Directory：`dist`
   - Install Command：`npm ci`
4. Environment Variables 添加 `VITE_APP_ENV=production`
5. 点 `Deploy`，首次部署完成后每次 push 到 `main` 自动部署

**关键配置文件 `vercel.json`（放在仓库根目录）：**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run build -- --mode production",
  "outputDirectory": "dist",
  "framework": "vite",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }],
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
    },
    {
      "source": "/index.html",
      "headers": [{ "key": "Cache-Control", "value": "no-cache" }]
    }
  ]
}
```

> `rewrites` 是 SPA 路由的关键：所有未命中静态文件的请求都回 `index.html`，否则刷新 `/about` 会 404。

**预发环境：** Vercel 自动给每个 PR 创建 Preview Deployment，URL 形如 `fe-depoly-git-staging-xxx.vercel.app`，对应阶段二的 staging。

**自定义域名：** Settings → Domains → 添加域名 → 按提示加 CNAME 记录。

### 3.2 Netlify

**操作步骤：**

1. 注册 [netlify.com](https://netlify.com)，用 GitHub 登录
2. `Add new site` → `Import an existing project` → 选 `fe-depoly` 仓库
3. 配置：
   - Build command：`npm run build -- --mode production`
   - Publish directory：`dist`
4. 环境变量在 `Site settings → Environment variables` 添加

**配置文件 `netlify.toml`：**

```tom
[build]
  command = "npm run build -- --mode production"
  publish = "dist"

[build.environment]
  VITE_APP_ENV = "production"

# SPA fallback
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200

# 静态资源长缓存
[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/index.html"
  [headers.values]
    Cache-Control = "no-cache"
```

### 3.3 Cloudflare Pages

**操作步骤：**

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git
2. 选 `fe-depoly` 仓库
3. 配置：
   - Framework preset：`Vite`
   - Build command：`npm run build -- --mode production`
   - Build output directory：`dist`
4. Environment variables：`VITE_APP_ENV=production`

**特点：** 自带 Cloudflare 全球 CDN，免费档无限请求次数（Vercel/Netlify 免费档有带宽限制），适合大流量静态站。

### 3.4 三平台对比

| 维度 | Vercel | Netlify | Cloudflare Pages |
| --- | --- | --- | --- |
| 免费档带宽 | 100GB/月 | 100GB/月 | 无限 |
| 免费档构建次数 | 6000 分钟/月 | 300 分钟/月 | 500 次/月 |
| SSR 支持 | 原生（Next.js） | 通过 Functions | 通过 Workers |
| 边缘函数 | Edge Functions | Edge Functions | Workers（更成熟） |
| 国内访问 | 一般 | 一般 | 较好 |
| 适合 | React / Next 项目 | 静态站 + 表单 | 全球分发、成本敏感 |

## 四、方案二：Nginx 自建托管

适用场景：内网部署、需要完全控制、定制缓存 / 重试 / 灰度策略。

### 4.1 安装 Nginx

```bash
# macOS（本地测试）
brew install nginx

# Ubuntu / Debian
sudo apt update && sudo apt install -y nginx

# CentOS / RHEL
sudo yum install -y nginx
```

### 4.2 项目目录结构

```
fe-depoly/
├── nginx/
│   ├── nginx.conf          # 主配置（仅服务器级）
│   ├── conf.d/
│   │   └── fe-depoly.conf  # 站点配置
│   └── Dockerfile          # 方案三用
└── dist/                   # vite build 产物
```

先创建目录：

```bash
mkdir -p nginx/conf.d
```

### 4.3 站点配置 `nginx/conf.d/fe-depoly.conf`

```nginx
server {
    listen 80;
    server_name fe-depoly.example.com;

    root /var/www/fe-depoly;
    index index.html;

    # gzip 压缩：文本类资源压缩率 60%+，必开
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/javascript application/javascript application/json image/svg+xml;

    # 静态资源长缓存：Vite 产物带 content hash，可以一年强缓存
    location /assets/ {
        access_log off;
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # HTML 不缓存：保证用户拿到最新的 index.html，进而引用最新的 JS/CSS
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # SPA fallback：所有未命中静态文件的请求都回到 index.html
    # try_files 关键：$uri $uri/ 都没命中时回 /index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 安全头：基础防护
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
```

### 4.4 部署流程

```bash
# 1. 本地构建
npm run build -- --mode production

# 2. 上传 dist 到服务器（假设服务器 user@1.2.3.4）
rsync -avz --delete dist/ user@1.2.3.4:/var/www/fe-depoly/

# 3. 上传 nginx 配置
scp nginx/conf.d/fe-depoly.conf user@1.2.3.4:/etc/nginx/conf.d/

# 4. 远程 reload
ssh user@1.2.3.4 "sudo nginx -t && sudo systemctl reload nginx"
```

> `rsync --delete` 保证服务器上 dist 内容与本地完全一致，避免旧文件残留。

### 4.5 HTTPS（Let's Encrypt）

```bash
# 服务器上执行
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d fe-depoly.example.com
# certbot 自动改 nginx 配置 + 申请证书 + 设置定时续期
```

## 五、方案三：Docker + Docker Compose

适用场景：环境隔离、一键启动 / 扩容、便于 CI 自动化部署。

### 5.1 编写 Dockerfile（多阶段构建）

`Dockerfile` 放仓库根目录：

```dockerfile
# ─── 阶段 1：构建 ───
FROM node:24-alpine AS builder
WORKDIR /app

# 先复制 lock 文件，利用 docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码并构建
COPY . .
RUN npm run build -- --mode production

# ─── 阶段 2：运行 ───
FROM nginx:alpine AS runner

# 复制 nginx 配置
COPY nginx/conf.d/fe-depoly.conf /etc/nginx/conf.d/default.conf

# 从 builder 阶段复制构建产物
COPY --from=builder /app/dist /var/www/fe-depoly

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost/ || exit 1

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

> 多阶段构建的关键：builder 阶段装 node_modules、跑构建；runner 阶段只复制 dist 和 nginx，最终镜像 ~30MB（vs 不分阶段会到 1GB+）。

### 5.2 `.dockerignore`

```
node_modules
dist
.git
coverage
.env.local
*.log
```

### 5.3 本地验证

```bash
# 构建镜像
docker build -t fe-depoly:1.0.0 .

# 运行容器
docker run --rm -p 8080:80 fe-depoly:1.0.0

# 访问 http://localhost:8080/fe-depoly/
```

> 注意 `vite.config.ts` 里 `base: '/fe-depoly/'`，所以访问路径要带 `/fe-depoly/`。若要部署到根路径，把 `base` 改成 `'/'` 并同步调整 nginx `root` / `location`。

### 5.4 Docker Compose 编排

`docker-compose.yml`：

```yaml
services:
  web:
    build: .
    image: fe-depoly:1.0.0
    container_name: fe-depoly-web
    ports:
      - "8080:80"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost/"]
      interval: 30s
      timeout: 3s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

启动：

```bash
docker compose up -d --build
docker compose logs -f web
docker compose down
```

### 5.5 推送到镜像仓库 + 服务器拉取

```bash
# 1. 登录 Docker Hub（或私有仓库）
docker login

# 2. 打 tag 并推送
docker tag fe-depoly:1.0.0 yourname/fe-depoly:1.0.0
docker tag fe-depoly:1.0.0 yourname/fe-depoly:latest
docker push yourname/fe-depoly:1.0.0
docker push yourname/fe-depoly:latest

# 3. 服务器上拉取并运行
ssh user@1.2.3.4
docker pull yourname/fe-depoly:1.0.0
docker run -d --name fe-depoly-web -p 80:80 --restart unless-stopped yourname/fe-depoly:1.0.0
```

### 5.6 GitHub Actions 自动构建并推送镜像

在 `.github/workflows/` 新增 `docker.yml`：

```yaml
name: Docker Build & Push

on:
  push:
    tags: ['v*.*.*']

jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}

      - name: Extract tag
        id: tag
        run: echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            yourname/fe-depoly:${{ steps.tag.outputs.VERSION }}
            yourname/fe-depoly:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

需要在仓库 Settings → Secrets 添加 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN`。

## 六、方案四：对象存储 OSS / S3 + CDN

适用场景：纯静态站点、大流量、追求成本最低。**这是生产环境最主流的方案。**

### 6.1 阿里云 OSS

**操作步骤：**

1. 开通 OSS 服务，创建 Bucket：
   - 名称：`fe-depoly-prod`
   - 区域：选离用户近的（华东 1-杭州 / 华北 2-北京）
   - **读写权限：公共读**（静态托管必须）
   - 版本控制：开启（用于回滚）
2. Bucket → 基础设置 → 静态页面：
   - 默认首页：`index.html`
   - 默认 404 页：`index.html`（SPA fallback）
3. 上传构建产物：

```bash
# 安装 ossutil
brew install aliyun-cli
# 或下载 ossutil: https://help.aliyun.com/document_detail/120075.html

# 配置 accesskey
ossutil config  # 输入 AccessKey ID / Secret / endpoint

# 同步 dist 到 bucket
ossutil cp -r dist/ oss://fe-depoly-prod/ --update --delete
```

### 6.2 配置缓存头（关键）

OSS 控制台 → 文件管理 → 选中文件 → 设置 HTTP 头：

| 文件 | Cache-Control | 说明 |
| --- | --- | --- |
| `/assets/*`（带 hash） | `public, max-age=31536000, immutable` | 一年强缓存 |
| `/index.html` | `no-cache` | 协商缓存，每次都问 OSS 是否最新 |

也可在上传时通过 `--meta` 指定：

```bash
# index.html 不缓存
ossutil cp dist/index.html oss://fe-depoly-prod/index.html --meta Cache-Control:no-cache

# assets 长缓存
ossutil cp -r dist/assets/ oss://fe-depoly-prod/assets/ \
  --meta "Cache-Control:public, max-age=31536000, immutable" --update
```

### 6.3 接入 CDN

1. 开通 CDN 服务
2. 域名管理 → 添加加速域名：
   - 加速域名：`fe.example.com`
   - 源站：`fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com`
   - 端口：443（HTTPS）
3. 域名 DNS 加 CNAME：`fe.example.com` → `xxx.aliyuncs.com`
4. 缓存配置 → 添加规则：
   - `/assets/*` → 缓存 365 天
   - `/index.html` → 缓存 0 秒（每次回源）
5. HTTPS：申请免费证书 → 部署到 CDN

### 6.4 AWS S3 + CloudFront（海外）

```bash
# 同步到 S3（--delete 删除远端多余文件）
aws s3 sync dist/ s3://fe-depoly-prod/ --delete \
  --exclude "index.html" \
  --cache-control "public, max-age=31536000, immutable"

# index.html 单独上传，不缓存
aws s3 cp dist/index.html s3://fe-depoly-prod/index.html \
  --cache-control "no-cache"

# S3 静态托管：Bucket → Properties → Static website hosting
# CloudFront：创建 distribution → Origin = S3 bucket → 默认根对象 index.html
```

### 6.5 CI 自动同步到 OSS

在 `.github/workflows/` 新增 `deploy-oss.yml`：

```yaml
name: Deploy to OSS

on:
  push:
    tags: ['v*.*.*']

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: '24', cache: 'npm' }
      - run: npm ci
      - run: npm run build -- --mode production

      - name: Install ossutil
        run: |
          wget https://gosspublic.alicdn.com/ossutil/1.7.18/ossutil64 -O /usr/local/bin/ossutil
          chmod +x /usr/local/bin/ossutil

      - name: Deploy to OSS
        env:
          OSS_ACCESS_KEY_ID: ${{ secrets.OSS_ACCESS_KEY_ID }}
          OSS_ACCESS_KEY_SECRET: ${{ secrets.OSS_ACCESS_KEY_SECRET }}
          OSS_ENDPOINT: oss-cn-hangzhou.aliyuncs.com
        run: |
          ossutil config -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" -e "$OSS_ENDPOINT"
          # index.html 不缓存
          ossutil cp dist/index.html oss://fe-depoly-prod/index.html \
            --meta Cache-Control:no-cache -f
          # assets 长缓存
          ossutil cp -r dist/assets/ oss://fe-depoly-prod/assets/ \
            --meta "Cache-Control:public, max-age=31536000, immutable" \
            --update -f
          # 其他静态文件
          ossutil cp -r dist/ oss://fe-depoly-prod/ \
            --exclude "index.html" --exclude "assets/*" \
            --update --delete -f

      - name: Refresh CDN cache
        env:
          OSS_ACCESS_KEY_ID: ${{ secrets.OSS_ACCESS_KEY_ID }}
          OSS_ACCESS_KEY_SECRET: ${{ secrets.OSS_ACCESS_KEY_SECRET }}
        run: |
          # 刷新 CDN 缓存，让用户立即看到新版本
          # 全量刷新 index.html，目录刷新 /
          ossutil cdn-refresh --object oss://fe-depoly-prod/index.html
          ossutil cdn-refresh --dirs oss://fe-depoly-prod/
```

## 七、方案五：灰度发布与回滚机制

### 7.1 灰度发布（Canary Release）

> 思路：让一部分用户先看到新版本，观察没问题再放量到 100%。

#### 方案 A：Nginx 按比例灰度（基于 cookie / header）

```nginx
# 假设 v1.0.0 部署在 /var/www/fe-depoly-v1
#      v1.1.0 部署在 /var/www/fe-depoly-v2

# 通过 cookie 判断：用户带 canary=true 的走 v2
map $cookie_canary $version_root {
    default /var/www/fe-depoly-v1;
    "true"  /var/www/fe-depoly-v2;
}

server {
    listen 80;
    server_name fe-depoly.example.com;

    root $version_root;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

测试：浏览器 DevTools 设置 `document.cookie = "canary=true"`，刷新即可看到 v2。

#### 方案 B：按比例灰度（split_clients）

```nginx
# 10% 流量走 v2，90% 走 v1
split_clients "${remote_addr}${http_user_agent}" $version_root {
    10%  /var/www/fe-depoly-v2;
    *    /var/www/fe-depoly-v1;
}

server {
    listen 80;
    server_name fe-depoly.example.com;
    root $version_root;
    # ...
}
```

> `split_clients` 基于客户端 IP + UA 做哈希分配，同一用户始终命中同一版本，避免刷新切换版本。

#### 方案 C：CDN / LB 层灰度（生产推荐）

阿里云 CDN / AWS CloudFront / Cloudflare 都支持基于权重、Cookie、地理位置的灰度策略，配置在控制台，无需改 Nginx。

### 7.2 回滚机制

#### 场景 A：Git tag 回滚（适用 GitHub Pages / Docker / OSS）

本仓库 `deploy-production.yml` 已支持 `workflow_dispatch` 手动触发，输入旧 tag 即可回滚：

```bash
# 1. 列出历史 tag
git tag --sort=-creatordate

# 2. 在 GitHub Actions UI 手动触发 Deploy Production
#    Run workflow → 输入旧 tag（如 v1.0.0）→ Run
#    workflow 会 checkout 该 tag → build → deploy
```

#### 场景 B：OSS 版本回滚

OSS 开启版本控制后，每个文件都有历史版本：

```bash
# 列出 index.html 的所有版本
ossutil ls oss://fe-depoly-prod/index.html --all-versions

# 把指定版本设为最新
ossutil cp oss://fe-depoly-prod/index.html oss://fe-depoly-prod/index.html \
  --version-id CAQQARiBgIDxxxxxxxxx -f

# 刷新 CDN
ossutil cdn-refresh --object oss://fe-depoly-prod/index.html
```

#### 场景 C：Docker 镜像回滚

```bash
# 1. 查看历史镜像
docker images yourname/fe-depoly --format "table {{.Tag}}\t{{.CreatedAt}}"

# 2. 停止当前容器，启动旧版本
docker stop fe-depoly-web
docker run -d --name fe-depoly-web -p 80:80 --restart unless-stopped \
  yourname/fe-depoly:1.0.0

# 或用 docker compose
docker compose down
# 修改 docker-compose.yml 中 image tag 后
docker compose up -d
```

#### 场景 D：Nginx 软链接回滚（最快）

部署时用软链接指向当前版本，回滚只需切换软链接：

```bash
# 部署新版本
rsync -avz dist/ /var/www/fe-depoly-v1.1.0/
# 切换软链接
ln -sfn /var/www/fe-depoly-v1.1.0 /var/www/fe-depoly-current
nginx -s reload

# 回滚到 v1.0.0
ln -sfn /var/www/fe-depoly-v1.0.0 /var/www/fe-depoly-current
nginx -s reload
```

Nginx 配置：

```nginx
root /var/www/fe-depoly-current;
```

> 这种方式回滚在 1 秒内完成，且不依赖构建过程。**生产环境推荐。**

### 7.3 回滚决策清单

| 场景 | 回滚方式 | 耗时 |
| --- | --- | --- |
| GitHub Pages | 手动触发 workflow → 输入旧 tag | 2-3 分钟 |
| Docker | 切换镜像 tag 重启 | 30 秒 |
| Nginx 软链接 | `ln -sfn` + `nginx -s reload` | 1 秒 |
| OSS + CDN | 版本回滚 + CDN 刷新 | 1-2 分钟 |

## 八、本阶段落地建议

本仓库当前用 GitHub Pages 已经跑通最小闭环。阶段三建议按以下顺序落地：

1. **必做**：补充 Docker 方案（方案三），掌握容器化部署能力
2. **必做**：在本地或云服务器跑通 Nginx + HTTPS（方案二）
3. **推荐**：把一个版本部署到 Vercel（方案一），对比 GitHub Pages 体验
4. **进阶**：接入 OSS + CDN（方案四），这是企业生产标配
5. **进阶**：实现 Nginx 软链接回滚（方案五场景 D）

每个方案做完后，在 `doc/` 下补充一篇踩坑记录（如 `deploy-vercel-notes.md`）。

## 九、踩坑点汇总

1. **Vite `base` 路径**：部署到子路径（如 GitHub Pages `/fe-depoly/`）必须设置 `base`，否则资源 404。部署到根域名则设 `base: '/'`
2. **SPA 路由 404**：所有方案都必须配置 fallback 到 `index.html`，否则刷新子路由报 404
3. **缓存导致旧版本不更新**：HTML 必须不缓存，否则用户拿到旧 HTML 引用了已被删除的 JS hash 文件 → 白屏
4. **CDN 缓存刷新**：部署后必须刷新 CDN，否则用户依然访问旧版本。`/index.html` 必刷，`/assets/*` 不用刷（hash 变了就是新文件）
5. **Docker 镜像体积**：不分阶段构建会到 1GB+，必须多阶段
6. **Docker 层缓存失效**：`COPY . .` 放在 `npm ci` 之前会导致每次改代码都重装依赖。一定要先 `COPY package*.json` 再 `npm ci`
7. **OSS 文件权限**：私有 bucket 部署后用户访问 403，必须设为公共读
8. **Nginx `try_files` 顺序**：`$uri $uri/ /index.html` 顺序不能错，否则 SPA 路由失效
9. **HTTP/HTTPS 混合内容**：HTTPS 站点引用 HTTP 资源会被浏览器拦截，全站必须 HTTPS
10. **灰度比例不是真实流量比例**：`split_clients` 基于哈希，小流量时偏差大；要精确比例需用专业 LB（如 Nginx Plus / 阿里云 SLB）

## 十、参考链接

- Vercel 文档：https://vercel.com/docs
- Netlify 文档：https://docs.netlify.com
- Cloudflare Pages：https://developers.cloudflare.com/pages/
- Nginx 文档：https://nginx.org/en/docs/
- Let's Encrypt：https://certbot.eff.org/
- Docker 官方文档：https://docs.docker.com/
- 阿里云 OSS：https://help.aliyun.com/product/31815.html
- AWS S3 静态托管：https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html
- Nginx split_clients：https://nginx.org/en/docs/http/ngx_http_split_clients_module.html
