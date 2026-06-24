# CI/CD 自动化部署：代码推送 → 阿里云 ACR → 服务器自动更新

> 配套文档：`doc/docker-depoly.md`（Docker 部署基础）、`doc/cicd.md`（CI/CD 概念）。
> 前置条件：已完成 `docker-depoly.md` 第十五节，本地能构建镜像、推送 ACR、服务器能拉取运行。
> 目标：代码 push 到 `main` 或打 tag 后，**自动**完成"构建镜像 → 推 ACR → 服务器拉取新镜像 → 重启容器"，无需手动 SSH。

## 一、整体流程

```
开发者 push 代码
       │
       ▼
GitHub Actions 触发
       │
       ├─► 1. 检出代码
       ├─► 2. docker buildx build（amd64）
       ├─► 3. docker login 阿里云 ACR
       ├─► 4. docker push 镜像（带版本 tag + latest）
       │
       ▼
   触发服务器更新（两种方式）
       │
       ├─► 方案 A: Watchtower 自动监听镜像更新并重启容器
       │   (服务器主动拉，CI 不需要 SSH 权限)
       │
       └─► 方案 B: CI 通过 SSH 登录服务器执行 pull + up
           (CI 主动推，可控性更强，有部署日志)
```

## 二、两种方案对比

| 维度 | 方案 A: Watchtower | 方案 B: SSH 主动部署 |
| --- | --- | --- |
| 原理 | 服务器定时轮询 ACR，发现新镜像就重启 | CI 构建完 SSH 到服务器执行部署命令 |
| 延迟 | 30-60 秒（轮询间隔） | 10-20 秒（构建完立即触发） |
| 可控性 | 弱（自动更新，难审计） | 强（每次部署有日志，可回溯） |
| 回滚 | 切 tag 即可，但 Watchtower 也会自动切 | 切 tag 后再触发一次部署 |
| 复杂度 | 服务器多跑一个容器 | CI 需要服务器 SSH 私钥 |
| 适合 | 个人项目、demo | 生产环境、团队协作 |

**推荐组合**：

- 个人项目 / 学习：**方案 A**（5 分钟搞定）
- 生产环境 / 团队：**方案 B**（可控、可审计、可回滚）
- 也可两者结合：CI 主动部署 + Watchtower 兜底（防止 CI 挂了）

## 三、准备工作（两种方案都要做）

### 3.1 在 GitHub 仓库配置 Secrets

进入仓库 `Settings → Secrets and variables → Actions → New repository secret`，添加以下 5 个：

| Secret 名 | 值 | 用途 |
| --- | --- | --- |
| `ALIYUN_REGISTRY` | `crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com` | ACR registry 地址 |
| `ALIYUN_NAMESPACE` | `cjdemo29` | 命名空间 |
| `ALIYUN_USERNAME` | 阿里云账号 | docker login 用户名 |
| `ALIYUN_PASSWORD` | ACR Registry 登录密码 | docker login 密码（不是阿里云账号密码） |
| `SSH_HOST` | `113.31.107.142` | 服务器公网 IP（方案 B 必需） |
| `SSH_USER` | `ubuntu` | SSH 用户名（方案 B 必需） |
| `SSH_PRIVATE_KEY` | 服务器登录私钥内容（方案 B 必需） | CI 用来 SSH 登录服务器 |

> Secret 配好后无法再查看，只能更新。所以填错时直接重新覆盖即可。

### 3.2 生成 SSH 密钥对（方案 B 需要）

在**本地**生成专用密钥（不要复用你日常 SSH 密钥）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/fe-depoly-deploy-key -N "" -C "github-actions-deploy"
```

生成两个文件：

- `~/.ssh/fe-depoly-deploy-key` —— **私钥**（粘贴到 GitHub Secret `SSH_PRIVATE_KEY`）
- `~/.ssh/fe-depoly-deploy-key.pub` —— 公钥（追加到服务器）

### 3.3 服务器配置公钥

```bash
# 本地执行：把公钥上传到服务器
ssh-copy-id -i ~/.ssh/fe-depoly-deploy-key.pub ubuntu@113.31.107.142

# 或手动追加
scp ~/.ssh/fe-depoly-deploy-key.pub ubuntu@113.31.107.142:/tmp/
ssh ubuntu@113.31.107.142 "mkdir -p ~/.ssh && cat /tmp/fe-depoly-deploy-key.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

验证免密登录：

```bash
ssh -i ~/.ssh/fe-depoly-deploy-key ubuntu@113.31.107.142 "echo ok"
# 应该不输密码直接输出 ok
```

### 3.4 服务器准备部署目录

```bash
# 服务器上执行
mkdir -p ~/fe-depoly && cd ~/fe-depoly

# 创建 docker-compose.prod.yml（image 用 ACR 地址）
cat > docker-compose.prod.yml <<'EOF'
services:
  web:
    image: crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/ceshi:latest
    container_name: fe-depoly-prod
    ports:
      - "80:80"
    restart: always
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost/healthz"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 5s
    mem_limit: 256m
    cpus: 1.0
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "10"
    networks:
      - fe-net
    labels:
      - "com.centurylinklabs.watchtower.enable=true"

  watchtower:
    image: containrrr/watchtower
    container_name: watchtower
    restart: always
    volumes:
      # 让 watchtower 能调用 docker API（必须）
      - /var/run/docker.sock:/var/run/docker.sock
      # 读取 ACR 登录凭证（私有镜像必加；公开镜像可删这行）
      - /home/ubuntu/.docker/config.json:/config.json:ro
    command: >
      --interval 60
      --cleanup
      --label-enable
      --stop-timeout 30s
      fe-depoly-prod
    environment:
      - TZ=Asia/Shanghai
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - fe-net

networks:
  fe-net:
    driver: bridge
EOF
```

> 注意 image 用 `:latest` tag，CI 每次推新版本会覆盖 latest。生产环境也建议同时打版本 tag，方便回滚。

### 3.5 服务器登录 ACR（私有镜像需要，公开可跳过）

```bash
# 服务器上执行一次，凭证会保存在 ~/.docker/config.json
docker login --username=<阿里云账号> crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com
```

## 四、方案 A：Watchtower 自动更新

### 4.1 服务器上启动 Watchtower

修改 `~/fe-depoly/docker-compose.prod.yml`，追加 watchtower 服务：

```yaml
services:
  web:
    image: crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/ceshi:latest
    container_name: fe-depoly-prod
    ports:
      - "80:80"
    restart: always
    # ...（同 3.4）

  watchtower:
    image: containrrr/watchtower
    container_name: watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ~/.docker/config.json:/config.json:ro  # 读取 ACR 登录凭证
    command: --interval 60 --cleanup fe-depoly-prod
    restart: always
```

参数说明：

- `--interval 60`：每 60 秒检查一次镜像更新
- `--cleanup`：更新后删除旧镜像，避免磁盘塞满
- `fe-depoly-prod`：只监控这个容器（不指定会监控所有运行中容器，**不要**这样）

启动：

```bash
cd ~/fe-depoly
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
# 应该看到 web 和 watchtower 都在 Up 状态
```

### 4.2 GitHub Actions workflow

在仓库创建 `.github/workflows/docker.yml`：

```yaml
name: Docker Build & Push

on:
  push:
    branches: [main]
    tags: ['v*.*.*']
  workflow_dispatch:
    inputs:
      tag:
        description: '镜像 tag（如 1.0.1）'
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

      - name: Extract metadata
        id: meta
        run: |
          # 推 main 分支 → 用 short SHA 做 tag
          # 推 v1.0.0 tag → 用 1.0.0 做 tag
          # 手动触发 → 用输入值
          if [ -n "${{ inputs.tag }}" ]; then
            echo "VERSION=${{ inputs.tag }}" >> $GITHUB_OUTPUT
          elif [[ "${GITHUB_REF}" == refs/tags/v* ]]; then
            echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT
          else
            echo "VERSION=sha-${GITHUB_SHA::7}" >> $GITHUB_OUTPUT
          fi

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: true
          tags: |
            ${{ secrets.ALIYUN_REGISTRY }}/${{ secrets.ALIYUN_NAMESPACE }}/ceshi:${{ steps.meta.outputs.VERSION }}
            ${{ secrets.ALIYUN_REGISTRY }}/${{ secrets.ALIYUN_NAMESPACE }}/ceshi:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: false
          sbom: false
```

### 4.3 工作流程

1. 你 `git push origin main` → GitHub Actions 触发
2. CI 构建镜像，打两个 tag：`sha-abc1234` 和 `latest`，推到 ACR
3. 服务器上的 Watchtower 每 60 秒检查一次，发现 `latest` 有更新
4. Watchtower 自动 `docker pull` 新镜像，重启容器
5. 1 分钟内网站更新完成

### 4.4 验证 Watchtower 在工作

```bash
# 服务器上看 watchtower 日志
docker logs -f watchtower
# 应该看到类似：
# "Checking containers for updated images"
# "Found new image: crpi-...ceshi:latest"
# "Stopping /fe-depoly-prod ..."
# "Starting /fe-depoly-prod ..."
```
w
## 五、方案 B：SSH 主动部署（推荐）

### 5.1 GitHub Actions workflow

```yaml
name: Build, Push & Deploy

on:
  push:
    branches: [main]
    tags: ['v*.*.*']
  workflow_dispatch:
    inputs:
      tag:
        description: '镜像 tag（如 1.0.1）'
        required: true

jobs:
  build-and-deploy:
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

      - name: Extract metadata
        id: meta
        run: |
          if [ -n "${{ inputs.tag }}" ]; then
            echo "VERSION=${{ inputs.tag }}" >> $GITHUB_OUTPUT
          elif [[ "${GITHUB_REF}" == refs/tags/v* ]]; then
            echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT
          else
            echo "VERSION=sha-${GITHUB_SHA::7}" >> $GITHUB_OUTPUT
          fi

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: true
          tags: |
            ${{ secrets.ALIYUN_REGISTRY }}/${{ secrets.ALIYUN_NAMESPACE }}/ceshi:${{ steps.meta.outputs.VERSION }}
            ${{ secrets.ALIYUN_REGISTRY }}/${{ secrets.ALIYUN_NAMESPACE }}/ceshi:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: false
          sbom: false

      - name: Deploy to server via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd ~/fe-depoly
            docker compose -f docker-compose.prod.yml pull
            docker compose -f docker-compose.prod.yml up -d
            docker image prune -f
            # 等待健康检查
            sleep 5
            curl -sf http://localhost/healthz || (echo "Health check failed" && exit 1)
            echo "Deploy success: ${{ steps.meta.outputs.VERSION }}"
```

### 5.2 关键步骤说明

- **`appleboy/ssh-action`**：成熟的 GitHub Actions SSH 工具，比手写 `ssh` 命令稳
- **`docker compose pull`**：拉取 compose 文件里所有服务的最新镜像
- **`docker compose up -d`**：用新镜像重启容器（compose 会检测镜像变化，自动 recreate）
- **`docker image prune -f`**：清理旧镜像，避免磁盘塞满
- **健康检查**：`curl /healthz` 失败时退出码非 0，CI 会标记为失败，便于发现部署问题

### 5.3 工作流程

1. `git push origin main` → CI 触发
2. CI 构建 + 推送镜像到 ACR（约 1-2 分钟）
3. CI 通过 SSH 登录服务器执行部署命令（约 10-20 秒）
4. 健康检查通过 → 部署成功
5. 整个流程 2-3 分钟内完成

CI 失败会在 GitHub Actions 页面显示红色叉，并发邮件通知。

## 六、触发方式

### 6.1 推 main 分支自动部署（开发环境）

```bash
git add .
git commit -m "feat: add xxx"
git push origin main
# → CI 自动构建并部署
```

镜像 tag 是 `sha-abc1234`（commit short SHA）+ `latest`。

### 6.2 打 tag 发布版本（生产环境）

```bash
git tag v1.0.0
git push origin v1.0.0
# → CI 自动构建并部署
```

镜像 tag 是 `1.0.0` + `latest`。

### 6.3 手动触发（回滚 / 重部署）

GitHub 仓库 → Actions → 选中 workflow → `Run workflow` → 输入要部署的版本号。

适合回滚场景：服务器上跑的是 v1.0.1，要回滚到 v1.0.0，手动触发输入 `1.0.0`，CI 会重新构建 v1.0.0 镜像并部署。

## 七、CI/CD 流水线完整示意图

```
┌──────────────────────────────────────────────────────────┐
│  开发者本地                                              │
│  ┌─────────────────┐                                     │
│  │ git push origin │                                     │
│  │   main          │                                     │
│  └────────┬────────┘                                     │
└───────────┼──────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────┐
│  GitHub                                                  │
│  ┌─────────────────────────────────┐                     │
│  │ Actions workflow: docker.yml    │                     │
│  │  ├─ checkout                    │                     │
│  │  ├─ buildx build (amd64)        │  ~1.5 min           │
│  │  ├─ docker login ACR            │                     │
│  │  └─ docker push (2 tags)        │                     │
│  └────────┬────────────────────────┘                     │
└───────────┼──────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────┐
│  阿里云 ACR                                              │
│  ┌─────────────────────────────────┐                     │
│  │ crpi-.../cjdemo29/ceshi:latest  │ ← 覆盖              │
│  │ crpi-.../cjdemo29/ceshi:1.0.0   │ ← 保留（回滚用）    │
│  │ crpi-.../cjdemo29/ceshi:sha-xx  │ ← 保留              │
│  └────────┬────────────────────────┘                     │
└───────────┼──────────────────────────────────────────────┘
            │
            ▼
   ┌────────┴────────┐
   │                 │
   ▼                 ▼
方案 A           方案 B
Watchtower       SSH 主动部署
(轮询)           (CI 触发)
   │                 │
   └────────┬────────┘
            ▼
┌──────────────────────────────────────────────────────────┐
│  服务器 113.31.107.142                                   │
│  ┌─────────────────────────────────┐                     │
│  │ docker compose pull             │                     │
│  │ docker compose up -d            │  ~10-20 sec         │
│  │ → fe-depoly-prod 容器重启       │                     │
│  └─────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────┘
```

## 八、回滚策略

### 8.1 切回旧 tag（最快）

```bash
# 服务器上手动切（不走 CI）
cd ~/fe-depoly
# 改 docker-compose.prod.yml 里的 image tag
sed -i 's|ceshi:latest|ceshi:1.0.0|g' docker-compose.prod.yml
docker compose -f docker-compose.prod.yml up -d
```

### 8.2 通过 CI 手动触发回滚

GitHub Actions → Run workflow → 输入旧版本号 `1.0.0`。CI 会重新构建 1.0.0 镜像并部署。

> 这种方式走完整 CI 流程，会有日志，可审计。生产环境推荐这种方式。

### 8.3 保留历史镜像

ACR 不会自动清理历史 tag，每次推送都会保留。所以可以随时回滚到任意历史版本。

建议定期清理太老的 tag（如半年前的）：

- 阿里云 ACR 控制台 → 镜像仓库 → 镜像版本 → 批量删除
- 或用 aliyun CLI 脚本定时清理

## 九、踩坑点

1. **SSH 私钥格式**：粘贴到 GitHub Secret 时不要带 `cat` 输出的多余换行。完整包含 `-----BEGIN OPENSSH PRIVATE KEY-----` 到 `-----END OPENSSH PRIVATE KEY-----`。
2. **ACR 私有镜像 + Watchtower**：服务器要先 `docker login` 一次，凭证存到 `~/.docker/config.json`，Watchtower 容器要挂载这个文件才能拉私有镜像。
3. **`platforms: linux/amd64`**：Mac 上 CI 跑的是 x86_64 runner，本来就该是 amd64，但显式写出来避免歧义。注意 GitHub Runner 本身就是 x86，不需要 buildx 模拟。
4. **缓存失效**：`cache-from: type=gha` 第一次构建无缓存（约 3 分钟），第二次起命中缓存（约 30 秒）。如果改了 `package.json`，依赖层缓存会失效，但仍比无缓存快。
5. **`workflow_dispatch` 触发的 tag 输入**：不要带 `v` 前缀。输入 `1.0.0` 而不是 `v1.0.0`，否则镜像名变成 `ceshi:v1.0.0` 与自动触发的 `ceshi:1.0.0` 不一致。
6. **Watchtower 监控 `latest` 的坑**：如果用 `latest` tag 上生产，每次推 main 都会覆盖 latest，Watchtower 自动拉新版本——可能把没测过的代码推上线。生产环境推荐用具体版本号 tag，Watchtower 监控具体版本容器，手动改 compose 切版本。
7. **SSH 部署失败但镜像已推**：CI 在 SSH 步骤失败时，镜像已经在 ACR 里了。可以手动 SSH 上服务器跑 `docker compose pull && up -d` 完成部署。
8. **服务器磁盘满**：每次部署会留下旧镜像，`docker image prune -f` 必加。或定期 `docker system prune -a`。
9. **健康检查误报失败**：容器启动后 nginx 还没起来，`curl /healthz` 立即失败。在 SSH 脚本里加 `sleep 5` 再 curl，或用 `--wait --timeout 60` 等容器 healthy。
10. **多分支部署冲突**：如果有 `main` 和 `develop` 都触发部署到同一台服务器，会互相覆盖。建议不同分支部署到不同服务器，或用不同容器名 + 端口。

## 十、本仓库落地步骤

1. **配 GitHub Secrets**（第 3.1 节）：5-7 个 secret
2. **生成 + 配置 SSH 密钥**（第 3.2、3.3 节）：方案 B 需要
3. **服务器准备**（第 3.4 节）：`~/fe-depoly/docker-compose.prod.yml`
4. **选方案**：
   - 方案 A：在 compose 里追加 watchtower 服务（第 4.1 节）
   - 方案 B：直接配 CI workflow（第 5.1 节）
5. **创建 `.github/workflows/docker.yml`**：复制方案 A 或 B 的 yaml
6. **触发验证**：
   ```bash
   # 改个 README，push 看是否触发
   echo "test ci" >> README.md
   git add README.md
   git commit -m "test: trigger ci"
   git push origin main
   ```
7. **观察 Actions**：GitHub 仓库 → Actions 标签页 → 看到黄色转圈 → 绿色对勾说明成功
8. **验证部署**：浏览器访问 `http://113.31.107.142/` 看到新内容

完成后，本仓库的部署链路升级为：

```
git push → CI 自动构建 → ACR 自动推送 → 服务器自动更新 → 网站自动上线
```

**全程无 SSH**，从此部署变成"代码合并即上线"。

## 十一、参考链接

- GitHub Actions 文档：https://docs.github.com/actions
- docker/build-push-action：https://github.com/docker/build-push-action
- appleboy/ssh-action：https://github.com/appleboy/ssh-action
- Watchtower 文档：https://containrrr.dev/watchtower/
- 阿里云 ACR CI/CD 指南：https://help.aliyun.com/document_detail/60716.html
- Docker Buildx 缓存：https://docs.docker.com/build/cache/backends/gha/


services:
    web:
      image: crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/ceshi:latest
      container_name: fe-depoly-prod
      ports:
        - "80:80"
      restart: always
      healthcheck:
        test: ["CMD", "wget", "--spider", "-q", "http://localhost/healthz"]
        interval: 30s
        timeout: 3s
        retries: 3
        start_period: 5s
      mem_limit: 256m
      cpus: 1.0
      logging:
        driver: json-file
        options:
          max-size: "50m"
          max-file: "10"
      networks:
        - fe-net
      labels:
        - "com.centurylinklabs.watchtower.enable=true"

    watchtower:
      image: containrrr/watchtower
      container_name: watchtower
      restart: always
      volumes:
        # 让 watchtower 能调用 docker API（必须）
        - /var/run/docker.sock:/var/run/docker.sock
        # 读取 ACR 登录凭证（私有镜像必加；公开镜像可删这行）
        - /home/ubuntu/.docker/config.json:/config.json:ro
      command: >
        --interval 60
        --cleanup
        --label-enable
        --stop-timeout 30s
        fe-depoly-prod
      environment:
        - TZ=Asia/Shanghai
      logging:
        driver: json-file
        options:
          max-size: "10m"
          max-file: "3"
      networks:
        - fe-net

  networks:
    fe-net:
      driver: bridge