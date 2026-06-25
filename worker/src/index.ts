interface Env {
  ASSETS_BUCKET: R2Bucket
  API_ORIGIN?: string
  ENVIRONMENT: string
  CURRENT_VERSION?: string
  DEPLOY_TIME?: string
  CANARY_PERCENT?: string
}

// 静态资源长缓存(1 年),HTML 不缓存
const CACHE_LONG = 'public, max-age=31536000, immutable'
const CACHE_SHORT = 'public, max-age=0, must-revalidate'

// 需要长缓存的文件类型(hash 文件名才安全)
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
    // 路径分流:/api/* 走 BFF,其他走静态资源 + HTML
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env)
    }
    return handleStatic(request, env, ctx)
  },
}

// 静态资源 + HTML + SPA 回退 + 边缘缓存 + 灰度注入
async function handleStatic(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  let path = url.pathname
  if (path === '/') path = '/index.html'

  // 边缘缓存查询(只缓存 GET)
  const cacheKey = new Request(request.url, { method: 'GET' })
  const cache = caches.default
  if (request.method === 'GET') {
    const cached = await cache.match(cacheKey)
    if (cached) return cached
  }

  // 从 R2 取对象
  let object = await env.ASSETS_BUCKET.get(path.slice(1))
  const ext = path.split('.').pop()?.toLowerCase() || ''

  // SPA 回退:对象不存在且不是静态文件 → 返回 index.html
  if (!object && !LONG_CACHE_EXTENSIONS.includes(ext)) {
    object = await env.ASSETS_BUCKET.get('index.html')
  }
  if (!object) {
    return new Response('Not Found', { status: 404 })
  }

  const isHtml = ext === 'html' || path === '/index.html'

  // HTML 注入动态配置(灰度标识、版本、环境)
  let body: ReadableStream<Uint8Array> | string = object.body
  if (isHtml) {
    const html = await object.text()
    const userId = getUserIdFromRequest(request)
    const inCanary = hashUserId(userId) % 100 < Number(env.CANARY_PERCENT || 0)
    body = html.replace(
      '</head>',
      `<script>window.__APP_CONFIG__=${JSON.stringify({
        env: env.ENVIRONMENT,
        version: env.CURRENT_VERSION || 'unknown',
        canary: inCanary,
        deployTime: env.DEPLOY_TIME || 'unknown',
      })};</script></head>`,
    )
  }

  const response = new Response(body, { headers: buildHeaders(object, ext, isHtml) })

  // 静态资源写入边缘缓存(HTML 不缓存,保证发版即时生效)
  if (request.method === 'GET' && !isHtml) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()))
  }

  return response
}

// BFF:内置端点 + 反代外部后端
async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === '/api/health') {
    return jsonResponse({ status: 'ok', env: env.ENVIRONMENT, ts: Date.now() })
  }
  if (path === '/api/version') {
    return jsonResponse({
      version: env.CURRENT_VERSION || 'unknown',
      deployTime: env.DEPLOY_TIME || 'unknown',
      canaryPercent: Number(env.CANARY_PERCENT || 0),
    })
  }

  // 反代到外部后端(如果配置了 API_ORIGIN)
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
