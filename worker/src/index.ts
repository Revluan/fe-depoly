interface Env {
  ASSETS_BUCKET: R2Bucket
  GRAY_RULES: KVNamespace
  API_ORIGIN?: string
  ENVIRONMENT: string
  CURRENT_VERSION?: string
  DEPLOY_TIME?: string
  CANARY_PERCENT?: string
}

interface GrayRule {
  type: 'userIdList' | 'percent' | 'header'
  values?: string[]
  value?: number
  headerKey?: string
  headerValues?: string[]
}

interface GrayRelease {
  id: string
  name: string
  artifactId: string
  status: 'draft' | 'running' | 'paused' | 'finished' | 'rolled-back'
  rules: GrayRule[]
}

const CACHE_LONG = 'public, max-age=31536000, immutable'
const CACHE_SHORT = 'public, max-age=0, must-revalidate'

const LONG_CACHE_EXTENSIONS = [
  'js',
  'css',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'map',
]

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env)
    }
    return handleStatic(request, env, ctx)
  },
}

async function handleStatic(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  let path = url.pathname
  if (path === '/') path = '/index.html'

  // 边缘缓存查询(只缓存 GET,且 HTML 不缓存)
  const cacheKey = new Request(request.url, { method: 'GET' })
  const cache = caches.default
  const isHtml = path === '/index.html' || path.endsWith('.html')
  if (request.method === 'GET' && !isHtml) {
    const cached = await cache.match(cacheKey)
    if (cached) return cached
  }

  // 提取 userId,查灰度规则
  const userId = getUserIdFromRequest(request)
  const release = await matchGrayRelease(userId, request, env)

  // 决定用哪份产物:命中灰度用 release.artifactId,否则读 KV current-artifact
  let artifactId: string | null
  if (release) {
    artifactId = release.artifactId
  } else {
    artifactId = await env.GRAY_RULES.get('current-artifact')
  }

  // 优先从 artifacts/{artifactId}/ 取,取不到 fallback 到根目录(过渡期安全网)
  // fallback 情况:KV 还没写、artifactId 对应目录不存在(产物缺失)、本地 dev 没传 KV
  let object: R2ObjectBody | null = null
  if (artifactId) {
    object = await env.ASSETS_BUCKET.get(`artifacts/${artifactId}${path}`)
  }
  if (!object) {
    object = await env.ASSETS_BUCKET.get(path.slice(1))
  }

  const ext = path.split('.').pop()?.toLowerCase() || ''

  // SPA 回退:对象不存在且不是静态文件 → 用对应 artifactId 的 index.html
  if (!object && !LONG_CACHE_EXTENSIONS.includes(ext)) {
    if (artifactId) {
      object = await env.ASSETS_BUCKET.get(`artifacts/${artifactId}/index.html`)
    }
    if (!object) {
      object = await env.ASSETS_BUCKET.get('index.html')
    }
  }
  if (!object) {
    return new Response('Not Found', { status: 404 })
  }

  // HTML 注入动态配置(灰度标识、版本、产物 ID)
  let body: ReadableStream<Uint8Array> | string = object.body
  if (isHtml) {
    const html = await object.text()
    const fallbackArtifactId = env.CURRENT_VERSION || 'unknown'
    const finalArtifactId = artifactId || fallbackArtifactId
    body = html.replace(
      '</head>',
      `<script>window.__APP_CONFIG__=${JSON.stringify({
        env: env.ENVIRONMENT,
        version: env.CURRENT_VERSION || 'unknown',
        artifactId: finalArtifactId,
        releaseId: release?.id || null,
        releaseName: release?.name || null,
        canary: !!release,
        deployTime: env.DEPLOY_TIME || 'unknown',
      })};</script></head>`,
    )
  }

  const response = new Response(body, { headers: buildHeaders(object, ext, isHtml) })

  if (request.method === 'GET' && !isHtml) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()))
  }

  return response
}

// 查所有活跃灰度,看命中哪条。优先级:按 active-releases 顺序,先命中先返回
// 规则类型优先级:userIdList > header > percent(在 matchRule 内部按规则顺序短路)
async function matchGrayRelease(
  userId: string,
  request: Request,
  env: Env,
): Promise<GrayRelease | null> {
  const raw = await env.GRAY_RULES.get('active-releases', 'json')
  if (raw == null) return null

  let releases: GrayRelease[] = []
  if (Array.isArray(raw)) {
    const first = raw[0] as unknown
    if (typeof first === 'string') {
      // 字符串数组:逐个取 release:{id}
      const ids = raw as unknown as string[]
      const results = await Promise.all(
        ids.map((id) => env.GRAY_RULES.get<GrayRelease>(`release:${id}`, 'json')),
      )
      releases = results.filter((r): r is GrayRelease => r != null)
    } else {
      // 已经是对象数组
      releases = raw as unknown as GrayRelease[]
    }
  }

  for (const release of releases) {
    if (release.status !== 'running') continue
    for (const rule of release.rules || []) {
      if (matchRule(rule, userId, request)) {
        return release
      }
    }
  }
  return null
}

function matchRule(rule: GrayRule, userId: string, request: Request): boolean {
  switch (rule.type) {
    case 'userIdList':
      return rule.values?.includes(userId) ?? false
    case 'percent':
      return hashUserId(userId) % 100 < (rule.value ?? 0)
    case 'header': {
      const hv = request.headers.get(rule.headerKey || '')?.toLowerCase()
      return hv ? (rule.headerValues || []).map((v) => v.toLowerCase()).includes(hv) : false
    }
    default:
      return false
  }
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === '/api/health') {
    return jsonResponse({ status: 'ok', env: env.ENVIRONMENT, ts: Date.now() })
  }
  if (path === '/api/version') {
    const currentArtifact = await env.GRAY_RULES.get('current-artifact')
    return jsonResponse({
      version: env.CURRENT_VERSION || 'unknown',
      artifactId: currentArtifact || env.CURRENT_VERSION || 'unknown',
      deployTime: env.DEPLOY_TIME || 'unknown',
      canaryPercent: Number(env.CANARY_PERCENT || 0),
    })
  }

  if (env.API_ORIGIN) {
    const targetUrl = env.API_ORIGIN + path.replace('/api', '')
    return fetch(targetUrl, request)
  }

  return jsonResponse({ message: 'Not Found' }, 404)
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function getUserIdFromRequest(request: Request): string {
  const cookie = request.headers.get('Cookie') || ''
  const match = cookie.match(/user_id=([^;]+)/)
  return match ? match[1] : 'anon-' + Math.random().toString(36).slice(2)
}

function hashUserId(userId: string): number {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function buildHeaders(object: R2ObjectBody, ext: string, isHtml: boolean): Headers {
  const headers = new Headers()

  headers.set('Content-Type', getContentType(ext))

  if (isHtml || ext === 'html') {
    headers.set('Cache-Control', CACHE_SHORT)
    headers.set('Cache-Tag', 'html')
  } else if (LONG_CACHE_EXTENSIONS.includes(ext)) {
    headers.set('Cache-Control', CACHE_LONG)
    headers.set('Cache-Tag', 'static')
  } else {
    headers.set('Cache-Control', CACHE_SHORT)
  }

  if (object.httpEtag) {
    headers.set('ETag', object.httpEtag)
  }

  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  return headers
}

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    eot: 'application/vnd.ms-fontobject',
    map: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
  }
  return types[ext] || 'application/octet-stream'
}
