# 前端工程化学习与开发计划

> 项目定位：用于实践前端部署发布、CI/CD、打包构建、CDN、缓存等工程化相关内容的学习项目。

## 一、整体目标

通过从 0 到 1 搭建一个完整的前端工程化体系，掌握以下能力：

1. 熟悉主流构建工具（Vite / Webpack / Rspack / Turbopack）的原理与配置
2. 能够独立搭建 CI/CD 流水线（GitHub Actions / GitLab CI）
3. 理解并实践多种部署方案（静态托管、容器化、边缘函数）
4. 掌握 CDN 与缓存策略（强缓存、协商缓存、Content Hash、SWR）
5. 了解前端性能优化的工程化手段

## 二、阶段规划


### 阶段一：项目初始化与基础构建（2 周）

- [ ] 初始化 monorepo 结构（pnpm workspace）
- [ ] 搭建一个基础 React/Vue 应用作为部署对象
- [ ] 配置 Vite 进行开发与打包
- [ ] 接入 TypeScript、ESLint、Prettier、Husky、Commitlint
- [ ] 输出第一个可部署的静态产物

### 阶段二：CI/CD 流水线（2 周）

- [ ] 使用 GitHub Actions 搭建自动化流水线
  - lint / type-check / test
  - build
  - deploy
- [ ] 实现分支策略：`main` 发布生产，`staging` 发布预发
- [ ] 接入自动化测试（Vitest + Playwright）
- [ ] 配置环境变量管理（开发 / 预发 / 生产）
- [ ] 实现版本号管理与 Changelog 自动生成（Changesets）

### 阶段三：部署与托管（2 周）

- [ ] 静态站点部署到 Vercel / Netlify / Cloudflare Pages
- [ ] 使用 Nginx 自建服务器托管静态资源
- [ ] 容器化部署（Docker + Docker Compose）
- [ ] 接入对象存储（OSS / S3）作为静态资源池
- [ ] 实现灰度发布与回滚机制

### 阶段四：CDN 与缓存策略（2 周）

- [ ] 接入 CDN，配置 CNAME 与回源
- [ ] 实践强缓存（Cache-Control）与协商缓存（ETag / Last-Modified）
- [ ] 使用 Content Hash / 文件名指纹解决缓存更新
- [ ] 实践 HTML 不缓存 + JS/CSS 长缓存策略
- [ ] 使用 Service Worker 实现 SWR 离线缓存
- [ ] HTTP/2、HTTP/3 与资源推送实验

### 阶段五：性能优化与监控（2 周）

- [ ] 接入 Web Vitals 上报（LCP / CLS / INP）
- [ ] 产物体积分析（rollup-plugin-visualizer）
- [ ] 代码分割与按需加载
- [ ] Tree Shaking 与依赖外置
- [ ] 图片资源优化（WebP / AVIF / 响应式图片）
- [ ] 接入 Sentry / 自建错误监控

### 阶段六：进阶工程化（持续）

- [ ] 微前端方案对比与落地（qiankun / Module Federation）
- [ ] SSR / SSG 实践（Next.js / Nuxt）
- [ ] 边缘计算（Cloudflare Workers / Vercel Edge Functions）
- [ ] 构建工具原理深挖（手写简易 Vite / Webpack）
- [ ] BFF 层与 API 网关

## 三、目录结构规划

```
fe-depoly/
├── doc/                  # 学习笔记与方案文档
├── packages/             # monorepo 子包
│   ├── app/              # 主应用
│   ├── ui/               # 组件库
│   └── shared/           # 公共工具
├── scripts/              # 自动化脚本
├── .github/workflows/    # CI/CD 配置
├── docker/               # 容器化配置
├── nginx/                # Nginx 配置
└── docs/                 # 文档站点
```

## 四、学习产出要求

每个阶段需产出以下内容：

1. **实践文档**：记录关键步骤、踩坑点、参考资料
2. **配置文件**：可复用的工程化配置模板
3. **对比分析**：不同方案的优劣对比（如 Vite vs Webpack、Vercel vs 自建）
4. **Demo 验证**：每个特性都要有可运行的最小示例

## 五、参考资料

- Vite 官方文档：https://vitejs.dev/
- GitHub Actions 文档：https://docs.github.com/actions
- Web.dev 性能指南：https://web.dev/performance/
- MDN HTTP 缓存：https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Caching

## 六、时间安排

| 阶段 | 内容 | 预计周期 | 完成时间 |
| --- | --- | --- | --- |
| 一 | 项目初始化与基础构建 | 2 周 | 2026-07-07 |
| 二 | CI/CD 流水线 | 2 周 | 2026-07-21 |
| 三 | 部署与托管 | 2 周 | 2026-08-04 |
| 四 | CDN 与缓存策略 | 2 周 | 2026-08-18 |
| 五 | 性能优化与监控 | 2 周 | 2026-09-01 |
| 六 | 进阶工程化 | 持续 | - |
