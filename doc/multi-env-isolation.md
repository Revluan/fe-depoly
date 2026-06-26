# 多环境隔离(Staging / Production)方案

> 当前项目只有单一 production 环境,`main` 分支直接部署到线上。本文规划一套 staging/prod 双环境隔离方案,让灰度规则、产物版本、KV 数据都能在 staging 验证后再推 prod。

## 1. 先回答域名问题

**不需要重新申请域名。** 三个选项,推荐第一个:

| 方案 | 示例 | 成本 | 适用 |
|---|---|---|---|
| **复用现有根域名,加子域名**(推荐) | `app.example.com` → prod<br>`staging.example.com` → staging | 0(子域名免费) | 已有自定义域名 |
| **workers.dev 免费子域名** | `fe-depoly-edge.workers.dev` → prod<br>`fe-depoly-edge-staging.workers.dev` → staging | 0 | 学习项目,没买域名 |
| 单独注册新域名 | `example.com` → prod<br>`example-staging.com` → staging | 域名费 + 续费 | 不推荐,过度设计 |

**为什么不要单独域名**:多环境隔离的本质是**资源隔离**(Worker / R2 / KV / 配置),不是 DNS 隔离。子域名完全够用,而且共享根域可以让 cookie / CORS 策略复用,反而更方便。

**为什么不要 path-based 隔离**(`example.com/` 和 `example.com/staging/`):
- SPA 路由会冲突
- Worker 缓存 key 难处理
- 安全边界模糊(staging 产物可能被 prod 域名缓存)
- Cloudflare Worker 的 `routes` 也是按 hostname 匹配的,不适合 path 分流

## 2. 目标架构

```
                          GitHub
                            │
                ┌───────────┴───────────┐
                │                       │
            main 分支              staging 分支
                │                       │
                ▼                       ▼
        ┌───────────────┐       ┌───────────────┐
        │  workflow:    │       │  workflow:    │
        │  deploy-prod  │       │  deploy-stage │
        │  (manual /    │       │  (auto on     │
        │   tag)        │       │   push)       │
        └───────┬───────┘       └───────┬───────┘
                │                       │
                ▼                       ▼
   ┌────────────────────────┐  ┌────────────────────────┐
   │  PRODUCTION 环境        │  │  STAGING 环境           │
   │                         │  │                         │
   │  Worker: fe-depoly-edge│  │  Worker: fe-depoly-edge │
   │                         │  │           -staging      │
   │  R2: fe-depoly-assets  │  │  R2: fe-depoly-assets  │
   │                         │  │           -staging      │
   │  KV: GRAY_RULES_PROD   │  │  KV: GRAY_RULES_STAGE  │
   │                         │  │                         │
   │  域名: app.example.com │  │  域名: staging.example │
   │       (or *.workers   │  │       .com (or *-       │
   │        .dev)           │  │        staging.workers │
   │                         │  │        .dev)           │
   └────────────────────────┘  └────────────────────────┘
                │                       │
                └───────────┬───────────┘
                            │
                            ▼
                  Sentry(按环境打 tag,
                  release 复用 BUILD_ID)
```

**核心原则:资源完全隔离。** R2 / KV / Worker 都不能共用,否则 staging 的灰度规则可能写到 prod 的 KV 里,staging 的产物可能覆盖 prod 的版本。这是事故高发点,必须从基础设施层就分开。

## 3. 资源清单对比

| 资源 | Production | Staging | 是否共用 |
|---|---|---|---|
| Worker | `fe-depoly-edge` | `fe-depoly-edge-staging` | 否 |
| R2 Bucket | `fe-depoly-assets` | `fe-depoly-assets-staging` | **否(关键)** |
| KV Namespace | ID: `69d9d16...` | 新建一个 | **否(关键)** |
| 域名 | `app.example.com` | `staging.example.com` | 否 |
| GitHub Secrets | `R2_*`, `CF_API_TOKEN` | 同一组(权限范围足够) | 是 |
| Sentry Project | 同一 project,env=production | 同一 project,env=staging | 是(env 区分) |
| BUILD_ID 生成 | `build-{run_id}-{sha}` | 同上 | 是(逻辑一致) |

## 4. 实施步骤

分 5 个阶段,每个阶段独立可验证,出问题能停住。

### 阶段 1:Cloudflare 侧资源准备

**1.1 创建 staging R2 bucket**

Dashboard → R2 → Create bucket → 名字 `fe-depoly-assets-staging` → Create。

**1.2 创建 staging KV namespace**

Dashboard → Workers & Pages → KV → Create namespace → 名字 `GRAY_RULES_STAGING` → Create。**记下 namespace ID**,后面要写到 wrangler.toml。

**1.3 子域名路由规划**

如果已有自定义域名(如 `example.com`):
- prod:`app.example.com` → Worker `fe-depoly-edge`(Custom Domain 或 Route)
- staging:`staging.example.com` → Worker `fe-depoly-edge-staging`(同上)

如果用 workers.dev:
- prod:`fe-depoly-edge.<你的-subdomain>.workers.dev`
- staging:`fe-depoly-edge-staging.<你的-subdomain>.workers.dev`
- 默认就启用,不需要额外配置

**1.4 验证**

```bash
# 列出 R2 buckets,应该看到两个
npx wrangler r2 bucket list

# 列出 KV namespaces,应该看到两个
npx wrangler kv namespace list
```

### 阶段 2:wrangler.toml 改造(用 environments)

Cloudflare Worker 原生支持 `[env.staging]` / `[env.production]` 配置块,一份代码两套配置。改造如下:

```toml
# 公共配置(所有环境继承)
name = "fe-depoly-edge"
main = "src/index.ts"
compatibility_date = "2026-06-01"

# 默认环境(=production)
[vars]
ENVIRONMENT = "production"
CURRENT_VERSION = "v1.0.0"
DEPLOY_TIME = "2026-06-25"
CANARY_PERCENT = "10"

[[r2_buckets]]
binding = "ASSETS_BUCKET"
bucket_name = "fe-depoly-assets"
preview_bucket_name = "fe-depoly-assets"

[[kv_namespaces]]
binding = "GRAY_RULES"
id = "69d9d16026c6439bb4e4735bd76fd2ee"
preview_id = "69d9d16026c6439bb4e4735bd76fd2ee"

# Staging 环境覆盖
[env.staging]
name = "fe-depoly-edge-staging"

[env.staging.vars]
ENVIRONMENT = "staging"
CURRENT_VERSION = "v1.0.0-staging"
DEPLOY_TIME = "2026-06-25"
CANARY_PERCENT = "100"  # staging 默认全量,方便测试

[[env.staging.r2_buckets]]
binding = "ASSETS_BUCKET"
bucket_name = "fe-depoly-assets-staging"
preview_bucket_name = "fe-depoly-assets-staging"

[[env.staging.kv_namespaces]]
binding = "GRAY_RULES"
id = "<staging-namespace-id-from-step-1.2>"
preview_id = "<staging-namespace-id-from-step-1.2>"

# 路由(部署后在 Dashboard 配,这里注释)
# [env.staging.routes]
# routes = [
#   { pattern = "staging.example.com/*", custom_domain = true }
# ]
```

部署命令:
- 部署 prod:`npx wrangler deploy`(默认环境)
- 部署 staging:`npx wrangler deploy --env staging`

**关键点**:`--env staging` 会让 wrangler 读 `[env.staging.*]` 块,自动用 staging 名字、staging 的 R2/KV。一份代码,两套配置,零侵入。

### 阶段 3:CI/CD 工作流拆分

把现有 `.github/workflows/deploy-r2-worker.yml` 拆成两个 workflow,或者用一个 workflow + 矩阵 + 条件触发。推荐拆成两个,清晰。

**3.1 创建 `deploy-staging.yml`**(staging 自动部署)

```yaml
name: Deploy to Staging

on:
  push:
    branches: [staging]
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
      - '.github/workflows/deploy-staging.yml'
  workflow_dispatch:

env:
  AWS_REGION: auto
  AWS_ENDPOINT_URL: ${{ secrets.R2_ENDPOINT }}
  AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
  # staging 用单独的 R2 bucket,通过 R2_BUCKET 环境变量传入 sync 命令
  R2_BUCKET: fe-depoly-assets-staging

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment: staging  # GitHub Environments,可配审批/独立 secrets
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - name: Compute BUILD_ID
        id: build-id
        run: |
          SHORT_SHA=${GITHUB_SHA::7}
          BUILD_ID="build-${{ github.run_id }}-${SHORT_SHA}"
          echo "BUILD_ID=${BUILD_ID}" >> "$GITHUB_OUTPUT"

      - run: npm ci
      - run: npm run lint
      - run: npm run type-check
      - run: npm run build
        env:
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
          SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
          SENTRY_PROJECT: ${{ secrets.SENTRY_PROJECT }}
          VITE_APP_ENV: staging  # 关键:前端能识别环境
          VITE_APP_VERSION: ${{ steps.build-id.outputs.BUILD_ID }}
          VITE_SENTRY_DSN: ${{ secrets.VITE_SENTRY_DSN }}

      - name: Sync to R2 (staging bucket)
        run: |
          aws s3 sync dist/ "s3://${R2_BUCKET}/" \
            --cache-control "public, max-age=31536000, immutable" \
            --exclude "index.html" \
            --endpoint-url "$AWS_ENDPOINT_URL"
          aws s3 cp dist/index.html "s3://${R2_BUCKET}/index.html" \
            --cache-control "public, max-age=0, must-revalidate" \
            --content-type "text/html; charset=utf-8" \
            --endpoint-url "$AWS_ENDPOINT_URL"

      - name: Sync to R2 (versioned)
        run: |
          BUILD_ID="${{ steps.build-id.outputs.BUILD_ID }}"
          aws s3 sync dist/ "s3://${R2_BUCKET}/artifacts/${BUILD_ID}/" \
            --cache-control "public, max-age=31536000, immutable" \
            --exclude "index.html" \
            --endpoint-url "$AWS_ENDPOINT_URL"
          aws s3 cp dist/index.html "s3://${R2_BUCKET}/artifacts/${BUILD_ID}/index.html" \
            --cache-control "public, max-age=0, must-revalidate" \
            --content-type "text/html; charset=utf-8" \
            --endpoint-url "$AWS_ENDPOINT_URL"

      - name: Deploy Worker (staging)
        working-directory: worker
        run: |
          npm ci
          npx wrangler deploy --env staging \
            --var CURRENT_VERSION:${{ steps.build-id.outputs.BUILD_ID }} \
            --var DEPLOY_TIME:$(date -u +%Y-%m-%dT%H:%M:%SZ)
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Set current-artifact in KV (staging)
        working-directory: worker
        run: |
          npx wrangler kv key put current-artifact "${{ steps.build-id.outputs.BUILD_ID }}" \
            --binding GRAY_RULES \
            --env staging \
            --preview false \
            --remote
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

**3.2 改造现有 `deploy-r2-worker.yml` → `deploy-production.yml`**

主要改动:
- 触发条件:去掉 `push` 自动触发,改成**手动 + tag**
- 加 `environment: production`(GitHub Environments,可加审批人)
- R2 bucket 显式写 `fe-depoly-assets`
- Worker 部署用默认环境(不加 `--env`)

```yaml
name: Deploy to Production

on:
  # 两种触发方式:打 tag 或手动
  push:
    tags:
      - 'v*'  # v1.0.0, v1.1.0-rc.1 等
  workflow_dispatch:
    inputs:
      confirm:
        description: 'Type "deploy" to confirm'
        required: true
        default: ''

env:
  AWS_REGION: auto
  AWS_ENDPOINT_URL: ${{ secrets.R2_ENDPOINT }}
  AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
  R2_BUCKET: fe-depoly-assets

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment: production  # 关键:GitHub Environments 配审批人
    permissions:
      contents: read
    steps:
      - name: Validate manual confirm
        if: github.event_name == 'workflow_dispatch'
        run: |
          if [ "${{ github.event.inputs.confirm }}" != "deploy" ]; then
            echo "Must type 'deploy' to confirm"
            exit 1
          fi

      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - name: Compute BUILD_ID
        id: build-id
        run: |
          SHORT_SHA=${GITHUB_SHA::7}
          BUILD_ID="build-${{ github.run_id }}-${SHORT_SHA}"
          echo "BUILD_ID=${BUILD_ID}" >> "$GITHUB_OUTPUT"

      - run: npm ci
      - run: npm run lint
      - run: npm run type-check
      - run: npm run build
        env:
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
          SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
          SENTRY_PROJECT: ${{ secrets.SENTRY_PROJECT }}
          VITE_APP_ENV: production
          VITE_APP_VERSION: ${{ steps.build-id.outputs.BUILD_ID }}
          VITE_SENTRY_DSN: ${{ secrets.VITE_SENTRY_DSN }}

      - name: Sync to R2 (prod bucket)
        run: |
          aws s3 sync dist/ "s3://${R2_BUCKET}/" \
            --cache-control "public, max-age=31536000, immutable" \
            --exclude "index.html" \
            --endpoint-url "$AWS_ENDPOINT_URL"
          aws s3 cp dist/index.html "s3://${R2_BUCKET}/index.html" \
            --cache-control "public, max-age=0, must-revalidate" \
            --content-type "text/html; charset=utf-8" \
            --endpoint-url "$AWS_ENDPOINT_URL"

      - name: Sync to R2 (versioned)
        run: |
          BUILD_ID="${{ steps.build-id.outputs.BUILD_ID }}"
          aws s3 sync dist/ "s3://${R2_BUCKET}/artifacts/${BUILD_ID}/" \
            --cache-control "public, max-age=31536000, immutable" \
            --exclude "index.html" \
            --endpoint-url "$AWS_ENDPOINT_URL"
          aws s3 cp dist/index.html "s3://${R2_BUCKET}/artifacts/${BUILD_ID}/index.html" \
            --cache-control "public, max-age=0, must-revalidate" \
            --content-type "text/html; charset=utf-8" \
            --endpoint-url "$AWS_ENDPOINT_URL"

      - name: Deploy Worker (production)
        working-directory: worker
        run: |
          npm ci
          npx wrangler deploy \
            --var CURRENT_VERSION:${{ steps.build-id.outputs.BUILD_ID }} \
            --var DEPLOY_TIME:$(date -u +%Y-%m-%dT%H:%M:%SZ)
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Set current-artifact in KV (production)
        working-directory: worker
        run: |
          npx wrangler kv key put current-artifact "${{ steps.build-id.outputs.BUILD_ID }}" \
            --binding GRAY_RULES \
            --preview false \
            --remote
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

**3.3 GitHub Environments 配置**

Repo → Settings → Environments → New environment → 创建两个:`staging` 和 `production`。

- `staging`:不需要审批,自动跑完
- `production`:Required reviewers 勾选自己(或团队成员),部署前必须手动 approve

可选:每个 environment 配独立的 secrets(如 staging 的 Sentry DSN 和 prod 不同),本项目复用 repo-level secrets 即可。

### 阶段 4:分支策略

```
                  PR                    PR
  feature/x  ──►  staging  ──►  main  ──►  v1.0.0 (tag)
                    │              │              │
                    │              │              │
                    ▼              ▼              ▼
              自动部署         不部署          触发部署
              staging 环境     (main 只       production
                              是中转)         环境
```

**为什么 main 不直接部署 prod?**

让 `main` 保持「随时可发布」状态,但不自动发布。发布由 tag 触发,中间多一道人工确认(GitHub Environment approval)。这样:
- `main` 可以随时合并多个 PR,不被发布节奏绑架
- 想发布时打个 tag,审批后自动跑
- 出问题回滚也是删 tag 重新打

**操作流程**:
1. 在 feature 分支开发,PR → staging
2. staging 自动部署,在 `staging.example.com` 验证
3. 验证通过,PR staging → main(或直接 feature → main,看团队习惯)
4. 想发布:在 main 上打 tag `git tag v1.0.0 && git push origin v1.0.0`
5. workflow 触发,审批后部署到 prod

### 阶段 5:前端适配

**5.1 显示环境标识**

`src/App.tsx` 已有 `config.env`,根据它显示 badge:

```tsx
// 在 header 加一个环境标签
{config?.env === 'staging' && (
  <span style={{ background: '#fbbf24', color: '#000', padding: '0 8px', borderRadius: 4, fontSize: 12, marginLeft: 8 }}>
    STAGING
  </span>
)}
```

**5.2 Sentry 区分环境**

`sentry.ts`(如果有)初始化时加 environment:

```ts
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: import.meta.env.VITE_APP_VERSION,
  environment: import.meta.env.VITE_APP_ENV,  // 'staging' | 'production'
})
```

Sentry 后台就能按 environment 过滤,prod 错误不被 staging 污染。

**5.3 视觉区分(可选)**

staging 用不同主色调(如黄色 header 边框),避免误操作。学习项目可省。

## 5. 验证清单

按顺序跑一遍,每步都通过再往下:

- [ ] **R2 / KV 资源已创建**
  - `npx wrangler r2 bucket list` 看到 `fe-depoly-assets-staging`
  - `npx wrangler kv namespace list` 看到 staging 的 namespace
- [ ] **wrangler.toml 改造后本地能部署 staging**
  - `cd worker && npx wrangler deploy --env staging` 成功
  - 访问 `fe-depoly-edge-staging.<subdomain>.workers.dev` 能打开页面
- [ ] **CI workflow 跑通**
  - 推 `staging` 分支,deploy-staging.yml 跑通
  - 访问 staging 域名,`__APP_CONFIG__.env` 应为 `staging`
  - 打 tag `v1.0.0`,deploy-production.yml 触发,审批后跑通
  - 访问 prod 域名,`__APP_CONFIG__.env` 应为 `production`
- [ ] **资源隔离验证**
  - 在 staging Admin UI 新建一条灰度,查 prod 的 `/api/admin/releases` 应为空(或保持原样)
  - 反过来也是
  - KV 是两个不同的 namespace,数据不互通
- [ ] **回滚演练**
  - 在 prod 打 `v1.0.1` tag,部署新版本
  - 重新打 `v1.0.0` tag(删除后重建),CI 重新部署旧版本
  - 验证 `current-artifact` KV 指针回退到旧 buildId
- [ ] **Sentry 环境分离**
  - staging 触发一个错误,Sentry 后台 environment 字段 = staging
  - prod 同样,environment = production

## 6. 常见坑

| 坑 | 症状 | 避免方法 |
|---|---|---|
| R2 bucket 写串了 | staging 部署覆盖了 prod 产物 | CI 里 R2_BUCKET 显式写死,不用 fallback |
| KV namespace 配错 | staging 的灰度规则写到 prod | wrangler.toml 每个 env 的 id 必须不一样,部署前 `wrangler kv namespace list` 核对 |
| 忘记 `--env staging` | 部署到 prod Worker 了 | CI 命令必须带 `--env staging`,本地手动部署时也要小心 |
| GitHub Environment 没配审批 | prod 误触发 | prod workflow 必须加 `environment: production` 并配 Required reviewers |
| 缓存串环境 | staging 的 JS 被 prod 域名缓存命中 | 不共用域名,Worker 路由按 hostname 严格隔离 |
| tag 误打在 staging 分支 | 部署了 staging 的代码到 prod | tag 只在 `main` 上打,CI 里加校验 `if: github.ref == 'refs/heads/main'`(对 push tag 不适用,但可加 branch check) |

## 7. 不做的事

- **更多环境(dev / pre-prod)**:学习项目 staging + prod 够用,dev 直接 `npm run dev` 本地起
- **蓝绿部署**:Cloudflare Worker 部署本身是原子的,不需要蓝绿
- **流量镜像(mirror)**:学习项目不需要,生产环境也少用
- **独立 Sentry project**:用 environment 字段区分够了,不必拆 project
- **Terraform 管理 Cloudflare 资源**:学习项目手动创建可接受,生产环境再考虑 IaC

## 8. 后续演进方向

| 方向 | 时机 |
|---|---|
| Terraform / Pulumi 管理 Cloudflare 资源 | 资源数量超过 10 个,手动创建容易漏 |
| 独立 Sentry project per env | staging 错误量大,需要不同告警阈值 |
| Preview environments(每个 PR 一个临时环境) | 团队规模 > 3 人,需要 PR 级验证 |
| 跨环境产物提升(promote artifact) | 想让 staging 验证过的产物直接推 prod,不重新构建 |
| 蓝绿 / 金丝雀 by region | 流量到一定规模,需要按地域灰度 |
