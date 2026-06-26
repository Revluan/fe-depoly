// 前端 API 客户端:封装 /api/admin/* 端点调用
// 类型 mirror Worker 的 GrayRelease / GrayRule(不共享文件,Worker 和前端是不同 tsconfig)

export type RuleType = 'userIdList' | 'percent' | 'header'

export interface GrayRule {
  type: RuleType
  values?: string[]
  value?: number
  headerKey?: string
  headerValues?: string[]
}

export type ReleaseStatus = 'draft' | 'running' | 'paused' | 'finished' | 'rolled-back'

export interface GrayRelease {
  id: string
  name: string
  artifactId: string
  status: ReleaseStatus
  rules: GrayRule[]
}

async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
  }
  return res.json() as Promise<T>
}

export async function listArtifacts(): Promise<string[]> {
  const res = await fetch('/api/admin/artifacts')
  const data = await parseResponse<{ artifacts: string[] }>(res)
  return data.artifacts
}

export async function listReleases(): Promise<GrayRelease[]> {
  const res = await fetch('/api/admin/releases')
  const data = await parseResponse<{ releases: GrayRelease[] }>(res)
  return data.releases
}

export async function createRelease(body: Omit<GrayRelease, 'id'>): Promise<GrayRelease> {
  const res = await fetch('/api/admin/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await parseResponse<{ release: GrayRelease }>(res)
  return data.release
}

export async function updateRelease(
  id: string,
  body: Partial<Omit<GrayRelease, 'id'>>,
): Promise<GrayRelease> {
  const res = await fetch(`/api/admin/releases/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await parseResponse<{ release: GrayRelease }>(res)
  return data.release
}

export async function deleteRelease(id: string): Promise<void> {
  const res = await fetch(`/api/admin/releases/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  await parseResponse<{ ok: boolean }>(res)
}
