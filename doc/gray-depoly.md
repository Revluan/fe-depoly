# 灰度发布实战：蓝绿部署 vs 金丝雀发布

> 配套文档：`doc/docker-depoly.md`（Docker 部署基础）、`doc/ci-docker.md`（CI/CD 自动化）、`doc/deploy.md` 第七节（灰度方案概览）。
> 前置条件：已完成 `docker-depoly.md` 第十五节，服务器能跑 Docker Compose，ACR 里有 `fe-depoly:1.0.0` 镜像。
> 目标：在同一台服务器上同时部署两个版本（v1 和 v2），用 Nginx 控制流量分配，实现**零停机切换**和**按比例放量**。

## 一、概念辨析：别把这几个词搞混

| 名词 | 英文 | 本质 | 流量切换 | 适用场景 |
| --- | --- | --- | --- | --- |
| **蓝绿部署** | Blue-Green Deployment | 两套完全相同的环境，一前一后，整体切换 | 0% → 100%（一刀切） | 版本切换、零停机发布 |
| **金丝雀发布** | Canary Release | 只把**一部分流量**导到新版本，逐步放量 | 0% → 5% → 25% → 50% → 100% | 风险高的版本、需要观察 |
| **滚动发布** | Rolling Release | 逐个替换实例（K8s 默认策略） | 实例数比例切换 | K8s / 多实例集群 |
| **A/B 测试** | A/B Testing | 按**用户特征**分流（地域/UA/Cookie），用于验证业务假设 | 按特征分群 | 产品功能验证、转化率优化 |

**关键区别：**

- **蓝绿**：要么 v1 要么 v2，**不存在同时服务**的状态（切换瞬间除外）。两个版本都全量部署，只是流量只指向一个。
- **金丝雀**：v1 和 v2 **同时服务**，按比例分流量。出问题可以快速切回 100% v1。
- **灰度发布**：中文语境下通常指**金丝雀**，但广义也包含蓝绿。本文两种都讲。

**选型建议：**

- 个人项目 / 学习：**金丝雀（基于 cookie）**最直观,5 分钟出效果
- 小团队生产：**蓝绿**最稳,切错就回滚
- 大流量 / 风险高版本：**金丝雀按比例放量** + 监控告警

## 二、整体架构

```
                ┌──────────────────────────────┐
                │  服务器 113.31.107.142        │
                │                              │
   用户 ──────► │  Nginx (80)                  │
                │   ├─ 蓝绿: upstream 切换     │
                │   └─ 金丝雀: split_clients   │
                │       │                      │
                │       ├────► web-v1:80       │ ← fe-depoly:1.0.0
                │       └────► web-v2:80       │ ← fe-depoly:1.0.1
                │                              │
                └──────────────────────────────┘
```

核心思路:

- **两个 web 容器**分别跑不同版本,通过 `expose` 在容器网络内通信(不映射到宿主端口)
- **一个 nginx 容器**做反向代理,根据策略把请求转到对应版本的 upstream
- 不再用 `fe-depoly-prod` 单容器,改用 `web-v1` + `web-v2` 双容器

> 这种架构跟生产环境很像——生产 LB 后面挂多个实例,本课用 nginx + 两个容器模拟。

## 三、Nginx 配置管理策略(重要)

### 3.1 配置放哪里:项目仓库,不是服务器

**配置归属判断**:

| 部署形态 | 配置归属 | 管理方式 |
| --- | --- | --- |
| 单容器(nginx + web 同体) | 应用配置 | 项目仓库 → 构建时 COPY 进镜像 |
| **独立 nginx 容器(灰度场景)** | **基础设施配置** | **项目仓库 → 部署时挂载** |

灰度场景的 nginx 是**反向代理**,要协调 v1/v2 两个容器,配置改动需要 `nginx -s reload` 即时生效(不能重新构建镜像)。所以:

- **配置文件放项目仓库**(`nginx/canary/`、`nginx/bluegreen/`):版本控制、可 review、可回滚
- **部署时同步到服务器**:通过 `git pull` + `cp` 把配置同步到部署目录
- **nginx 容器挂载服务器上的配置文件**:volume 挂载,改文件后 reload 生效

### 3.2 仓库目录结构

```
fe-depoly/
├── nginx/
│   ├── conf.d/
│   │   └── fe-depoly.conf          # 单容器版(进镜像,Dockerfile 用)
│   ├── canary/
│   │   ├── nginx.conf              # 金丝雀 Cookie 分流
│   │   └── nginx-splitclients.conf # 金丝雀按比例分流
│   └── bluegreen/
│       └── nginx.conf              # 蓝绿切换
├── docker/
│   ├── docker-compose.canary.yml   # 金丝雀 compose
│   └── docker-compose.bluegreen.yml# 蓝绿 compose
└── doc/
    └── gray-depoly.md              # 本文档
```

### 3.3 服务器部署目录结构

```
~/fe-depoly-canary/         # 金丝雀部署目录
├── docker-compose.yml      # 从仓库 docker/ 同步
└── nginx.conf              # 从仓库 nginx/canary/ 同步

~/fe-depoly-bluegreen/      # 蓝绿部署目录
├── docker-compose.yml      # 从仓库 docker/ 同步
└── nginx.conf              # 从仓库 nginx/bluegreen/ 同步

~/fe-depoly/                # 仓库 clone(用来同步配置)
└── (仓库内容)
```

### 3.4 同步流程(每次改配置)

```bash
# 本地:改配置,提交,push
git add nginx/canary/nginx.conf
git commit -m "chore: adjust canary percentage to 25%"
git push origin main

# 服务器:pull + 同步到部署目录 + reload
cd ~/fe-depoly
git pull origin main
cp nginx/canary/nginx.conf ~/fe-depoly-canary/nginx.conf
docker exec canary-nginx nginx -t
docker exec canary-nginx nginx -s reload
```

**优点**:
- 配置在版本控制里,改错了能 `git revert`
- 多人协作时配置变更可 review
- 多服务器部署配置一致
- 部署历史可追溯(看 git log)

## 四、准备工作

### 4.1 确保有两个版本的镜像

当前 ACR 里应该有 `1.0.0` 和 `latest`。为了演示灰度,我们需要一个**新版本**镜像。

```bash
# 本地改个文案,打 v1.0.1 tag,push 触发 CI 构建 1.0.1
git tag v1.0.1
git push origin v1.0.1
# CI 会构建并推送 fe-depoly:1.0.1 + fe-depoly:latest
```

验证 ACR 里有两个版本(服务器上拉一下):

```bash
docker pull crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0
docker pull crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.1
docker images | grep fe-depoly
```

### 4.2 停掉旧的单容器部署

之前的 `fe-depoly-prod` 容器占用 80 端口,要先停掉:

```bash
cd ~/fe-depoly
docker compose -f docker-compose.prod.yml down
docker ps | grep ":80->"  # 应该没输出
```

### 4.3 在服务器 clone 仓库(用来同步配置)

```bash
cd ~
git clone git@github.com:Revluan/fe-depoly.git fe-depoly-repo
# 或 https:git clone https://github.com/Revluan/fe-depoly.git fe-depoly-repo
```

后续改配置都在仓库里改,通过 `git pull` 同步到服务器。

## 五、方案 A:蓝绿部署(Blue-Green)

### 5.1 原理

```
切换前(蓝):
   用户 ──► Nginx ──► web-blue (v1.0.0)
                       web-green (v1.0.1) ← 已启动但没流量

切换后(绿):
   用户 ──► Nginx ──► web-green (v1.0.1)
   web-blue (v1.0.0) ← 保留待回滚
```

两个环境**都全量部署**,nginx 只把流量指向其中一个。切换 = 改 nginx upstream + reload,1 秒内完成。

### 5.2 仓库里的配置文件

仓库 `nginx/bluegreen/nginx.conf`(已创建好):

```nginx
upstream backend {
    # 蓝色环境(当前版本)
    server web-blue:80;
    # 绿色环境(新版本)—— 切换时取消注释
    # server web-green:80;
}

server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /healthz {
        proxy_pass http://backend/healthz;
    }
}
```

仓库 `docker/docker-compose.bluegreen.yml`:

```yaml
services:
  web-blue:
    image: crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0
    container_name: web-blue
    restart: always
    expose: ["80"]
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost/healthz"]
      interval: 30s
      timeout: 3s
      retries: 3
    networks: [bg-net]

  web-green:
    image: crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.1
    container_name: web-green
    restart: always
    expose: ["80"]
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost/healthz"]
      interval: 30s
      timeout: 3s
      retries: 3
    networks: [bg-net]

  nginx:
    image: nginx:alpine
    container_name: bg-nginx
    restart: always
    ports: ["80:80"]
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on: [web-blue, web-green]
    networks: [bg-net]

networks:
  bg-net:
    driver: bridge
```

> web-blue / web-green 用 `expose` 暴露端口(仅容器网络内可见),不用 `ports` 映射到宿主,避免外部绕过 nginx 直接访问。

### 5.3 服务器部署

```bash
# 1. 创建部署目录
mkdir -p ~/fe-depoly-bluegreen && cd ~/fe-depoly-bluegreen

# 2. 从仓库同步配置
cp ~/fe-depoly-repo/nginx/bluegreen/nginx.conf ./nginx.conf
cp ~/fe-depoly-repo/docker/docker-compose.bluegreen.yml ./docker-compose.yml

# 3. 启动
docker compose up -d
docker compose ps
# 应该看到 web-blue / web-green / bg-nginx 三个容器都 Up

# 4. 验证
curl http://localhost/healthz
# ok
# 浏览器访问 http://113.31.107.142/ → 看到 v1.0.0 的内容
```

### 5.4 切换到绿色环境(上线新版本)

**步骤 1:确认绿色环境健康**(关键,别切到挂掉的版本)

```bash
docker exec bg-nginx wget -qO- http://web-green/healthz
# ok
```

**步骤 2:在仓库里改 nginx.conf,提交 push**

本地:

```bash
cd /path/to/fe-depoly  # 本地仓库
# 编辑 nginx/bluegreen/nginx.conf:
#   注释 server web-blue:80;
#   取消注释 server web-green:80;
git add nginx/bluegreen/nginx.conf
git commit -m "deploy: switch blue-green to green (v1.0.1)"
git push origin main
```

**步骤 3:服务器同步 + reload**

```bash
cd ~/fe-depoly-repo
git pull origin main
cp nginx/bluegreen/nginx.conf ~/fe-depoly-bluegreen/nginx.conf

# 测语法 + 热加载
docker exec bg-nginx nginx -t
docker exec bg-nginx nginx -s reload
```

**步骤 4:验证切换成功**

```bash
curl http://localhost/
# 应该看到 v1.0.1 的新内容
# 浏览器强刷 http://113.31.107.142/ → 看到新版本
```

切换完成。整个过程用户感知不到中断(nginx reload 是平滑的)。

### 5.5 回滚(切回蓝色)

本地改 `nginx/bluegreen/nginx.conf`,把注释反过来:

```bash
git add nginx/bluegreen/nginx.conf
git commit -m "rollback: switch blue-green back to blue (v1.0.0)"
git push origin main
```

服务器:

```bash
cd ~/fe-depoly-repo && git pull origin main
cp nginx/bluegreen/nginx.conf ~/fe-depoly-bluegreen/nginx.conf
docker exec bg-nginx nginx -t && docker exec bg-nginx nginx -s reload
curl http://localhost/  # 回到 v1.0.0
```

### 5.6 蓝绿部署的优缺点

**优点:**
- 切换零停机(nginx reload 平滑)
- 回滚秒级(改配置再 reload)
- 两个环境都在跑,出问题随时切回
- 配置在版本控制里,每次切换有 commit 记录

**缺点:**
- 需要**双倍服务器资源**(两个完整环境同时跑)
- 切换是**全量**的,没有"先放 10% 看看"的能力 → 这正是金丝雀要解决的
- 每次切换要走"改配置 → commit → push → pull → reload"流程,比直接 sed 慢一点(但更安全)

## 六、方案 B:金丝雀发布(Canary)

### 6.1 原理

```
切换前(100% v1):
   用户 ──► Nginx ──► web-v1 (100%)

灰度中(10% v2):
   用户 ──► Nginx ──┬─► web-v1 (90%)
                    └─► web-v2 (10%) ← 少量流量验证

全量(100% v2):
   用户 ──► Nginx ──► web-v2 (100%)
```

v1 和 v2 同时服务,nginx 按比例分流量。出问题把比例改回 0% 即可。

### 6.2 三种分流方式对比

| 方式 | 原理 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **Cookie / Header** | 人工标记的用户走 v2 | 内测精确控制 | 需要用户配合设 cookie |
| **split_clients** | 按客户端 IP+UA 哈希分流 | 用户感知一致(同一用户始终命中同一版本) | 比例不够精确 |
| **权重 upstream** | nginx upstream `weight=` | 配置简单 | 同一用户多次请求会切换版本 |

> 生产推荐 **split_clients**:同一用户始终看到同一版本,避免"刷新一下页面变了"的诡异体验。

下面给两种实现:**方式 1(Cookie 精确控制)** 和 **方式 2(split_clients 按比例)**。

### 6.3 方式 1:基于 Cookie 的金丝雀(内测优先)

> 场景:开发者 / 内测用户带 `canary=true` cookie,看到 v2;普通用户看到 v1。

#### 6.3.1 仓库里的配置

仓库 `nginx/canary/nginx.conf`(已创建好):

```nginx
map $cookie_canary $backend {
    default  web-v1;   # 普通 user → v1
    "true"   web-v2;   # 内测 user(canary=true)→ v2
    "1"      web-v2;   # 兼容 canary=1
}

server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://$backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 响应头标识当前命中的版本,方便排查
        add_header X-Canary-Backend $backend;
    }

    location = /healthz {
        proxy_pass http://web-v1/healthz;
    }
}
```

仓库 `docker/docker-compose.canary.yml`:

```yaml
services:
  web-v1:
    image: crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.0
    container_name: web-v1
    restart: always
    expose: ["80"]
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost/healthz"]
      interval: 30s
      timeout: 3s
      retries: 3
    networks: [canary-net]

  web-v2:
    image: crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:1.0.1
    container_name: web-v2
    restart: always
    expose: ["80"]
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost/healthz"]
      interval: 30s
      timeout: 3s
      retries: 3
    networks: [canary-net]

  nginx:
    image: nginx:alpine
    container_name: canary-nginx
    restart: always
    ports: ["80:80"]
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on: [web-v1, web-v2]
    networks: [canary-net]

networks:
  canary-net:
    driver: bridge
```

#### 6.3.2 服务器部署

```bash
# 1. 创建部署目录
mkdir -p ~/fe-depoly-canary && cd ~/fe-depoly-canary

# 2. 从仓库同步配置
cp ~/fe-depoly-repo/nginx/canary/nginx.conf ./nginx.conf
cp ~/fe-depoly-repo/docker/docker-compose.canary.yml ./docker-compose.yml

# 3. 启动
docker compose up -d

# 4. 验证
# 普通访问 → v1
curl http://localhost/
curl -I http://localhost/ | grep X-Canary-Backend
# X-Canary-Backend: web-v1

# 带 cookie 访问 → v2
curl --cookie "canary=true" http://localhost/
curl -I --cookie "canary=true" http://localhost/ | grep X-Canary-Backend
# X-Canary-Backend: web-v2
```

#### 6.3.3 浏览器测试

1. 普通访问 `http://113.31.107.142/` → 看到 v1.0.0 内容
2. DevTools → Application → Cookies → 添加 `canary=true` → 刷新 → 看到 v1.0.1 内容
3. 删除 cookie → 刷新 → 回到 v1.0.0

#### 6.3.4 全量发布(所有人切到 v2)

本地改 `nginx/canary/nginx.conf`,把 `default` 改成 `web-v2`:

```nginx
map $cookie_canary $backend {
    default  web-v2;   # 改这里:所有人走 v2
    "true"   web-v2;
    "1"      web-v2;
}
```

提交 push:

```bash
git add nginx/canary/nginx.conf
git commit -m "deploy: canary full rollout to v2"
git push origin main
```

服务器同步 + reload:

```bash
cd ~/fe-depoly-repo && git pull origin main
cp nginx/canary/nginx.conf ~/fe-depoly-canary/nginx.conf
docker exec canary-nginx nginx -t
docker exec canary-nginx nginx -s reload

curl http://localhost/   # 现在 v2
curl -I http://localhost/ | grep X-Canary-Backend
# X-Canary-Backend: web-v2
```

#### 6.3.5 回滚

本地把 `default` 改回 `web-v1`,commit push,服务器同步 reload(同上)。

### 6.4 方式 2:基于 split_clients 的按比例金丝雀

> 场景:5% 用户随机看到 v2,观察 1 小时没问题,放量到 25% → 50% → 100%。

#### 6.4.1 仓库里的配置

仓库 `nginx/canary/nginx-splitclients.conf`(已创建好):

```nginx
split_clients "${remote_addr}${http_user_agent}" $backend {
    5%   web-v2;     # 5% 流量走 v2
    *    web-v1;     # 剩余 95% 走 v1
}

server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://$backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header X-Canary-Backend $backend;
    }

    location = /healthz {
        proxy_pass http://web-v1/healthz;
    }
}
```

#### 6.4.2 切换到 split_clients 配置

如果之前用的是 Cookie 版,要切换到 split_clients 版:

```bash
# 服务器上
cd ~/fe-depoly-repo && git pull origin main
cp nginx/canary/nginx-splitclients.conf ~/fe-depoly-canary/nginx.conf
docker exec canary-nginx nginx -t
docker exec canary-nginx nginx -s reload
```

#### 6.4.3 逐步放量流程

**每次放量都要走"改配置 → commit → push → pull → reload"流程**,以 5% → 25% 为例:

本地改 `nginx/canary/nginx-splitclients.conf`:

```nginx
split_clients "${remote_addr}${http_user_agent}" $backend {
    25%  web-v2;     # 改这里:5% → 25%
    *    web-v1;
}
```

```bash
git add nginx/canary/nginx-splitclients.conf
git commit -m "deploy: canary 25% rollout"
git push origin main
```

服务器:

```bash
cd ~/fe-depoly-repo && git pull origin main
cp nginx/canary/nginx-splitclients.conf ~/fe-depoly-canary/nginx.conf
docker exec canary-nginx nginx -s reload
```

观察 30 分钟,没问题继续放量到 50% → 100%。

**全量(100% v2)**:

```nginx
split_clients "${remote_addr}${http_user_agent}" $backend {
    *    web-v2;     # 全部走 v2
}
```

commit push 同步 reload。

#### 6.4.4 回滚(任何阶段)

本地把配置改回:

```nginx
split_clients "${remote_addr}${http_user_agent}" $backend {
    *    web-v1;     # 全部走 v1
}
```

commit push 同步 reload。回滚秒级,因为 v1 容器一直在跑。

### 6.5 金丝雀的优缺点

**优点:**
- 渐进放量,风险可控
- 出问题影响范围小(5% vs 100%)
- 同一用户始终看到同一版本(split_clients 哈希)
- 配置每次变更都有 git 记录,放量历史可追溯

**缺点:**
- 配置比蓝绿复杂
- 需要**监控告警**配套,否则"灰度中挂了"也不知道
- 双版本同时跑,要考虑**数据兼容**(后端 API 兼容性问题,前端静态站无此问题)
- 每次放量要走 git 流程,比直接 sed 慢(但更安全、可审计)

## 七、自动化:CI 触发灰度

手动 git push + SSH 同步容易出错,可以用 CI 自动化。思路:

1. CI 构建新版本镜像,推到 ACR
2. CI 通过 SSH 登录服务器,启动 `web-v2` 容器(不影响 web-v1)
3. CI 改仓库里的 nginx 配置,commit push
4. CI 在服务器上 git pull + 同步配置 + reload
5. CI 等待 5 分钟,跑健康检查 + 错误率检查
6. 通过则继续放量,失败则回滚

### 7.1 GitHub Actions workflow(canary.yml)

```yaml
name: Canary Deploy

on:
  workflow_dispatch:
    inputs:
      version:
        description: '新版本号(如 1.0.1)'
        required: true
      percentage:
        description: '灰度比例(5/25/50/100,0 表示回滚)'
        required: true
        default: '5'

jobs:
  canary:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Update nginx config
        run: |
          # 改 split_clients 比例
          if [ "${{ inputs.percentage }}" = "100" ]; then
            sed -i 's|^[0-9*]*%*\s*web-v2;|*    web-v2;|' nginx/canary/nginx-splitclients.conf
          elif [ "${{ inputs.percentage }}" = "0" ]; then
            sed -i 's|^[0-9*]*%*\s*web-v2;|0%   web-v2;|' nginx/canary/nginx-splitclients.conf
          else
            sed -i 's|^[0-9*]*%*\s*web-v2;|${{ inputs.percentage }}%   web-v2;|' nginx/canary/nginx-splitclients.conf
          fi

      - name: Commit config change
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add nginx/canary/nginx-splitclients.conf
          git commit -m "deploy: canary ${{ inputs.percentage }}% → v${{ inputs.version }}"
          git push

      - name: Deploy to server via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd ~/fe-depoly-repo
            git pull origin main

            # 1. 拉新版本镜像
            docker pull crpi-d8s0hxjvbntxh66b.cn-hangzhou.personal.cr.aliyuncs.com/cjdemo29/fe-depoly:${{ inputs.version }}

            # 2. 改 compose 里 web-v2 的 image tag,重启 web-v2
            cd ~/fe-depoly-canary
            sed -i 's|fe-depoly:[0-9.]*|fe-depoly:${{ inputs.version }}|g' \
              docker-compose.yml
            docker compose up -d web-v2

            # 3. 等容器健康
            sleep 10
            docker exec canary-nginx wget -qO- http://web-v2/healthz

            # 4. 同步 nginx 配置 + reload
            cp ~/fe-depoly-repo/nginx/canary/nginx-splitclients.conf ./nginx.conf
            docker exec canary-nginx nginx -t
            docker exec canary-nginx nginx -s reload

            echo "Canary ${{ inputs.percentage }}% deployed: v${{ inputs.version }}"
```

> 全量发布:再触发一次 workflow,percentage 输入 100。
> 回滚:percentage 输入 0。

### 7.2 自动化监控决策(进阶)

更成熟的方案是接 Prometheus + Grafana,让 CI 根据指标自动决策:

- 错误率 > 1% → 自动回滚
- P99 延迟 > 阈值 → 自动回滚
- 业务转化率下降 → 报警人工介入

个人项目不必搞这么重,手动观察日志即可。

## 八、监控与决策

灰度发布**必须配监控**,否则"灰度中挂了"你都不知道。

### 8.1 基础监控命令

```bash
# 看 v2 容器实时日志
docker logs -f web-v2

# 看 nginx 转发到哪个版本(统计请求数)
docker logs canary-nginx 2>&1 | grep -oP 'X-Canary-Backend: \K\S+' | sort | uniq -c
# 输出类似:
#    952 web-v1
#     48 web-v2

# 看容器资源占用
docker stats web-v1 web-v2

# 看容器健康状态
docker inspect web-v2 --format '{{.State.Health.Status}}'
```

### 8.2 决策清单

灰度期间每隔几分钟看一次:

| 指标 | 正常 | 异常处理 |
| --- | --- | --- |
| v2 健康检查 | Status: healthy | unhealthy 立即回滚 |
| v2 错误日志 | 无 5xx / 异常 stack | 有错误立即回滚 |
| nginx 5xx 比例 | < 0.1% | > 1% 立即回滚 |
| 业务转化率(如有) | 持平或上升 | 下降 10%+ 报警 |
| 用户反馈 | 无投诉 | 有投诉立即回滚 |

### 8.3 回滚决策时间窗

- **5% 灰度**:观察 30 分钟 - 2 小时
- **25% 灰度**:观察 1-4 小时
- **50% 灰度**:观察 2-8 小时
- **100% 全量**:持续观察 24 小时

时间窗根据业务流量调整,流量大的可以缩短。

## 九、踩坑点

1. **split_clients 比例精度**:`10%` 实际不一定精确等于 10%,因为哈希分桶。流量越大越准。
2. **upstream 不健康时 nginx 行为**:默认会跳过失败的 server,但不会主动摘除。配 `max_fails=2 fail_timeout=10s` 让 nginx 自动剔除。
3. **Cookie 跨域问题**:如果前端和 API 不同域,cookie 要配 `SameSite=None; Secure`,否则浏览器拒收。
4. **缓存导致"看到旧版本"**:CDN / 浏览器缓存了 v1 的 HTML,即使切到 v2 用户还看到旧的。HTML 必须配 `Cache-Control: no-cache`(本仓库 nginx 配置已做)。
5. **静态资源 hash 变化**:v1 和 v2 的 `index.html` 引用的 `/assets/index-xxx.js` hash 不同,如果用户拿到 v1 的 HTML 但去加载 v2 的 assets(被 nginx 分流到了 v2),会 404。解决:**assets 不分流**,只分 HTML;或用统一 CDN。
6. **session 状态丢失**:如果应用有登录状态(本仓库没有),v1 和 v2 的 session 存储要共享(Redis),否则用户切版本要重新登录。
7. **数据库 schema 兼容**:有后端的应用灰度时,v1 和 v2 必须兼容同一个数据库 schema。前端纯静态站无此问题。
8. **nginx reload 不是真的零停机**:虽然 nginx worker 是平滑切换,但极端情况下(长连接 / 大文件上传)reload 可能让部分请求中断。生产用 `nginx -s reload` 即可,要求更高用 `SO_REUSEPORT`。
9. **忘记改回 default 分流**:全量发布后,nginx.conf 里还留着 split_clients 配置,下次部署 v3 时会按老比例分。全量后应该把 nginx.conf 改成 `default web-v2` 形式。
10. **web-v1 容器别急着删**:全量切到 v2 后,保留 web-v1 至少 24 小时,观察有没有"用户反馈看不到新版"的问题(可能是缓存),随时准备切回。
11. **配置同步漏掉**:`git pull` 后忘记 `cp` 到部署目录,或者 `cp` 后忘记 `nginx -t` 直接 reload 导致 nginx 挂掉。建议把同步步骤写成脚本(见第十节)。
12. **仓库 clone 用 HTTPS 还是 SSH**:服务器用 SSH clone 要先配 deploy key;用 HTTPS clone 公开仓库无需凭证但 push 时需要 PAT。学习阶段建议用 HTTPS + PAT,简单。

## 十、配置同步脚本(推荐)

为了避免手动 `git pull` + `cp` + `reload` 容易出错,把同步流程写成脚本。

服务器上创建 `~/sync-canary.sh`:

```bash
#!/bin/bash
set -e

REPO_DIR=~/fe-depoly-repo
DEPLOY_DIR=~/fe-depoly-canary
CONF_NAME=nginx-splitclients.conf  # 或 nginx.conf(Cookie 版)

cd $REPO_DIR
git pull origin main

cp nginx/canary/$CONF_NAME $DEPLOY_DIR/nginx.conf

docker exec canary-nginx nginx -t
docker exec canary-nginx nginx -s reload

echo "✓ Canary config synced and reloaded"
```

赋权 + 使用:

```bash
chmod +x ~/sync-canary.sh
~/sync-canary.sh
```

蓝绿版本类似,创建 `~/sync-bluegreen.sh`:

```bash
#!/bin/bash
set -e

REPO_DIR=~/fe-depoly-repo
DEPLOY_DIR=~/fe-depoly-bluegreen

cd $REPO_DIR
git pull origin main

cp nginx/bluegreen/nginx.conf $DEPLOY_DIR/nginx.conf

docker exec bg-nginx nginx -t
docker exec bg-nginx nginx -s reload

echo "✓ Blue-green config synced and reloaded"
```

## 十一、本仓库落地步骤(推荐顺序)

### 11.1 跑通 Cookie 灰度(30 分钟)

1. 本地改个文案,打 `v1.0.1` tag,push 触发 CI 构建 1.0.1 镜像
2. 服务器停掉旧的 `fe-depoly-prod` 单容器
3. 服务器 `git clone` 仓库到 `~/fe-depoly-repo`
4. 创建 `~/fe-depoly-canary/`,从仓库 `cp` 配置(compose + nginx.conf)
5. `docker compose up -d` 启动
6. 浏览器测试:无 cookie 看到 1.0.0,设 `canary=true` cookie 看到 1.0.1
7. 本地改 `nginx/canary/nginx.conf` 全量切到 v2,commit push,服务器 `~/sync-canary.sh`
8. 改回 v1 验证回滚

### 11.2 跑通 split_clients 按比例灰度(30 分钟)

1. 本地改 `nginx/canary/nginx-splitclients.conf` 设 5% 比例,commit push
2. 服务器切换到 splitclients 配置(`cp` + reload)
3. 多次 curl 验证分流比例(`for i in {1..100}; do curl -sI http://localhost/ | grep X-Canary; done | sort | uniq -c`)
4. 模拟"放量"流程:5% → 25% → 50% → 100%(每次 commit push + 同步脚本)
5. 模拟"回滚":改回 0%

### 11.3 跑通蓝绿部署(1 小时)

1. 创建 `~/fe-depoly-bluegreen/`,从仓库 `cp` 配置
2. 启动,默认指向 blue(v1.0.0)
3. 本地改 `nginx/bluegreen/nginx.conf` 切到 green,commit push,服务器 `~/sync-bluegreen.sh`
4. 切回 blue 验证回滚

### 11.4 接入 CI 自动化(可选,2 小时)

1. 配 GitHub Secrets(`SSH_HOST` / `SSH_USER` / `SSH_PRIVATE_KEY`,见 `ci-docker.md`)
2. 创建 `.github/workflows/canary.yml`(参考第七节)
3. 手动触发,输入版本号和比例,观察服务器自动切换

## 十二、蓝绿 vs 金丝雀:什么时候用哪个

| 场景 | 推荐 | 原因 |
| --- | --- | --- |
| 个人项目 / demo 切版本 | 蓝绿 | 简单粗暴,切错就切回 |
| 改了核心页面 / 改了构建工具 | 金丝雀 | 风险高,需要观察 |
| 修了个小 bug | 蓝绿 | 风险低,没必要灰度 |
| 大版本升级(框架迁移) | 金丝雀 | 必须灰度,否则炸 |
| 紧急修复线上故障 | 蓝绿 | 越快越好,蓝绿 1 秒切换 |
| 团队 10+ 人 / 用户 10w+ | 金丝雀 | 必须按比例放量 + 监控 |

## 十三、参考链接

- Nginx `split_clients` 文档:https://nginx.org/en/docs/http/ngx_http_split_clients_module.html
- Nginx `map` 模块:https://nginx.org/en/docs/http/ngx_http_map_module.html
- Nginx upstream 健康检查:https://nginx.org/en/docs/http/ngx_http_upstream_module.html
- Martin Fowler:BlueGreenDeployment:https://martinfowler.com/bliki/BlueGreenDeployment.html
- Martin Fowler:CanaryRelease:https://martinfowler.com/bliki/CanaryRelease.html
- 阿里云 MSE 灰度发布(全链路灰度):https://help.aliyun.com/document_detail/405475.html
- Kubernetes Canary Deployment:https://kubernetes.github.io/ingress-nginx/examples/canary/
