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
    image: yourname/fe-depoly:1.0.0
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

| 仓库 | 免费档 | 适合 |
| --- | --- | --- |
| Docker Hub | 1 个私有仓库 + 无限公开 | 个人项目 |
| GitHub Container Registry (GHCR) | 私有仓库免费 | 与 GitHub 仓库同权限 |
| 阿里云 ACR | 个人版免费 | 国内拉取快 |
| 腾讯云 TCR / 华为 SWR | 个人版免费 | 国内云用户 |

### 9.2 推送到 Docker Hub

```bash
# 1. 注册 hub.docker.com 账号
# 2. 在 Account Settings → Security 创建 Access Token（不要用密码）

# 3. 本地登录
docker login
# 输入用户名 + Token

# 4. 给镜像打 tag（必须带用户名前缀）
docker tag fe-depoly:1.0.0 yourname/fe-depoly:1.0.0
docker tag fe-depoly:1.0.0 yourname/fe-depoly:latest

# 5. 推送
docker push yourname/fe-depoly:1.0.0
docker push yourname/fe-depoly:latest
```

### 9.3 推送到 GHCR（推荐，与 GitHub 仓库同权限）

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

### 9.4 服务器部署

假设服务器 `1.2.3.4`，已装 Docker：

```bash
# SSH 上服务器
ssh user@1.2.3.4

# 1. 登录镜像仓库（首次）
docker login  # 或 ghcr.io

# 2. 拉取镜像
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
  yourname/fe-depoly:1.0.0

# 5. 验证
curl http://localhost/healthz
# ok
```

### 9.5 用 Compose 在服务器部署（更推荐）

把 `docker-compose.prod.yml` 复制到服务器，后续部署只需两条命令：

```bash
# 服务器上
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

## 十、CI 自动构建并推送

### 10.1 GitHub Actions workflow

在 `.github/workflows/` 新增 `docker.yml`：

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
#    docker.yml 构建并推镜像到 GHCR
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
# 服务器上
docker pull yourname/fe-depoly:0.9.0
docker stop fe-depoly-prod
docker rm fe-depoly-prod
docker run -d --name fe-depoly-prod -p 80:80 --restart always \
  yourname/fe-depoly:0.9.0

# 用 Compose 更简洁：改 docker-compose.prod.yml 的 image tag 后
docker compose -f docker-compose.prod.yml up -d
```

### 11.2 通过 GitHub Actions 手动触发回滚

`docker.yml` 已支持 `workflow_dispatch`，输入旧版本号即可重新构建并推送旧 tag 的镜像。但更推荐：**保留历史镜像 tag，回滚直接在服务器切换 tag**，不要重新构建。

### 11.3 回滚检查清单

| 步骤 | 命令 | 说明 |
| --- | --- | --- |
| 1. 看当前版本 | `docker inspect fe-depoly-prod --format '{{.Config.Image}}'` | 确认要回滚的版本 |
| 2. 列历史镜像 | `docker images yourname/fe-depoly` | 找到目标 tag |
| 3. 拉取旧版本 | `docker pull yourname/fe-depoly:0.9.0` | 服务器上 |
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
    image: ghcr.io/yourname/fe-depoly:1.0.0
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
    image-ref: ghcr.io/${{ github.repository_owner }}/fe-depoly:${{ steps.meta.outputs.VERSION }}
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
8. **用 `latest` tag 上生产**：`docker pull yourname/fe-depoly:latest` 拉到的"latest"可能不稳定。生产必须用具体版本号
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
7. **推 GHCR**：注册 PAT，照搬本文第 9.3 节
8. **新建 `.github/workflows/docker.yml`**：照搬本文第十节
9. **服务器部署**：装 Docker + 拉 GHCR 镜像 + Compose 启动，照搬本文第 9.4、9.5 节
10. **生产加固**：Caddy HTTPS + 日志轮转 + Trivy 扫描，照搬本文第十二节

完成后，本仓库的部署链路就升级为：**push tag → CI 自动构建推 GHCR → 服务器拉取 → Compose 启动**，比 GitHub Pages 更接近生产实战。

## 十五、参考链接

- Docker 官方文档：https://docs.docker.com/
- Dockerfile 最佳实践：https://docs.docker.com/develop/develop-images/dockerfile_best-practices/
- 多阶段构建：https://docs.docker.com/build/building/multi-stage/
- Docker Compose 文档：https://docs.docker.com/compose/
- nginx 官方镜像：https://hub.docker.com/_/nginx
- GHCR 文档：https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- Watchtower：https://containrrr.dev/watchtower/
- Trivy：https://aquasecurity.github.io/trivy/
- Caddy：https://caddyserver.com/docs/
- buildx 多架构构建：https://docs.docker.com/build/building/multi-platform/
