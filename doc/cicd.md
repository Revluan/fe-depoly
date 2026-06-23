# CI/CD 基础概念与本仓库实践

> 配套文档：`doc/plan.md` 阶段二。本文先讲概念，再对应到本仓库的落地配置。

## 一、什么是 CI/CD

CI/CD 是一组把代码从开发者的笔记本自动送到生产环境的自动化实践，分三段：

```
开发提交 ──► CI ──► CD ──► 生产
            │      │
            │      └─ 持续部署 / 持续交付
            └─ 持续集成
```

| 缩写 | 全称 | 目标 |
| --- | --- | --- |
| CI | Continuous Integration | 频繁把代码集成到主干，每次集成都自动构建 + 测试 |
| CD | Continuous Delivery | 持续交付：CI 之后自动打包出**可发布**的产物，但发布动作需人工触发 |
| CD | Continuous Deployment | 持续部署：CI 通过后**自动**部署到生产，无需人工干预 |

> 持续交付 vs 持续部署：区别只在于“最后那一下发布”是不是人按的。本仓库采用 **持续交付** 思路 —— CI 自动构建产物，部署通过 tag / 手动触发。

## 二、为什么要做 CI/CD

1. **早发现问题**：每次 push 都跑 lint / type-check / test，缺陷在几分钟内暴露，而不是等到上线时炸
2. **减少人为错误**：构建、测试、发布全部脚本化，消除“我本地没问题”的玄学
3. **可重复**：同一份代码在任何机器上构建出的产物一致（依赖锁定 + 容器化运行器）
4. **可追溯**：每一次部署都能对应到具体的 commit / tag / PR，回滚有据可查
5. **解放双手**：开发者只管提交，部署流水线自动接管

## 三、核心概念

### 3.1 流水线（Pipeline）

一组按顺序执行的自动化任务。本仓库的 CI 流水线：

```
push / PR ──► Lint ──► Type-check ──► Test ──► Build(staging, production)
```

### 3.2 作业（Job）与步骤（Step）

- **Job**：流水线里的一个独立任务，跑在一台独立的虚拟机上（GitHub Actions 里叫 `runs-on: ubuntu-latest`）
- **Step**：Job 内部的具体命令，顺序执行
- **Job 之间**可以串行（`needs`）或并行（`matrix`）

本仓库的 `ci.yml` 里：
- `quality` job：跑 lint / type-check / test
- `build` job：`needs: quality` 通过后才跑，并用 matrix 并行构建 staging / production 两个产物

### 3.3 触发器（Trigger）

什么事件启动流水线。本仓库用到：

| 触发器 | 文件 | 用途 |
| --- | --- | --- |
| `pull_request` | `ci.yml` | PR 推上去时跑质量检查，防止坏代码合入 |
| `push: [main, staging]` | `ci.yml` | 合入后跑一次完整 CI |
| `push: staging` | `deploy-staging.yml` | 合入 staging 自动部署预发 |
| `push: tags v*.*.*` | `deploy-production.yml` | 打 tag 才触发生产部署 |
| `workflow_dispatch` | 两个 deploy 文件 | 手动在 GitHub UI 上点“运行” |

### 3.4 运行器（Runner）

执行 job 的机器。GitHub 提供 `ubuntu-latest` / `windows-latest` / `macos-latest` 免费档。也可以自建 self-hosted runner。

### 3.5 制品（Artifact）

CI 产出的文件（dist 目录、coverage 报告）。用 `actions/upload-artifact` 上传，可在 GitHub UI 下载，或被下游 job 下载使用。本仓库上传了 `dist-staging` / `dist-production` / `coverage-*` 三类制品。

### 3.6 环境与密钥（Environment & Secrets）

- **Secrets**：加密的环境变量，存 token、密钥。在 job 里通过 `secrets.XXX` 读取
- **Environment**：GitHub Actions 的“环境”概念，可以绑定保护规则（如生产环境必须人工 approve、只能从特定分支部署）
- 本仓库的 deploy job 用了 `environment: staging` / `environment: production`，可以在仓库 Settings → Environments 里加审批人

### 3.7 并发控制（Concurrency）

防止同一分支被连续 push 时跑一堆重复的 CI。本仓库用：

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true  # 新提交来了就取消旧的
```

部署类流水线设 `cancel-in-progress: false`，避免部署跑到一半被砍。

## 四、本仓库的 CI/CD 架构

### 4.1 分支策略

```
feature/* ──PR──► staging ──PR──► main ──tag──► v1.0.0
                   │                │
                   │                └─► Release workflow（生成 changelog PR / tag）
                   └─► Deploy Staging
                                   └─► Deploy Production（由 tag 触发）
```

- `feature/*`：日常开发分支，提 PR 到 `staging`
- `staging`：预发分支，合入即触发**预发部署**
- `main`：生产分支，合入即触发 Release workflow 生成版本 PR；打 `v*.*.*` tag 才触发**生产部署**

### 4.2 流水线清单

| 文件 | 作用 | 触发 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | lint + type-check + test + 双环境构建 | PR / push 到 main、staging |
| `.github/workflows/deploy-staging.yml` | 部署到 GitHub Pages（预发） | push 到 staging |
| `.github/workflows/deploy-production.yml` | 部署到 GitHub Pages（生产） | push tag `v*.*.*` |
| `.github/workflows/release.yml` | Changesets 自动版本 + changelog | push 到 main |

### 4.3 环境变量管理

Vite 通过 `--mode` 读取对应 `.env` 文件：

| 文件 | mode | 用途 |
| --- | --- | --- |
| `.env.development` | `dev`（默认）| `npm run dev` |
| `.env.staging` | `staging` | CI 构建 `vite build --mode staging` |
| `.env.production` | `production` | CI 构建 `vite build --mode production` |

CI 里通过 `npm run build -- --mode staging` / `--mode production` 切换。敏感密钥不入 `.env`，走 GitHub Secrets 在 deploy 时注入。

### 4.4 版本与 Changelog

用 [Changesets](https://github.com/changesets/changesets) 管理：

1. 开发者写完功能，跑 `npm run changeset`，描述本次变更（patch / minor / major）
2. 提交 `.changeset/*.md` 到 PR，一起合入 main
3. `release.yml` 检测到有未消费的 changeset，自动创建一个 “Version Packages” PR
4. 合入该 PR → Changesets 自动改 `package.json` 版本号、写 `CHANGELOG.md`、打 git tag
5. tag 触发 `deploy-production.yml` 部署到生产

### 4.5 测试

- 单元测试：Vitest + Testing Library（`src/test/`）
- 覆盖率：v8 provider，CI 上 `npm run test -- --coverage` 并上传 artifact
- E2E（后续阶段补充）：Playwright

## 五、本地复现 CI 行为

```bash
# 1. 安装依赖（锁定版本，等价于 CI 里的 npm ci）
npm ci

# 2. 质量检查
npm run lint
npm run type-check
npm run test

# 3. 构建（双环境）
npm run build -- --mode staging
npm run build -- --mode production

# 4. 本地预览构建产物
npm run preview
```

> `npm ci` 比 `npm install` 更严格：必须存在 `package-lock.json`，不会修改 lock 文件，速度更快 —— CI 里一律用它。

## 六、CI/CD 常见最佳实践

1. **lockfile 必须提交**：保证本地、CI、生产构建的依赖版本一致
2. **CI 用 `npm ci`，不用 `npm install`**：避免隐式升级
3. **缓存依赖**：`actions/setup-node@v4` 的 `cache: 'npm'` 自动缓存 `~/.npm`
4. **并发取消**：同分支新 push 取消旧运行，省额度
5. **最小权限**：`permissions:` 显式声明 token 权限，default 只给 `contents: read`
6. **产物与部署解耦**：CI 负责构建 + 上传 artifact，deploy job 负责下载 + 发布
7. **生产环境必须人工门**：用 tag 触发 / `environment` 审批，绝不让 push 直接上生产
8. **失败必须修**：CI 红了不准合入，主分支永远是绿的
9. **secret 不进代码**：所有密钥走 Secrets，`.env` 文件只放非敏感配置
10. **回滚预案**：生产部署失败时，能快速回到上一个 tag —— 后续阶段会实现

## 七、参考链接

- GitHub Actions 文档：https://docs.github.com/actions
- Changesets：https://github.com/changesets/changesets
- Vitest：https://vitest.dev/
- Vite 环境变量：https://vitejs.dev/guide/env-and-mode.html
- GitHub Pages 部署：https://docs.github.com/pages
