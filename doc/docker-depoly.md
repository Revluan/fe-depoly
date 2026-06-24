# Docker 自建部署详解

> 配套文档：`doc/deploy.md` 方案三。本文是 Docker 方案的完整落地手册，从零开始一步步走完本地构建 → 镜像仓库 → 服务器部署 → CI 自动化 → 生产加固。
> 已读前置：`doc/deploy.md`（了解 Docker 在 5 个方案中的定位）、`doc/cicd.md`（理解 CI/CD）。

## 一、整体思路

Docker 部署的核心是把"应用 + 运行环境"打包成一个不可变镜像，然后在任何机器上用这个镜像启动容器。对前端项目来说：

```
源码 ──构建──► dist/ ──打包──► nginx + dist 镜像 ──推送──► 镜像仓库
                                                              │
                                                              ▼
                                                        服务器拉取 ──► 启动容器
```

为什么用 Docker 而不是直接 rsync dist 到服务器？

1. **环境一致**：开发、CI、生产都用同一个 nginx:alpine，不会出现"服务器 nginx 版本不一样"的玄学
2. **回滚快**：切镜像 tag 即回滚，秒级
3. **扩容简单**：一台服务器扛不住就拉新机器，`docker pull && docker run` 完事
4. **隔离性**：一台机器可以跑多个站点，互不干扰
5. **可复现**：镜像带版本号，任何时候都能拉起来重现当时环境

## 二、前置准备

### 2.1 安装 Docker

```bash
# macOS（推荐 OrbStack，比 Docker Desktop 快且省内存）
brew install --cask orbstack
# 或
brew install --cask docker

# Ubuntu
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER  # 避免每次都要 sudo
newgrp docker

# 验证
docker --version
docker compose version
```

### 2.2 验证本仓库可构建

```bash
cd /Users/user/Desktop/study/fe-depoly
npm ci
npm run build -- --mode production
ls dist/  # 应该有 index.html + assets/
```

### 2.3 关键决策：`base` 路径

本仓库 `vite.config.ts` 当前是 `base: '/fe-depoly/'`（为 GitHub Pages 子路径准备）。Docker 自建部署通常用根路径或独立域名，需要调整：

```ts
// vite.config.ts
export default defineConfig({
  base: '/',  // 改为根路径，配合独立域名
  // ...
})
```

> 如果保留 `base: '/fe-depoly/'`，访问时要带 `/fe-depoly/` 前缀，nginx 配置也要对应调整。**自建部署推荐改成 `'/'`。**

## 三、目录结构

```
fe-depoly/
├── Dockerfile              # 镜像构建脚本
├── .dockerignore           # 构建时忽略的文件
├── docker-compose.yml      # 本地 / 单机部署编排
├── docker-compose.prod.yml # 生产环境编排（覆盖项）
├── nginx/
│   ├── conf.d/
│   │   └── fe-depoly.conf  # 站点配置
│   └── nginx.conf          # 主配置（可选，覆盖默认）
└── ...
```

```bash
mkdir -p nginx/conf.d
```

## 四、Nginx 配置

### 4.1 站点配置 `nginx/conf.d/fe-depoly.conf`

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # gzip 压缩：文本类资源压缩率 60%+，必开
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/javascript
        application/javascript
        application/json
        application/xml
        image/svg+xml;

    # 静态资源长缓存：Vite 产物带 content hash，可以一年强缓存
    location /assets/ {
        access_log off;
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # HTML 不缓存：保证用户拿到最新 index.html
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # SPA fallback：未命中的请求都回 index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 安全头
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # 健康检查端点（Docker HEALTHCHECK 用）
    location = /healthz {
        access_log off;
        return 200 "ok";
        add_header Content-Type text/plain;
    }
}
```

> 注意 `root /usr/share/nginx/html`：nginx 官方镜像默认静态目录就是这里，我们打包时把 dist 复制到这个路径，无需改 nginx 主配置。

### 4.2 主配置 `nginx/nginx.conf`（可选）

如果不满足于默认配置，可以覆盖主配置：

```nginx
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65;

    # HTTP/2（生产 HTTPS 时启用）
    # server { listen 443 ssl http2; ... }

    include /etc/nginx/conf.d/*.conf;
}
```

> 一般情况不用写这个文件，用 nginx:alpine 默认主配置 + `conf.d/fe-depoly.conf` 足够。下面 Dockerfile 假设只用 `conf.d/`。

## 五、Dockerfile（多阶段构建）

`Dockerfile` 放仓库根目录：

```dockerfile
# ──────────────────────────────────────────────────────────────
# 阶段 1：构建（builder）
# ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# 先只复制 package.json + lockfile，利用 docker 层缓存
# 只要 package*.json 没变，npm ci 这一层就命中缓存，秒级完成
COPY package.json package-lock.json ./

RUN npm ci

# 再复制源码
COPY . .

# 构建（生产模式）
RUN npm run build -- --mode production

# ──────────────────────────────────────────────────────────────
# 阶段 2：运行（runner）
# ──────────────────────────────────────────────────────────────
FROM nginx:alpine AS runner

# 设置时区（日志时间正确）
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# 复制 nginx 站点配置
COPY nginx/conf.d/fe-depoly.conf /etc/nginx/conf.d/default.conf

# 从 builder 阶段复制构建产物到 nginx 默认目录
COPY --from=builder /app/dist /usr/share/nginx/html

# 健康检查：每 30s 拉一次 /healthz，失败 3 次标记 unhealthy
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost/healthz || exit 1

EXPOSE 80

# 前台运行 nginx（docker 必须前台运行，否则容器立即退出）
CMD ["nginx", "-g", "daemon off;"]
```

### 5.1 为什么要多阶段构建

对比单阶段 vs 多阶段：

| 维度 | 单阶段（FROM node + nginx） | 多阶段 |
| --- | --- | --- |
| 镜像大小 | ~1.2GB（带 node_modules + 源码） | ~30MB（只有 nginx + dist） |
| 拉取速度 | 慢 | 快 |
| 安全性 | 源码 + node 在镜像里，泄露风险 | 只剩静态文件 |
| 攻击面 | node 运行时在镜像里 | 只有 nginx |

**多阶段构建是生产 Dockerfile 的硬性要求。**

### 5.2 层缓存的关键

Dockerfile 每条指令是一层，从上到下执行。**只要某一层输入没变，就用缓存**。所以原则是：**变化频率低的放前面，高的放后面**。

```dockerfile
# ✅ 正确：package*.json 变化频率低，放前面
COPY package.json package-lock.json ./
RUN npm ci           # 这层在 package.json 没变时秒级命中缓存
COPY . .             # 源码经常变，放最后

# ❌ 错误：每次改代码都重装依赖
COPY . .
RUN npm ci
```

## 六、`.dockerignore`

`.dockerignore` 放仓库根目录，避免把无关文件打进构建上下文：

```
# 依赖
node_modules

# 构建产物
dist
coverage

# Git
.git
.gitignore

# 编辑器
.vscode
.idea
*.swp

# 日志
*.log
npm-debug.log*

# 环境变量（敏感）
.env.local
.env.*.local

# Docker 自身
Dockerfile
.dockerignore
docker-compose*.yml

# 文档
doc
README.md
```

> 不写 `.dockerignore` 的后果：`COPY . .` 会把 `node_modules`（数百 MB）也复制进 builder 阶段，既慢又污染构建上下文。

## 七、本地构建与运行

### 7.1 构建镜像

```bash
# 在仓库根目录
docker build -t fe-depoly:1.0.0 .

# 查看镜像大小
docker images fe-depoly
# REPOSITORY   TAG       IMAGE ID       CREATED          SIZE
# fe-depoly    1.0.0     abc123...      10 seconds ago   32MB
```

### 7.2 运行容器

```bash
# 前台运行（看日志方便）
docker run --rm -p 8080:80 fe-depoly:1.0.0


# 后台运行
docker run -d --name fe-depoly-web -p 8080:80 fe-depoly:1.0.0

# 访问
open http://localhost:8080/
```

### 7.3 调试

```bash
# 查看容器日志
docker logs fe-depoly-web
docker logs -f fe-depoly-web  # 实时跟随

# 进入容器排查
docker exec -it fe-depoly-web sh
ls /usr/share/nginx/html
cat /etc/nginx/conf.d/default.conf

# 查看健康状态
docker inspect --format='{{.State.Health.Status}}' fe-depoly-web

# 停止并删除
docker stop fe-depoly-web
docker rm fe-depoly-web
```

## 八、Docker Compose 编排

单容器用 `docker run` 还行，多容器 / 多环境用 Compose 更清晰。

### 8.1 `docker-compose.yml`（开发 / 本地）

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
      test: ["CMD", "wget", "--spider", "-q", "http://localhost/healthz"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 5s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

启动：

```bash
docker compose up -d --build   # 构建并后台启动
docker compose ps              # 查看状态
docker compose logs -f web     # 看日志
docker compose restart web     # 重启
docker compose down            # 停止并删除容器
docker compose down -v         # 同时删除卷
```

### 8.2 `docker-compose.prod.yml`（生产）

生产环境的差异：用预构建镜像（不现场 build）、加资源限制、加网络隔离。

```yaml
services:
  web:
    # 生产不现场 build，拉预构建镜像
    # 阿里云 ACR（国内推荐）
    image: crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0
    # Docker Hub: yourname/fe-depoly:1.0.0
    # GHCR: ghcr.io/yourname/fe-depoly:1.0.0
    container_name: fe-depoly-prod
    ports:
      - "80:80"
    restart: always
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost/healthz"]
      interval: 30s
      timeout: 3s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 256M
        reservations:
          cpus: "0.25"
          memory: 64M
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "10"
    networks:
      - frontend

networks:
  frontend:
    driver: bridge
```

生产部署：

```bash
# 服务器上
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

### 8.3 多服务示例（前端 + API）

如果后续要加后端，`docker-compose.yml` 扩展：

```yaml
services:
  web:
    build: .
    ports: ["8080:80"]
    depends_on:
      api:
        condition: service_healthy

  api:
    image: node:24-alpine
    working_dir: /app
    volumes:
      - ./server:/app
    command: sh -c "npm install && npm start"
    ports: ["3000:3000"]
    environment:
      NODE_ENV: production
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/health"]
      interval: 10s
      timeout: 3s
      retries: 5
```

## 九、镜像仓库与服务器部署

### 9.1 选择镜像仓库

| 仓库 | 免费档 | 适合 | 备注 |
| --- | --- | --- | --- |
| **阿里云 ACR 个人版** | 无限公开/私有仓库 | **国内服务器首选** | 国内拉取快、不超时 |
| 腾讯云 TCR / 华为 SWR | 个人版免费 | 国内云用户 | 同上 |
| Docker Hub | 1 个私有仓库 + 无限公开 | 海外服务器 | 国内登录/拉取常超时 |
| GitHub Container Registry (GHCR) | 私有仓库免费 | 与 GitHub 仓库同权限 | 国内访问不稳定 |

> **国内服务器强烈推荐阿里云 ACR**。Docker Hub 的登录认证接口 (`registry-1.docker.io`) 在国内常被墙，登录会超时；阿里云 ACR 完全在国内，登录/推送/拉取都稳定快速。

### 9.2 推送到阿里云 ACR（推荐）

#### 9.2.1 开通 ACR 个人版

1. 登录 https://cr.console.aliyun.com/
2. 开通**个人实例**（免费）
3. 首次使用设置 **Registry 登录密码**（与阿里云账号密码不同，专门用于 docker login）
4. 创建命名空间（如 `cjdemo29`）

#### 9.2.2 创建镜像仓库

阿里云 ACR **必须先在控制台建仓库**才能 push（与 Docker Hub 不同）：

1. 镜像仓库 → 创建镜像仓库
   - 命名空间：`cjdemo29`
   - 仓库名称：`fe-depoly`（或 `ceshi`）
   - 类型：公开（公开镜像拉取不需要登录）/ 私有
   - 代码源：**本地仓库**（不绑定 GitHub，纯命令行推送）
2. 创建完成后会看到完整的 registry 地址，形如：
   ```
   crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com
   ```
   > **这是你账号专属的 registry 地址，每个人不同，必须用控制台显示的**，不要抄网上的 `registry.cn-hangzhou.aliyuncs.com`。

#### 9.2.3 登录 + 打 tag + 推送

```bash
# 1. 登录（用户名是阿里云账号，密码是 9.2.1 设置的 Registry 密码）
docker login --username=<阿里云账号> crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com

# 2. 打 tag（注意镜像名必须小写，含完整 registry 路径）
docker tag fe-depoly:1.0.0 \
  crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0

# 3. 推送
docker push \
  crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0
```

推送成功输出：

```
The push refers to repository [crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly]
a1b2c3d4e5f6: Pushed
1.0.0: digest: sha256:xxxxxxxxxxxx size: 1234
```

#### 9.2.4 多架构构建（Mac M 系列推 x86 服务器）

本地是 Apple Silicon (arm64)、服务器是 x86_64 时，直接 `docker build` 推上去服务器跑不了。用 buildx 多架构构建：

```bash
# 启用 buildx（Docker Desktop 自带，Linux 装 buildx 插件）
docker buildx create --use --name multiarch

# 同时构建 amd64 + arm64 并推送
docker buildx build --platform linux/amd64,linux/arm64 \
  -t crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0 \
  --push .
```

> 服务器只跑 x86 的话只构建 amd64 就行，更省时间：
> ```bash
> docker buildx build --platform linux/amd64 \
>   -t crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0 \
>   --push .
> ```

### 9.3 推送到 Docker Hub（海外服务器备选）

> 国内服务器登录 Docker Hub 常超时，跳过本节用 9.2 阿里云 ACR。海外服务器可用本方案。

```bash
# 1. 注册 hub.docker.com 账号
# 2. 在 Account Settings → Security 创建 Access Token（不要用密码）

# 3. 本地登录
docker login
# 输入用户名 + Token

# 4. 给镜像打 tag（必须带用户名前缀，且全小写）
docker tag fe-depoly:1.0.0 yourname/fe-depoly:1.0.0
docker tag fe-depoly:1.0.0 yourname/fe-depoly:latest

# 5. 推送
docker push yourname/fe-depoly:1.0.0
docker push yourname/fe-depoly:latest
```

### 9.4 推送到 GHCR（与 GitHub 仓库同权限）

```bash
# 1. 创建 PAT：GitHub Settings → Developer settings → Personal access tokens → Fine-grained
#    勾选 write:packages 权限

# 2. 登录（用户名是 GitHub 用户名，密码是 PAT）
echo $GITHUB_TOKEN | docker login ghcr.io -u yourname --password-stdin

# 3. 打 tag（必须小写）
docker tag fe-depoly:1.0.0 ghcr.io/yourname/fe-depoly:1.0.0
docker tag fe-depoly:1.0.0 ghcr.io/yourname/fe-depoly:latest

# 4. 推送
docker push ghcr.io/yourname/fe-depoly:1.0.0
docker push ghcr.io/yourname/fe-depoly:latest

# 5. 在 GitHub 仓库 Packages 页面把镜像设为 public（可选）
```

### 9.5 服务器部署

假设服务器 `1.2.3.4`，已装 Docker：

```bash
# SSH 上服务器
ssh user@1.2.3.4

# 1. 登录镜像仓库（首次）
# 阿里云 ACR（公开镜像可跳过登录）
docker login --username=<阿里云账号> crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com
# 或 Docker Hub
docker login
# 或 GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u yourname --password-stdin

# 2. 拉取镜像
# 阿里云 ACR
docker pull crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0
# Docker Hub / GHCR
docker pull yourname/fe-depoly:1.0.0

# 3. 停止旧容器（如果存在）
docker stop fe-depoly-prod 2>/dev/null
docker rm fe-depoly-prod 2>/dev/null

# 4. 启动新容器
docker run -d \
  --name fe-depoly-prod \
  -p 80:80 \
  --restart always \
  --memory=256m \
  --cpus=1.0 \
  --log-driver json-file \
  --log-opt max-size=50m \
  --log-opt max-file=10 \
  crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0

# 5. 验证
lcurl http://localhost/healthz
# ok
```

### 9.6 用 Compose 在服务器部署（更推荐）

把 `docker-compose.prod.yml` 复制到服务器，后续部署只需两条命令：

```bash
# 服务器上
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

## 十、CI 自动构建并推送

### 10.1 GitHub Actions workflow

在 `.github/workflows/` 新增 `docker.yml`。**国内服务器推荐推阿里云 ACR**，海外用 GHCR。下面给出两个版本。

#### 版本 A：推阿里云 ACR（国内推荐）

需要在仓库 Settings → Secrets 添加：

- `ALIYUN_REGISTRY`：registry 地址，如 `crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com`
- `ALIYUN_USERNAME`：阿里云账号
- `ALIYUN_PASSWORD`：ACR Registry 登录密码（不是阿里云账号密码）

```yaml
name: Docker

on:
  push:
    tags: ['v*.*.*']
  workflow_dispatch:
    inputs:
      tag:
        description: '镜像 tag（如 1.0.0）'
        required: true

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Aliyun ACR
        uses: docker/login-action@v3
        with:
          registry: ${{ secrets.ALIYUN_REGISTRY }}
          username: ${{ secrets.ALIYUN_USERNAME }}
          password: ${{ secrets.ALIYUN_PASSWORD }}

      - name: Extract version
        id: meta
        run: |
          if [ -n "${{ inputs.tag }}" ]; then
            echo "VERSION=${{ inputs.tag }}" >> $GITHUB_OUTPUT
          else
            echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT
          fi

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ${{ secrets.ALIYUN_REGISTRY }}/cjdemo29/fe-depoly:${{ steps.meta.outputs.VERSION }}
            ${{ secrets.ALIYUN_REGISTRY }}/cjdemo29/fe-depoly:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: false
          sbom: false
```

#### 版本 B：推 GHCR（海外 / 与 GitHub 仓库同权限）

```yaml
name: Docker

on:
  push:
    tags: ['v*.*.*']
  workflow_dispatch:
    inputs:
      tag:
        description: '镜像 tag（如 1.0.0）'
        required: true

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
      packages: write  # 推 GHCR 必需
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract version
        id: meta
        run: |
          if [ -n "${{ inputs.tag }}" ]; then
            echo "VERSION=${{ inputs.tag }}" >> $GITHUB_OUTPUT
          else
            echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT
          fi

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/fe-depoly:${{ steps.meta.outputs.VERSION }}
            ghcr.io/${{ github.repository_owner }}/fe-depoly:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: false
          sbom: false
```

> `cache-from: type=gha` 用 GitHub Actions 缓存做 docker 层缓存，二次构建只跑变化层，从 3 分钟降到 30 秒。

### 10.2 触发流程

```bash
# 1. 通过 Changesets 自动打 tag（阶段二已配置）
#    合并 Version Packages PR → 自动打 v1.0.0 tag

# 2. tag 触发 docker.yml + deploy-production.yml（GitHub Pages）
#    docker.yml 构建并推镜像到阿里云 ACR / GHCR
#    deploy-production.yml 部署 Pages（可保留作 demo）

# 3. 服务器上拉取新镜像
ssh user@1.2.3.4
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

### 10.3 服务器自动拉取（Watchtower）

手动 SSH 部署还是累，可以用 [Watchtower](https://containrrr.dev/watchtower/) 自动监听镜像更新：

```yaml
# docker-compose.prod.yml 追加
services:
  watchtower:
    image: containrrr/watchtower
    container_name: watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 60 --cleanup fe-depoly-prod
    restart: always
```

`--interval 60` 每 60 秒检查一次 `fe-depoly-prod` 镜像是否有新版本，有就自动重启容器。

> 生产环境用 Watchtower 要谨慎：自动更新 = 不可控。更稳的方式是 CI 推完镜像后通过 webhook 触发服务器脚本拉取，详见进阶方案。

## 十一、回滚

### 11.1 镜像 tag 回滚（最常用）

每次发布都打版本 tag，回滚就是切旧 tag：

```bash
# 服务器上（阿里云 ACR）
docker pull crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:0.9.0
docker stop fe-depoly-prod
docker rm fe-depoly-prod
docker run -d --name fe-depoly-prod -p 80:80 --restart always \
  crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:0.9.0

# 用 Compose 更简洁：改 docker-compose.prod.yml 的 image tag 后
docker compose -f docker-compose.prod.yml up -d
```

### 11.2 通过 GitHub Actions 手动触发回滚

`docker.yml` 已支持 `workflow_dispatch`，输入旧版本号即可重新构建并推送旧 tag 的镜像。但更推荐：**保留历史镜像 tag，回滚直接在服务器切换 tag**，不要重新构建。

### 11.3 回滚检查清单

| 步骤 | 命令 | 说明 |
| --- | --- | --- |
| 1. 看当前版本 | `docker inspect fe-depoly-prod --format '{{.Config.Image}}'` | 确认要回滚的版本 |
| 2. 列历史镜像 | `docker images \| grep fe-depoly` | 找到目标 tag |
| 3. 拉取旧版本 | `docker pull <registry>/cjdemo29/fe-depoly:0.9.0` | 服务器上 |
| 4. 切换 | 改 compose 的 image tag + `up -d` | 或 `docker run` |
| 5. 验证 | `curl http://localhost/healthz` | 健康检查 |
| 6. 看日志 | `docker logs -f fe-depoly-prod` | 确认无报错 |

## 十二、生产加固

### 12.1 HTTPS（Caddy 反向代理，最简方案）

不直接在 nginx 容器配证书，用 Caddy 自动签发 + 续期 Let's Encrypt：

```yaml
# docker-compose.prod.yml
services:
  web:
    # 阿里云 ACR（国内推荐）
    image: crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0
    # 或 ghcr.io/yourname/fe-depoly:1.0.0
    expose:
      - "80"  # 仅容器内可见，不直接对外
    restart: always
    networks: [internal]

  caddy:
    image: caddy:alpine
    container_name: caddy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    restart: always
    networks: [internal]

volumes:
  caddy_data:
  caddy_config:

networks:
  internal:
```

`Caddyfile`：

```
fe.example.com {
    reverse_proxy web:80
    encode gzip
}
```

启动后 Caddy 自动签发证书，访问 `https://fe.example.com` 即可。

### 12.2 资源限制

避免单个容器吃光内存导致 OOM：

```yaml
deploy:
  resources:
    limits:
      cpus: "1.0"       # 最多 1 核
      memory: 256M      # 最多 256M 内存
    reservations:
      cpus: "0.25"
      memory: 64M
```

> 注意：`deploy.resources` 在 `docker compose up` 下只起声明作用，真正生效要用 `docker swarm` 或 `docker service`。单机限制要用 `mem_limit` / `cpus`（compose v2 兼容）：

```yaml
services:
  web:
    image: ...
    mem_limit: 256m
    cpus: 1.0
```

### 12.3 日志轮转

不限制日志会把磁盘撑爆：

```yaml
logging:
  driver: json-file
  options:
    max-size: "50m"
    max-file: "10"
```

或全局配置 `/etc/docker/daemon.json`：

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "10"
  }
}
```

改完重启 docker：`sudo systemctl restart docker`。

### 12.4 镜像漏洞扫描

CI 中加 Trivy 扫描：

```yaml
- name: Trivy scan
  uses: aquasecurity/trivy-action@master
  with:
    # 阿里云 ACR
    image-ref: ${{ secrets.ALIYUN_REGISTRY }}/cjdemo29/fe-depoly:${{ steps.meta.outputs.VERSION }}
    # 或 GHCR: ghcr.io/${{ github.repository_owner }}/fe-depoly:${{ steps.meta.outputs.VERSION }}
    severity: CRITICAL,HIGH
    exit-code: 1  # 有高危漏洞就失败
```

### 12.5 非 root 运行

nginx:alpine 默认以 root 启动 worker。生产建议用 unprivileged nginx：

```dockerfile
FROM nginxinc/nginx-unprivileged:alpine AS runner
# 端口改为 8080（非特权用户不能绑 80）
EXPOSE 8080
```

对应 nginx 配置 `listen 8080;`，compose `ports: ["80:8080"]`。

## 十三、踩坑点汇总

1. **`base` 路径不匹配**：Vite 默认 `base: '/'`，如果改成子路径必须同步改 nginx `location`。自建部署推荐用根路径
2. **没有 `.dockerignore`**：`COPY . .` 会把 `node_modules`（数百 MB）打进构建上下文，构建极慢
3. **Dockerfile 层顺序错**：`COPY . .` 放 `npm ci` 前面，每次改代码都重装依赖，缓存全失效
4. **单阶段构建**：镜像 1GB+，拉取慢、攻击面大。必须多阶段
5. **`daemon off;` 漏写**：nginx 默认后台运行，docker 会认为进程退出而停止容器。`CMD ["nginx", "-g", "daemon off;"]` 必写
6. **`HEALTHCHECK` 不写**：容器假死（nginx 卡住但进程还在）不会被识别，负载均衡不会摘除。一定要配
7. **日志不轮转**：跑几个月后磁盘满了。`max-size` + `max-file` 必配
8. **用 `latest` tag 上生产**：`docker pull <registry>/fe-depoly:latest` 拉到的"latest"可能不稳定。生产必须用具体版本号
9. **没测就推**：本地不跑 `docker build && docker run` 验证就推到仓库，CI 失败才发现 Dockerfile 写错。流程是：本地构建 → 本地运行验证 → 推送
10. **端口冲突**：服务器 80 端口被占用（多半是宿主 nginx），`docker run -p 80:80` 会报 `bind: address already in use`。先 `lsof -i :80` 排查
11. **容器时区错**：默认 UTC，日志时间差 8 小时。Dockerfile 里 `cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime`
12. **HTTPS 证书忘了续期**：Let's Encrypt 证书 90 天过期，忘了续期网站就挂。用 Caddy / certbot 自动续期
13. **Watchtower 误更新**：`latest` tag 被覆盖后 Watchtower 自动拉新版本，可能把生产环境搞挂。Watchtower 监控的具体版本容器，不要监控 `latest`
14. **构建上下文太大**：`docker build` 时打印 `=> transferring context: 500MB` 说明没写 `.dockerignore`，构建慢
15. **ARM vs x86**：M 系列 Mac 默认构建 arm64 镜像，推到 x86 服务器跑不了。需要 `docker buildx build --platform linux/amd64` 多架构构建

## 十四、本仓库落地步骤

按以下顺序在 `fe-depoly` 仓库落地 Docker 部署：

1. **改 `vite.config.ts`**：`base: '/'`（如要保留 GitHub Pages，用环境变量切换）
2. **新建 `nginx/conf.d/fe-depoly.conf`**：照搬本文第四节
3. **新建 `Dockerfile`**：照搬本文第五节
4. **新建 `.dockerignore`**：照搬本文第六节
5. **本地验证**：
   ```bash
   docker build -t fe-depoly:1.0.0 .
   docker run --rm -p 8080:80 fe-depoly:1.0.0
   open http://localhost:8080/
   ```
6. **新建 `docker-compose.yml`**：本地编排，照搬本文第八节
7. **推阿里云 ACR**：开通个人版 + 创建仓库 + 登录推送，照搬本文第 9.2 节（国内服务器首选）
8. **新建 `.github/workflows/docker.yml`**：照搬本文第十节（版本 A 推阿里云 ACR / 版本 B 推 GHCR）
9. **服务器部署**：装 Docker + 拉镜像 + Compose 启动，照搬本文第 9.5、9.6 节
10. **生产加固**：Caddy HTTPS + 日志轮转 + Trivy 扫描，照搬本文第十二节

完成后，本仓库的部署链路就升级为：**push tag → CI 自动构建推阿里云 ACR → 服务器拉取 → Compose 启动**，比 GitHub Pages 更接近生产实战。

## 十五、从零购买云主机并首次部署

> 本节面向"还没有服务器"的同学，从选机型、买机器、初始化、装 Docker 到把镜像跑起来，完整走一遍。已有服务器的可跳到第 9.5 节。

### 15.1 选云厂商

| 厂商 | 适合 | 最低价 | 备注 |
| --- | --- | --- | --- |
| 阿里云 ECS | 国内用户 | ~24 元/月（1 核 2G 突发型） | 国内访问快，需 ICP 备案才能用 80/443 |
| 腾讯云 CVM | 国内用户 | ~24 元/月 | 同上，新用户折扣大 |
| 华为云 ECS | 企业 | ~30 元/月 | 政企项目多用 |
| AWS Lightsail | 海外用户 | $5/月 | 全球节点，配置简单 |
| Vultr / DigitalOcean | 海外用户 | $5/月 | 按小时计费，开箱即用 |

**选型建议：**

- 个人学习 / 国内用户：阿里云 / 腾讯云 1 核 2G 突发型，新用户首年常 99-199 元
- 海外用户 / 不想备案：AWS Lightsail 新加坡 / 东京节点，或 Vultr
- 短期测试：Vultr 按小时计费，用完删

### 15.2 配置选型

前端静态站资源占用很低，最低配置就够：

| 配置 | CPU | 内存 | 系统盘 | 带宽 | 月费 | 适合 |
| --- | --- | --- | --- | --- | --- | --- |
| 最低 | 1 核 | 1G | 40G | 1Mbps | ~24 元 | 个人 demo |
| 推荐 | 1 核 | 2G | 40G | 3Mbps | ~50 元 | 小流量生产 |
| 富裕 | 2 核 | 4G | 60G | 5Mbps | ~120 元 | 多服务 / 未来扩展 |

**地域选择：**

- 国内用户为主 → 国内节点（杭州 / 北京 / 上海 / 广州）
- 海外用户 → 香港 / 新加坡 / 东京 / 美西
- 跨国：用 CDN，不要靠源站扛

**系统镜像：** Ubuntu 22.04 LTS（社区文档多、apt 装 Docker 顺手）。CentOS 已停止维护，不推荐。

### 15.3 购买流程（以阿里云 ECS 为例）

1. 注册阿里云账号 → 实名认证（个人账号扫身份证即可）
2. 控制台 → 云服务器 ECS → 创建实例
3. 配置：
   - 计费方式：包年包月（长期）或按量付费（短期测试）
   - 地域：华东 1（杭州）等
   - 实例规格：`ecs.t6-c1m2.large`（1 核 2G 突发型）
   - 镜像：Ubuntu 22.04 64 位
   - 系统盘：ESSD Entry 40G
   - 带宽：按固定带宽 3Mbps（不要按流量，流量计费容易爆账单）
   - 安全组：开放 22 (SSH) / 80 (HTTP) / 443 (HTTPS) / 自定义 8080
4. 设置认证方式：
   - 推荐：密钥对（更安全）→ 创建密钥对 → 下载 `.pem` 文件 → 绑定到实例
   - 备选：自定义密码（复杂一点）
5. 确认订单 → 创建

创建完成后在实例列表看到**公网 IP**，记下来。

### 15.4 首次登录

```bash
# 用密钥登录（推荐）
# 注意 .pem 文件权限必须 400，否则 ssh 拒绝
chmod 400 ~/Downloads/fe-depoly-key.pem
ssh -i ~/Downloads/fe-depoly-key.pem root@<公网IP>

# 用密码登录
ssh root@<公网IP>
```

首次登录会提示 host fingerprint，输 `yes` 确认。

### 15.5 服务器初始化

#### 15.5.1 更新系统

```bash
apt update && apt upgrade -y
# 安装常用工具
apt install -y curl wget git vim ufw fail2ban
```

#### 15.5.2 创建非 root 用户

```bash
# 创建用户 deploy
adduser deploy
# 加入 sudo 组
usermod -aG sudo deploys
# 切到 deploy 测试 sudo
su - deploy
sudo whoami  # 应该输出 root
```

#### 15.5.3 配置 SSH 密钥免密

在**本地**机器
```bash
# 把本地公钥追加到服务器 deploy 用户的 authorized_keys
ssh-copy-id -i ~/.ssh/id_ed25519.pub deploy@<公网IP>

# 或手动：
scp ~/.ssh/id_ed25519.pub deploy@<公网IP>:/tmp/
ssh deploy@<公网IP> "mkdir -p ~/.ssh && cat /tmp/id_ed25519.pub >> ~/.ssh/authorized_keys \
  && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"
```

测试：`ssh deploy@<公网IP>` 应该免密直接进。

#### 15.5.4 加固 SSH

```bash
# 在服务器上用 deploy 用户
sudo vim /etc/ssh/sshd_config
```

改这几项：

```
PermitRootLogin no              # 禁止 root 直接登录
PasswordAuthentication no       # 禁止密码登录（必须先确认密钥能登）
PubkeyAuthentication yes
Port 22                         # 可改成非 22 端口，减少扫描（可选）
```

重载 sshd：

```bash
sudo systemctl reload sshd
```

> ⚠️ 改完**先开一个新终端测试能登录**，再关原终端。否则一旦配置错可能再也进不去。

#### 15.5.5 配置防火墙（ufw）

```bash
# 只放行 SSH / HTTP / HTTPS
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

> 云厂商还有一层"安全组"，ufw 是主机层。两层都要放行对应端口。

#### 15.5.6 设置时区

```bash
sudo timedatectl set-timezone Asia/Shanghai
timedatectl  # 验证
```

#### 15.5.7 配置 fail2ban（防 SSH 暴力破解）

```bash
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd  # 看封禁情况
```

### 15.6 安装 Docker

#### 15.6.1 一键脚本安装

```bash
# 官方脚本（海外服务器用）
curl -fsSL https://get.docker.com | sudo sh

# 国内服务器：get.docker.com 可能被墙，改用阿里云镜像源安装
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

> 一键脚本 `curl -fsSL https://get.docker.com | sudo sh -s -- --mirror Aliyun` 也可用，但脚本域名本身可能被墙导致 `Connection reset`，所以国内服务器推荐上面这种 apt 源方式。

#### 15.6.2 加入 docker 组（免 sudo）

```bash
sudo usermod -aG docker $USER
# 重新登录生效
exit
ssh deploy@<公网IP>
docker ps  # 不需要 sudo 就能跑
```

#### 15.6.3 配置镜像加速（国内必做）

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.com",
    "https://docker.1ms.run"
  ],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "10"
  }
}
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker
```

#### 15.6.4 验证

```bash
docker --version
docker compose version
docker run --rm hello-world
```

### 15.7 拉取镜像并启动

#### 15.7.1 登录镜像仓库

```bash
# 阿里云 ACR（国内推荐，公开镜像可跳过登录）
docker login --username=<阿里云账号> crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com
# 密码是 ACR Registry 登录密码（在阿里云容器镜像服务控制台设置）

# Docker Hub（海外服务器）
docker login
# 输入用户名 + Access Token

# GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u yourname --password-stdin
```

#### 15.7.2 拉取镜像

```bash
# 阿里云 ACR
docker pull crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0

# Docker Hub / GHCR
docker pull yourname/fe-depoly:1.0.0

docker images
```

#### 15.7.3 用 Compose 启动（推荐）

在服务器上准备目录：

```bash
mkdir -p ~/fe-depoly && cd ~/fe-depoly
```

把仓库的 `docker-compose.prod.yml` 上传过来（本地执行）：

```bash
scp docker-compose.prod.yml deploy@<公网IP>:~/fe-depoly/
```

服务器上：

```bash
cd ~/fe-depoly
# 把 image 改成实际的阿里云 ACR 地址
sed -i 's|crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly|<你的完整镜像名>|g' docker-compose.prod.yml
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

#### 15.7.4 验证

```bash
# 容器内健康检查
curl http://localhost/healthz
# ok

# 外部访问
curl http://<公网IP>/
# 应返回 HTML

# 浏览器访问
open http://<公网IP>/
```

### 15.8 绑定域名（可选但推荐）

#### 15.8.1 买域名

阿里云 / 腾讯云 / Namesilo / Cloudflare 都行。`.com` 一年 ~60 元。

#### 15.8.2 ICP 备案（仅国内服务器必需）

> 国内服务器用 80/443 端口必须备案，否则阿里云会拦截。备案周期 7-20 个工作日。

阿里云控制台 → 备案 → 新增备案 → 按提示上传身份证、域名证书、人脸识别。备案通过后才能正常访问。

> 海外服务器 / 香港服务器无需备案，但国内访问稍慢。

#### 15.8.3 DNS 解析

域名控制台 → 解析 → 添加记录：

| 记录类型 | 主机记录 | 记录值 |
| --- | --- | --- |
| A | @ | <服务器公网 IP> |
| A | www | <服务器公网 IP> |

等 1-10 分钟生效，`ping yourdomain.com` 应该解析到你的 IP。

### 15.9 配置 HTTPS（Caddy 自动签发）

直接用第 12.1 节的 Caddy 方案。在 `~/fe-depoly/` 下创建 `Caddyfile`：

```
fe.example.com {
    reverse_proxy web:80
    encode gzip
}
```

完整 `docker-compose.prod.yml`：

```yaml
services:
  web:
    # 阿里云 ACR（国内推荐）
    image: crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0
    container_name: fe-depoly-prod
    expose:
      - "80"
    restart: always
    networks: [internal]

  caddy:
    image: caddy:alpine
    container_name: caddy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    restart: always
    networks: [internal]

volumes:
  caddy_data:
  caddy_config:

networks:
  internal:
    driver: bridge
```

启动：

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f caddy  # 看证书签发过程
```

Caddy 首次启动会自动向 Let's Encrypt 申请证书，1-2 分钟后访问 `https://yourdomain.com` 即可。

### 15.10 后续更新流程

代码改完后：

```bash
# 本地：推 tag 触发 CI 构建并推 GHCR
git tag v1.0.1
git push origin v1.0.1

# 等 CI 构建完成（GitHub Actions 页面看）

# 服务器：拉新镜像重启
ssh deploy@<公网IP>
cd ~/fe-depoly
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
# 旧容器自动替换，秒级切换
```

### 15.11 日常运维命令

```bash
# 看容器状态
docker compose -f docker-compose.prod.yml ps

# 看实时日志
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f caddy

# 重启某个服务
docker compose -f docker-compose.prod.yml restart web

# 进容器排查
docker exec -it fe-depoly-prod sh

# 看资源占用
docker stats

# 清理无用镜像（释放磁盘）
docker image prune -a
```

### 15.12 首次部署检查清单

| 步骤 | 命令 | 预期 |
| --- | --- | --- |
| 1. SSH 免密登录 | `ssh deploy@<IP>` | 不输密码直接进 |
| 2. Docker 已装 | `docker --version` | 输出版本号 |
| 3. 镜像已拉 | `docker images` | 看到 fe-depoly |
| 4. 容器在跑 | `docker ps` | STATUS 列显示 Up |
| 5. 健康检查 | `curl localhost/healthz` | 返回 ok |
| 6. 公网访问 | 浏览器开 `http://<IP>` | 看到首页 |
| 7. 域名解析 | `ping yourdomain.com` | 解析到你的 IP |
| 8. HTTPS | 浏览器开 `https://yourdomain.com` | 锁标 + 首页 |

### 15.13 常见问题

**Q: 浏览器访问 IP 但页面打不开？**

- 检查 `docker ps` 容器是否在跑
- 检查 `ufw status` 80 是否放行
- 检查云厂商安全组 80 是否放行（最常见的坑）
- `curl http://localhost` 看容器内是否正常

**Q: 国内访问国外服务器慢？**

- 换国内节点 + ICP 备案
- 或上 CDN（Cloudflare 免费档够个人用）

**Q: 80 端口被占用？**

```bash
sudo lsof -i :80
# 多半是宿主 nginx，停掉：
sudo systemctl stop nginx
sudo systemctl disable nginx
```

**Q: 磁盘满了？**

```bash
df -h
# 清理 docker 无用镜像/卷
docker system prune -a --volumes
```

**Q: docker pull 拉镜像超时？**

- 国内服务器拉 Docker Hub 镜像必须配镜像加速（第 15.6.3 节）
- 推荐直接用阿里云 ACR，国内拉取稳定不超时
- Docker Hub 登录超时（`registry-1.docker.io` 被墙）：登录接口走不了加速器，必须换阿里云 ACR 或 GHCR

**Q: docker login 报 `context deadline exceeded`？**

多半是国内服务器登录 Docker Hub 超时。解决方案：

1. 改用阿里云 ACR（推荐）
2. 改用 GHCR（GitHub 走的域名国内可访问）
3. 实在要用 Docker Hub：本地推送 + 服务器走镜像加速器匿名拉取（public 镜像）

**Q: ARM 服务器跑不了 x86 镜像？**

部分云厂商（如 AWS Graviton、阿里云倚天）是 ARM 架构。本地 Mac M 系列构建的镜像默认 arm64，需多架构构建：

```bash
# 本地构建时指定多架构
docker buildx build --platform linux/amd64,linux/arm64 \
  -t crpi-xxxxxxxx.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0 --push .
```

## 十六、参考链接

- Docker 官方文档：https://docs.docker.com/
- Dockerfile 最佳实践：https://docs.docker.com/develop/develop-images/dockerfile_best-practices/
- 多阶段构建：https://docs.docker.com/build/building/multi-stage/
- Docker Compose 文档：https://docs.docker.com/compose/
- nginx 官方镜像：https://hub.docker.com/_/nginx
- 阿里云容器镜像服务 ACR：https://help.aliyun.com/document_detail/60716.html
- GHCR 文档：https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- Watchtower：https://containrrr.dev/watchtower/
- Trivy：https://aquasecurity.github.io/trivy/
- Caddy：https://caddyserver.com/docs/
- buildx 多架构构建：https://docs.docker.com/build/building/multi-platform/
