# OSS 静态站点部署实战:对象存储 + CDN

> 配套文档:`doc/docker-depoly.md`(Docker 部署基础)、`doc/ci-docker.md`(CI/CD 自动化)、`doc/gray-depoly.md`(灰度发布)。
> 前置条件:已完成 `docker-depoly.md`,本地能 `npm run build` 产出 `dist/`。
> 目标:把前端构建产物直接传到阿里云 OSS,通过 OSS URL 或 CDN 访问,**不用维护服务器**,生产推荐方案。

## 一、什么是对象存储,跟其他部署方案的区别

### 1.1 对象存储是什么

**对象存储(Object Storage)** 是一种"通过 HTTP 访问的海量文件系统"。你把文件(称为"对象")传上去,得到一个 URL,任何人通过浏览器/curl 都能访问。

| 云厂商 | 产品名 | 备注 |
| --- | --- | --- |
| 阿里云 | OSS(Object Storage Service) | 国内首选,个人版几乎免费 |
| 亚马逊 | S3(Simple Storage Service) | 全球,事实标准 |
| 腾讯云 | COS(Cloud Object Storage) | 国内,跟 OSS 类似 |
| 华为云 | OBS(Object Storage Service) | 国内 |
| Cloudflare | R2 | 全球,S3 兼容,无出口流量费 |

**本文用阿里云 OSS** 演示(承接前面的 ACR 体系),其他厂商概念一致,命令略有不同。

### 1.2 跟其他前端部署方案对比

| 方案 | 静态文件存哪 | 谁服务请求 | 优劣 |
| --- | --- | --- | --- |
| **Docker + Nginx**(已做) | 容器内 | 你服务器上的 nginx | 可控,要维护服务器/带宽/HTTPS |
| **OSS 直连** | OSS bucket | OSS 服务 | 不用服务器,URL 直接访问 |
| **OSS + CDN**(生产推荐) | OSS bucket | CDN 边缘节点(全国 100+) | 全国都快,流量便宜,HTTPS 现成 |
| **Vercel / Netlify** | 平台内部 | 平台 CDN | 最省心,但费用高、定制弱 |
| **GitHub Pages** | GitHub 仓库 | GitHub CDN | 免费,但国内访问慢 |

### 1.3 主要适用场景

| 场景 | 是否适合 OSS |
| --- | --- |
| 前端静态站部署(SPA / SSG) | ✅ 完美适配 |
| 大文件存储(图片/视频/音频) | ✅ |
| 用户上传文件(头像/附件) | ✅(配 STS 临时凭证) |
| 日志归档 / 数据备份 | ✅ |
| CDN 回源源站 | ✅ |
| 需要 SSR(服务端渲染) | ❌ 用函数计算 / 服务器 |
| 需要复杂路由 / 鉴权 | ❌ 用服务器 / 边缘函数 |

## 二、整体架构

### 2.1 OSS 直连(最简方案)

```
开发者本地                阿里云 OSS
┌──────────┐             ┌──────────────────────┐
│ npm run  │  ossutil cp │ bucket: fe-depoly    │
│  build   │ ─────────►  │  ├─ index.html       │
│          │             │  ├─ assets/          │
│ dist/    │             │  └─ ...              │
└──────────┘             └──────────┬───────────┘
                                    │
                          用户 ──────►
                          https://fe-depoly.oss-cn-hangzhou.aliyuncs.com/
```

### 2.2 OSS + CDN(生产推荐)

```
开发者                阿里云                            用户
┌──────────┐    ┌──────────────────────┐
│ npm run  │    │ OSS(源站)            │
│  build   │ ─► │  bucket: fe-depoly   │
└──────────┘    └──────────┬───────────┘
                           │ 回源
                           ▼
                ┌──────────────────────┐
                │ CDN 边缘节点          │
                │ (全国 100+ 节点)     │ ◄──── 用户就近访问
                └──────────────────────┘
```

用户访问 `https://cdn.yourdomain.com/` → 命中最近的 CDN 节点 → 节点没缓存就回源到 OSS → 缓存后返回给用户。

## 三、前置准备

### 3.1 开通阿里云 OSS

1. 登录 https://oss.console.aliyun.com/
2. 开通服务(免费,个人无需实名也可用,但建议实名)
3. 进入控制台 → 概览 → 记下 **Endpoint**,形如:
   ```
   oss-cn-hangzhou.aliyuncs.com
   ```
   > 这是你的 OSS 接入点,**地域不同地址不同**(杭州、北京、上海...)。

### 3.2 创建 AccessKey

`ossutil` 命令行工具需要 AccessKey 凭证来访问 OSS。

1. 阿里云控制台 → 右上角头像 → **AccessKey 管理**
2. **强烈建议**:用 RAM 子账号创建 AccessKey,不要用主账号
   - 主账号 AK 泄露 = 整个云账号被控制,风险极高
   - RAM 子账号只给 OSS 权限,泄露只影响 OSS
3. 创建 RAM 用户:
   - 用户名:`oss-deploy`(随便起)
   - 访问方式:编程访问(勾选)
   - 权限:授予 `AliyunOSSFullAccess`(或更细粒度的自定义策略)
4. 创建完成后**立即保存** AccessKey ID + Secret(关闭窗口后不能再查 Secret)

### 3.3 创建 Bucket

1. OSS 控制台 → Bucket 列表 → 创建 Bucket
2. 关键配置:
   - **Bucket 名称**:全局唯一,如 `fe-depoly-prod`(域名一部分,起短点)
   - **地域**:选离用户近的(华东 1 杭州 / 华北 2 北京)
   - **存储类型**:标准存储(常用)
   - **读写权限**:**公共读**(前端静态站必须,否则用户访问不了)
   - **服务端加密**:无(或 OSS 完全托管,都行)
3. 创建完成后,在 Bucket 概览页能看到:
   - Bucket 名称:`fe-depoly-prod`
   - Endpoint:`oss-cn-hangzhou.aliyuncs.com`
   - 访问域名:`https://fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com`

> **读写权限选"公共读"**:意味着任何人能读你的文件,但不能写。前端静态站必须这样,否则用户浏览器访问会被拒绝。**绝不要选"公共读写"**(所有人能删改你的文件)。

### 3.4 安装 ossutil

`ossutil` 是阿里云 OSS 的命令行工具,用来上传/下载/管理文件。

#### 本地 Mac/Linux

```bash
# 下载最新版(查看最新版本:https://help.aliyun.com/document_detail/120075.html)
curl -o /usr/local/bin/ossutil https://gosspublic.alicdn.com/ossutil/1.7.18/ossutil64
chmod +x /usr/local/bin/ossutil

# 验证
ossutil version
```

#### 服务器(Ubuntu)

```bash
sudo curl -o /usr/local/bin/ossutil https://gosspublic.alicdn.com/ossutil/1.7.18/ossutil64
sudo chmod +x /usr/local/bin/ossutil
ossutil version
```

#### 配置凭证

```bash
ossutil config
# 提示输入:
# 1. config file 路径(直接回车,默认 ~/.ossutilconfig)
# 2. AccessKey ID    ← 粘贴第 3.2 步保存的 AK ID
# 3. AccessKey Secret ← 粘贴第 3.2 步保存的 AK Secret
# 4. STS Token       ← 直接回车(不用 STS)
# 5. Endpoint        ← 填第 3.1 步记的,如 oss-cn-hangzhou.aliyuncs.com
```

验证配置成功:

```bash
ossutil ls oss://fe-depoly-prod/
# 输出 bucket 里的文件列表(新建的应该是空的)
```

## 四、手动部署流程

### 4.1 本地构建

```bash
cd /path/to/fe-depoly
npm run build -- --mode production
# 产物在 dist/
ls dist/
# index.html  assets/  ...
```

### 4.2 上传到 OSS

#### 单文件上传

```bash
# 上传 index.html
ossutil cp dist/index.html oss://fe-depoly-prod/index.html

# 上传整个 assets 目录(递归)
ossutil cp -r dist/assets/ oss://fe-depoly-prod/assets/
```

#### 一次性同步整个 dist(推荐)

```bash
# --update:只上传修改过的文件(按 mtime + size 判断)
# --delete:删除 OSS 上有但本地没有的文件(保持同步)
ossutil cp -r dist/ oss://fe-depoly-prod/ --update --delete
```

> 第一次跑会上传所有文件,之后只传变化的(比如只有 index.html 和 hash 变了的 assets)。

### 4.3 验证上传

```bash
# 列 bucket 里的文件
ossutil ls oss://fe-depoly-prod/

# 浏览器访问
open https://fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com/index.html
# 或 curl
curl https://fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com/index.html
```

应该看到你的页面 HTML。

### 4.4 配置 SPA fallback(关键)

你的项目是 React SPA,路由是客户端处理的。访问 `https://.../about` 时,OSS 找不到 `/about` 这个对象会返回 404——但实际上应该返回 `index.html` 让前端路由处理。

#### 配置静态网站托管

```bash
# 开启静态网站托管,index 文档和 404 文档都设为 index.html
ossutil web --method put \
  --bucket fe-depoly-prod \
  --index-document index.html \
  --error-document index.html
```

或在 OSS 控制台配:

1. 进入 bucket → **基础设置 → 静态页面**
2. 默认首页:`index.html`
3. 默认 404 页:`index.html`(关键,SPA 路由靠这个)
4. 保存

#### 用网站访问域名(不是默认域名)

配置后,访问**网站域名**才能生效:

```
http://fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com/
```

注意是 `http://` 不是 `https://`(OSS 静态网站托管默认 http,要 HTTPS 得绑定自定义域名)。

测试 SPA 路由:

```bash
# 访问一个不存在的路径,应该返回 index.html(200),不是 404
curl http://fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com/some/route
# 应该看到 index.html 内容
```

## 五、缓存策略(跟阶段四 CDN 缓存呼应)

### 5.1 OSS 上传时设置 Cache-Control

Vite 构建产物有两类文件:

| 文件类型 | 路径特征 | 缓存策略 |
| --- | --- | --- |
| **带 hash 的 assets** | `/assets/index-a1b2c3.js` | 长缓存(1 年),因为内容变 hash 就变 |
| **index.html** | `/index.html` | 不缓存,保证用户拿到最新 HTML |

#### 上传时分别设置

```bash
# 1. index.html:不缓存
ossutil cp dist/index.html oss://fe-depoly-prod/index.html \
  --meta Cache-Control:no-cache

# 2. assets:长缓存 + immutable
ossutil cp -r dist/assets/ oss://fe-depoly-prod/assets/ \
  --meta "Cache-Control:max-age=31536000,public,immutable"

# 3. 其他静态资源(图片等,看情况)
ossutil cp -r dist/public/ oss://fe-depoly-prod/ \
  --meta "Cache-Control:max-age=86400,public"
```

> `immutable` 告诉浏览器:这个文件永远不会变,不用发协商缓存请求。配合文件名 hash 完美。

### 5.2 验证缓存头

```bash
curl -I http://fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com/assets/index-a1b2c3.js
# 看 HTTP 响应头:
# Cache-Control: max-age=31536000, public, immutable

curl -I http://fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com/index.html
# Cache-Control: no-cache
```

### 5.3 一条命令同步 + 设置缓存元数据

实际部署中,写个脚本批量处理:

```bash
#!/bin/bash
# deploy-oss.sh

set -e

BUCKET=oss://fe-depoly-prod

# 1. 同步整个 dist(不带元数据,保持原有)
ossutil cp -r dist/ $BUCKET/ --update --delete

# 2. 给 index.html 单独设 no-cache
ossutil set-meta $BUCKET/index.html Cache-Control:no-cache --update

# 3. 给 assets 目录设长缓存
ossutil set-meta $BUCKET/assets/ \
  "Cache-Control:max-age=31536000,public,immutable" \
  --update --recursive

echo "✓ Deploy to OSS success"
```

赋权 + 运行:

```bash
chmod +x deploy-oss.sh
./deploy-oss.sh
```

## 六、CI/CD 自动化部署

### 6.1 配置 GitHub Secrets

仓库 `Settings → Secrets and variables → Actions → New repository secret`,添加:

| Secret 名 | 值 | 用途 |
| --- | --- | --- |
| `OSS_ACCESS_KEY_ID` | RAM 用户 AK ID | ossutil 认证 |
| `OSS_ACCESS_KEY_SECRET` | RAM 用户 AK Secret | ossutil 认证 |
| `OSS_ENDPOINT` | `oss-cn-hangzhou.aliyuncs.com` | OSS 接入点 |
| `OSS_BUCKET` | `fe-depoly-prod` | bucket 名称 |

### 6.2 workflow: deploy-oss.yml

在 `.github/workflows/` 创建 `deploy-oss.yml`:

```yaml
name: Deploy to OSS

on:
  push:
    tags: ['v*.*.*']
  workflow_dispatch:
    inputs:
      version:
        description: '版本号(留空用 latest)'
        required: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'

      - name: Install deps
        run: npm ci

      - name: Build
        run: npm run build -- --mode production
        env:
          VITE_APP_VERSION: ${{ inputs.version || github.ref_name }}

      - name: Install ossutil
        run: |
          wget https://gosspublic.alicdn.com/ossutil/1.7.18/ossutil64 -O /usr/local/bin/ossutil
          chmod +x /usr/local/bin/ossutil

      - name: Configure ossutil
        run: |
          ossutil config \
            -i ${{ secrets.OSS_ACCESS_KEY_ID }} \
            -k ${{ secrets.OSS_ACCESS_KEY_SECRET }} \
            -e ${{ secrets.OSS_ENDPOINT }}

      - name: Sync dist to OSS
        run: |
          ossutil cp -r dist/ oss://${{ secrets.OSS_BUCKET }}/ \
            --update --delete \
            --meta "Cache-Control:max-age=300,public"

      - name: Set index.html no-cache
        run: |
          ossutil set-meta oss://${{ secrets.OSS_BUCKET }}/index.html \
            "Cache-Control:no-cache" --update

      - name: Set assets long cache
        run: |
          ossutil set-meta oss://${{ secrets.OSS_BUCKET }}/assets/ \
            "Cache-Control:max-age=31536000,public,immutable" \
            --update --recursive

      - name: Summary
        run: |
          echo "### Deployed to OSS ✅" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "Access URL: http://${{ secrets.OSS_BUCKET }}.${{ secrets.OSS_ENDPOINT }}/" >> $GITHUB_STEP_SUMMARY
```

### 6.3 触发方式

```bash
# 打 tag 自动部署
git tag v1.0.2
git push origin v1.0.2

# 或手动触发(GitHub Actions UI → Run workflow)
```

CI 跑完后,访问 `http://fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com/` 看到新版本。

## 七、接入 CDN(生产推荐)

OSS 直连虽然能用,但:

- OSS 节点单一(就一个地域),离得远的用户访问慢
- 没有 HTTPS(默认域名)
- 没有 HTTP/2、Brotli 压缩等优化

套一层 CDN 解决所有问题。

### 7.1 开通阿里云 CDN

1. https://cdn.console.aliyun.com/ 开通服务(免费)
2. 添加加速域名:
   - 加速域名:`cdn.yourdomain.com`(需要你已有域名)
   - 业务类型:小文件下载(前端静态站)
   - 源站信息:
     - 源站类型:OSS Bucket
     - 选择你刚创建的 bucket
   - 端口:443(HTTPS,需要先配证书)或 80(HTTP)
3. 加速域名创建后,CDN 给你一个 CNAME,如:
   ```
   fe-depoly-prod.cdn.dnsv1.com
   ```

### 7.2 DNS 解析

在你的域名 DNS 控制台添加 CNAME 记录:

| 记录类型 | 主机记录 | 记录值 |
| --- | --- | --- |
| CNAME | cdn | fe-depoly-prod.cdn.dnsv1.com |

等 DNS 生效(1-10 分钟):

```bash
dig cdn.yourdomain.com
# 或
nslookup cdn.yourdomain.com
# 应该解析到 CDN 的 CNAME
```

### 7.3 配置 HTTPS

1. 阿里云数字证书管理服务 → 申请免费证书(DV 证书,1 年免费)
2. 域名验证通过后下载证书
3. CDN 控制台 → 域名管理 → 你的域名 → HTTPS 配置 → 上传证书
4. 强制跳转 HTTPS:开

### 7.4 配置缓存规则

CDN 控制台 → 域名管理 → 缓存配置 → 添加规则:

| 路径匹配 | 缓存时长 | 优先级 |
| --- | --- | --- |
| `/index.html` | 不缓存(或 1 秒) | 100(最高) |
| `/assets/*` | 30 天 | 90 |
| `/*.html` | 1 分钟 | 80 |
| `/*.js` `/*.css` | 30 天 | 70 |
| 默认 | 1 小时 | 1 |

> 注意:**CDN 缓存**跟 **OSS Cache-Control** 是两层。CDN 缓存控制边缘节点,OSS Cache-Control 控制源站响应头。两者配合用。

### 7.5 验证 CDN 生效

```bash
# 看响应头,应该有 CDN 相关字段
curl -I https://cdn.yourdomain.com/
# 期望看到:
# Server: Tengine
# X-Cache: HIT (缓存命中)
# Via: cache-xxx.l2xxx(...)
```

`X-Cache: HIT` 表示 CDN 节点已缓存,MISS 表示要回源。

## 八、回滚

### 8.1 OSS 版本控制(推荐)

OSS 开启版本控制后,每个文件都有历史版本,回滚就是切回旧版本。

```bash
# 开启版本控制
ossutil bucket-versioning --method put oss://fe-depoly-prod

# 列出 index.html 的所有历史版本
ossutil ls oss://fe-depoly-prod/index.html --all-versions

# 把指定版本设为当前版本
ossutil cp oss://fe-depoly-prod/index.html oss://fe-depoly-prod/index.html \
  --version-id CAQQARiBgIDxxxxxxxxx -f
```

### 8.2 切回旧 tag(走 CI 重部)

最简单的回滚:用 `workflow_dispatch` 触发,checkout 旧 tag 重新构建部署。

```bash
# 在 GitHub Actions UI 触发 deploy-oss.yml
# Run workflow → 输入 v1.0.0 → Run
```

### 8.3 CDN 缓存刷新

回滚后,CDN 缓存可能还指向旧内容。强制刷新:

```bash
# 阿里云 CDN 控制台 → 刷新预热 → 提交刷新
# 或用 aliyun CLI
aliyun cdn PushObjectCache --ObjectPath "https://cdn.yourdomain.com/"
```

## 九、踩坑点

1. **Bucket 名全局唯一**:`fe-depoly` 早就被别人占了,加后缀如 `fe-depoly-prod-xxx`。
2. **公共读权限漏配**:Bucket 默认私有,用户访问返回 403。前端静态站必须设为"公共读"。
3. **SPA 路由 404**:忘了配静态网站托管的 404 文档为 `index.html`,访问 `/about` 返回 OSS 默认 404 页。**必须配 error-document**。
4. **index.html 被长缓存**:用户拿到老 HTML,即使部署了新版本也看不到。`index.html` 必须 `no-cache`。
5. **HTTPS 域名访问 OSS 报错**:OSS 默认域名 `*.aliyuncs.com` 只支持 HTTP,要 HTTPS 必须绑定自定义域名。CDN 是最简单的 HTTPS 方案。
6. **OSS 跨域(CORS)**:如果你的前端要请求另一个域名的 API,API 服务器要配 CORS。OSS 本身不需要 CORS(它是被访问方,不是发起方)。
7. **ossutil 同步会删文件**:`--delete` 参数会删除 OSS 上有但本地没有的文件。生产用前先 `--dry-run` 预览:
   ```bash
   ossutil cp -r dist/ oss://bucket/ --update --delete --dry-run
   ```
8. **CDN 缓存击穿**:回滚后忘了刷新 CDN,用户看到旧内容。回滚必刷 CDN。
9. **大文件上传慢**:OSS 单文件 5GB 上限,但大文件上传慢。用 `--bigfile-threshold` 分片上传:
   ```bash
   ossutil cp -r dist/ oss://bucket/ --bigfile-threshold 10485760
   ```
10. **AK 泄露**:`.env` 文件、CI 日志里别打印 AK。GitHub Secrets 不会打印,但本地脚本要注意。RAM 子账号权限最小化(只给 OSS 读写,不给其他云产品权限)。
11. **费用超预期**:OSS 存储便宜(0.12 元/GB/月),但**流量费**可能贵(0.5 元/GB)。配 CDN 后流量走 CDN 计费(更便宜,0.24 元/GB)。开预算告警,避免异常流量爆账单。
12. **地域选错**:OSS 在杭州,用户在海外 → 访问慢。国内用户选杭州/北京/上海,海外用户选香港/新加坡,跨国用 CDN。

## 十、本仓库落地步骤(推荐顺序)

### 10.1 跑通手动部署(30 分钟)

1. 开通阿里云 OSS,创建 RAM 子账号 + AccessKey
2. 创建 bucket `fe-depoly-prod`(公共读)
3. 本地装 ossutil,配置凭证
4. 本地 `npm run build`
5. 用 `ossutil cp -r dist/ oss://fe-depoly-prod/ --update --delete` 上传
6. 配置静态网站托管(index + 404 都设 index.html)
7. 浏览器访问 `http://fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com/`
8. 设置 Cache-Control(`index.html` 不缓存,`assets/` 长缓存)

### 10.2 接入 CI 自动化(20 分钟)

1. 配 GitHub Secrets(`OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` / `OSS_ENDPOINT` / `OSS_BUCKET`)
2. 创建 `.github/workflows/deploy-oss.yml`(参考第六节)
3. 打 `v1.0.2` tag,push,看 CI 自动构建并部署到 OSS
4. 访问 OSS URL 验证新版本

### 10.3 接入 CDN(1 小时,可选)

1. 开通阿里云 CDN
2. 添加加速域名(需要自己的域名)
3. DNS 解析配 CNAME
4. 配 HTTPS(申请免费证书)
5. 配缓存规则
6. 访问 `https://cdn.yourdomain.com/` 验证

### 10.4 跟 Docker 部署对比(15 分钟)

同时跑两种方案,访问对比:

- `http://113.31.107.142/` → Docker + Nginx
- `http://fe-depoly-prod.oss-cn-hangzhou.aliyuncs.com/` → OSS 直连
- `https://cdn.yourdomain.com/` → OSS + CDN

体感差异:CDN 全国都快,Docker 受服务器地域限制,OSS 直连单点。

### 10.5 验证缓存策略(阶段四预演)

1. `curl -I` 看响应头 `Cache-Control`
2. 二次访问看 `X-Cache: HIT`(CDN 命中)
3. 改个文案重新部署,看 `index.html` 立刻更新、`assets/index-xxx.js` 因为 hash 变了也更新
4. 浏览器 DevTools → Network → 看资源 `from disk cache` / `from memory cache`

## 十一、OSS vs Docker 部署:什么时候用哪个

| 场景 | 推荐 | 原因 |
| --- | --- | --- |
| 个人作品集 / 博客 | OSS + CDN | 免费、稳定、不用维护 |
| 公司官网 / 营销页 | OSS + CDN | 流量大、要求快、CDN 加速必选 |
| 内部后台管理系统 | Docker + Nginx | 流量小、可能要内网访问、可控 |
| 需要 SSR / 后端 API | Docker / 服务器 | OSS 不能跑服务端代码 |
| 需要灰度发布 | Docker(配 nginx 分流) | OSS 分流要靠 CDN,配置复杂 |
| 突发大流量(活动页) | OSS + CDN | CDN 扛流量,OSS 不挂 |
| 用户上传文件(头像等) | OSS(后端签 STS) | 不走服务器,省带宽 |

## 十二、参考链接

- 阿里云 OSS 官方文档:https://help.aliyun.com/product/31815.html
- ossutil 命令参考:https://help.aliyun.com/document_detail/50452.html
- OSS 静态网站托管:https://help.aliyun.com/document_detail/31872.html
- 阿里云 CDN 文档:https://help.aliyun.com/product/27099.html
- AWS S3 静态站托管(对照参考):https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html
- Cloudflare R2(S3 兼容,无出口费):https://developers.cloudflare.com/r2/
- Vite 构建产物 hash 原理:https://vitejs.dev/guide/build.html
