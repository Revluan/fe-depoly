interface Env {
  ASSETS_BUCKET: R2Bucket
  ENVIRONMENT: string
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    let path = url.pathname

    // 1. 根路径 → index.html
    if (path === '/') path = '/index.html'

    // 2. 尝试从 R2 取对象
    let object = await env.ASSETS_BUCKET.get(path.slice(1))

    // 3. SPA 回退:对象不存在且不是静态文件 → 返回 index.html
    const ext = path.split('.').pop()?.toLowerCase() || ''
    if (!object && !LONG_CACHE_EXTENSIONS.includes(ext)) {
      object = await env.ASSETS_BUCKET.get('index.html')
      // 回退的响应用短缓存
      if (object) {
        return new Response(object.body, {
          headers: buildHeaders(object, ext, true),
        })
      }
    }

    // 4. 对象不存在 → 404
    if (!object) {
      return new Response('Not Found', { status: 404 })
    }

    // 5. 返回对象 + 缓存头
    return new Response(object.body, {
      headers: buildHeaders(object, ext, false),
    })
  },
}

function buildHeaders(object: R2ObjectBody, ext: string, isHtml: boolean): Headers {
  const headers = new Headers()

  // Content-Type
  headers.set('Content-Type', getContentType(ext))

  // 缓存策略:HTML 短缓存,静态资源长缓存
  if (isHtml || ext === 'html') {
    headers.set('Cache-Control', CACHE_SHORT)
    headers.set('Cache-Tag', 'html')
  } else if (LONG_CACHE_EXTENSIONS.includes(ext)) {
    headers.set('Cache-Control', CACHE_LONG)
    headers.set('Cache-Tag', 'static')
  } else {
    headers.set('Cache-Control', CACHE_SHORT)
  }

  // ETag(R2 对象自带)
  if (object.httpEtag) {
    headers.set('ETag', object.httpEtag)
  }

  // 安全头
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
