# 灰度管理 Admin UI 实施方案

## Context

当前 Worker 已支持读 KV 灰度规则,但写入规则只能靠 `wrangler kv key put` CLI,产品/测试同学没法操作。本方案在现有前端项目里加一个灰度管理入口,配套 Worker Admin API,实现灰度规则的增删改查。

约束(用户已确认):
- Admin API 完全开放,不鉴权(学习项目,生产再加)
- 多条规则,动态加减(规则间 OR 关系)
- 状态切换,不引 react-router
- userId 手动改 cookie 测试

## 架构

```
浏览器 (同一 SPA)
  ├─ 主页(现有)
  │   └─ 顶部按钮「灰度管理」→ setView('admin')
  └─ 灰度管理页(新增)
      ├─ 顶部「新增灰度」按钮
      ├─ 灰度列表(表格:ID / 名称 / 产物 / 状态 / 规则数 / 操作)
      └─ 弹窗(新增/编辑)
          ├─ 名称(input)
          ├─ 产物版本(select,选项来自 /api/admin/artifacts)
          ├─ 状态(select: draft/running/paused/finished/rolled-back)
          └─ 规则列表(动态加减)
              ├─ 类型(select: userIdList/percent/header)
              └─ 参数(按类型切换:textarea/number/two inputs)
              └─ 删除按钮
          └─ 保存 / 取消 / 删除(仅编辑时)

Worker /api/admin/* (新增,在 handleApi 里)
  ├─ GET    /api/admin/artifacts      扫 R2 artifacts/ 前缀,返回 buildId 数组
  ├─ GET    /api/admin/releases       读 KV active-releases,返回数组
  ├─ POST   /api/admin/releases       追加新 release,写回 KV
  ├─ PATCH  /api/admin/releases/:id   更新指定 release
  └─ DELETE /api/admin/releases/:id   删除指定 release
```

## 数据模型(复用现有类型)

`worker/src/index.ts` 已定义 `GrayRelease` 和 `GrayRule`,前端直接 mirror 一份类型。

**存储策略**:`active-releases` 这个 KV key 直接存 `GrayRelease[]` 对象数组(inline)。Worker 的 `matchGrayRelease` 已经支持这种格式。

**ID 生成**:前端生成 `exp-{Date.now()}-{random4}`,例如 `exp-1719400000000-a1b2`。

**并发写**:KV 是最终一致,两个并发 POST 可能丢一条。学习项目可接受,生产环境要加版本号或用 Durable Object 串行化。代码注释说明。

## 文件改动清单

### Worker (1 个文件)

**`worker/src/index.ts`** — 在 `handleApi` 函数里,`/api/version` 之后、`API_ORIGIN` 反代之前,加 `/api/admin/*` 路由分支。

复用现有:
- `jsonResponse(data, status)` 工具函数
- `GrayRelease` / `GrayRule` 类型
- `env.GRAY_RULES` KV 绑定
- `env.ASSETS_BUCKET` R2 绑定(列 artifacts)

新增函数:
- `handleAdmin(request, env)` — 路由分发
- `listArtifacts(env)` — `env.ASSETS_BUCKET.list({ prefix: 'artifacts/', limit: 1000 })`,正则提取 `^artifacts/([^/]+)/`,去重返回
- `listReleases(env)` — 读 `active-releases`,空则返回 `[]`
- `createRelease(env, body)` — 生成 ID,校验 body,append 到 active-releases,写回
- `updateRelease(env, id, body)` — 找到对应 release,合并字段,写回
- `deleteRelease(env, id)` — 过滤掉对应 ID,写回

### 前端 (4 个文件)

**`src/App.tsx`** (改) — 加 `view` 状态,header 加「灰度管理」按钮,条件渲染 `AdminPage`。

**`src/AdminPage.tsx`** (新) — 灰度管理列表页。
- `useEffect` 拉 `/api/admin/releases` 和 `/api/admin/artifacts`
- 表格列:ID、名称、产物(截短 buildId)、状态(badge)、规则数、操作(编辑/删除)
- 顶部「新增灰度」按钮 → 打开空表单弹窗
- 点行 → 打开填充表单弹窗
- 顶部「返回主页」按钮 → `setView('app')`

**`src/ReleaseModal.tsx`** (新) — 表单弹窗。
- Props: `release`(null=新增)、`artifacts`、`onSave`、`onClose`、`onDelete`
- 字段:名称、artifactId(select)、状态(select)、规则(动态数组)
- 规则编辑:类型 select + 条件渲染参数输入(userIdList→textarea 每行一个 / percent→number / header→两个 input)
- 规则加减:`+ 添加规则` 按钮 append 空规则,每条规则有 `×` 删除
- 保存:校验后调 POST 或 PATCH,成功回调父组件刷新列表
- 删除:确认后调 DELETE

**`src/api.ts`** (新) — fetch 包装,集中管理 endpoint。
- `listArtifacts()`: GET /api/admin/artifacts
- `listReleases()`: GET /api/admin/releases
- `createRelease(body)`: POST /api/admin/releases
- `updateRelease(id, body)`: PATCH /api/admin/releases/:id
- `deleteRelease(id)`: DELETE /api/admin/releases/:id
- 统一 JSON 解析 + 错误抛出

**`src/App.css`** (改) — 加样式,沿用现有色板(`#646cff` 主色、`#6b7280` 弱化文字、`#213547` 主文字)。
- `.admin-page` 容器(max-width 960px,左对齐)
- `.admin-table` 表格
- `.admin-badge` 状态标签(按状态着色)
- `.modal-overlay` / `.modal` 弹窗
- `.form-field` / `.form-row` 表单布局
- `.rule-row` 规则行(横向排列)
- `.btn-danger` 删除按钮(红色变体)

## 关键实现细节

### Worker Admin 路由

```ts
// 在 handleApi 里,/api/version 之后,API_ORIGIN 之前
if (path.startsWith('/api/admin/')) {
  return handleAdmin(request, env)
}
```

`handleAdmin` 用 `url.pathname` + `request.method` 分发,不引框架。注意 `noUnusedParameters` 严格模式,参数都要用上或加 `_` 前缀。

### R2 list 提取 buildId

```ts
const listed = await env.ASSETS_BUCKET.list({ prefix: 'artifacts/', limit: 1000 })
const buildIds = new Set<string>()
for (const obj of listed.objects) {
  const m = obj.key.match(/^artifacts\/([^/]+)\//)
  if (m) buildIds.add(m[1])
}
return [...buildIds]
```

R2 list 单次最多 1000 个对象,一个 buildId 目录通常有 5-20 个文件,够覆盖 50+ 个构建。超出加 cursor 翻页。

### KV 写并发保护

简单方案:读-改-写,不锁。注释说明风险。学习项目可接受,后续要严格可切 D1 或 Durable Object。

### 前端类型复用

`src/api.ts` 里 mirror Worker 的 `GrayRelease` / `GrayRule` 类型,不共享文件(Worker 和前端是不同 tsconfig,共享类型需要建 monorepo,过度设计)。

### 规则参数条件渲染

```tsx
{rule.type === 'userIdList' && (
  <textarea value={rule.values?.join('\n') || ''} onChange={...} />
)}
{rule.type === 'percent' && (
  <input type="number" min={0} max={100} value={rule.value ?? 0} onChange={...} />
)}
{rule.type === 'header' && (
  <>
    <input placeholder="header key" value={rule.headerKey || ''} onChange={...} />
    <input placeholder="values, comma separated" value={rule.headerValues?.join(',') || ''} onChange={...} />
  </>
)}
```

类型变更时清空无关字段,避免脏数据。

### 弹窗实现

不引 UI 库,用 fixed 定位 + 半透明遮罩。`onClick` 遮罩区域关闭,内容区域 `stopPropagation`。Esc 键关闭可选(简单实现可省)。

## 验证

1. **CI 部署成功**:push 后 GitHub Actions 跑通,Worker 部署成功
2. **Admin API 通**:
   ```bash
   curl https://域名/api/admin/artifacts  # 应返回 buildId 数组
   curl https://域名/api/admin/releases    # 应返回 [] 或现有数组
   ```
3. **前端 UI**:
   - 打开站点,顶部应有「灰度管理」按钮
   - 点击进入,看到空列表(或现有规则)
   - 点「新增灰度」,填名称=test、选个 artifactId、加一条 userIdList 规则 values=[`test-user`]、状态=running,保存
   - 列表出现新条目
4. **端到端验证灰度生效**:
   - 浏览器 DevTools → Application → Cookies → 加 `user_id=test-user`
   - 刷新主页,header 应显示「(Canary)」+ Release: test
   - 改 `user_id=other`,刷新,应该回到全量版本(无 Canary 标识)
5. **删除**:在弹窗里点删除,列表消失,`user_id=test-user` 也回到全量版本
6. **类型检查 + lint + test**:`npm run type-check && npm run lint && npm test` 全过

## 不做的事

- 鉴权(用户选了完全开放)
- 实验分桶/互斥(多灰度并存按顺序匹配,够用)
- 监控大盘(后续接 Sentry release 维度即可)
- 审批流(直接生效)
- 历史版本回滚 UI(用现有 artifacts 列表 + 新建灰度就能模拟)
