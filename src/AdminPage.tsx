import { useCallback, useEffect, useState } from 'react'
import type { GrayRelease } from './api'
import { listArtifacts, listReleases } from './api'
import { ReleaseModal } from './ReleaseModal'

interface Props {
  onBack: () => void
}

export function AdminPage({ onBack }: Props) {
  const [releases, setReleases] = useState<GrayRelease[]>([])
  const [artifacts, setArtifacts] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<GrayRelease | null>(null)
  const [showModal, setShowModal] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [rs, arts] = await Promise.all([listReleases(), listArtifacts()])
      setReleases(rs)
      setArtifacts(arts)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const openNew = () => {
    setEditing(null)
    setShowModal(true)
  }

  const openEdit = (release: GrayRelease) => {
    setEditing(release)
    setShowModal(true)
  }

  const handleClose = () => {
    setShowModal(false)
    setEditing(null)
  }

  const handleSaved = () => {
    handleClose()
    refresh()
  }

  const statusBadge = (status: GrayRelease['status']) => {
    const cls = `admin-badge status-${status}`
    return <span className={cls}>{status}</span>
  }

  const ruleSummary = (release: GrayRelease) => {
    if (release.rules.length === 0) return '—'
    return release.rules
      .map((r) => {
        if (r.type === 'userIdList') return `${r.type}(${r.values?.length || 0})`
        if (r.type === 'percent') return `${r.type}(${r.value}%)`
        if (r.type === 'header') return `${r.type}(${r.headerKey})`
        return r.type
      })
      .join(' | ')
  }

  const shortId = (id: string) => (id.length > 30 ? id.slice(0, 30) + '…' : id)

  return (
    <div className="admin-page">
      <header className="admin-header">
        <h1>灰度管理</h1>
        <button onClick={onBack}>← 返回主页</button>
      </header>

      <div className="admin-toolbar">
        <button className="btn-primary" onClick={openNew}>
          + 新增灰度
        </button>
        <button onClick={refresh} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
        <span className="admin-count">
          共 {releases.length} 条 · 可用产物 {artifacts.length} 个
        </span>
      </div>

      {error && <p className="error">加载失败: {error}</p>}

      {loading && releases.length === 0 ? (
        <p className="hint">加载中...</p>
      ) : releases.length === 0 ? (
        <p className="hint">暂无灰度规则,点「新增灰度」创建第一条</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>名称</th>
              <th>产物版本</th>
              <th>状态</th>
              <th>规则</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <tr key={release.id}>
                <td className="cell-id" title={release.id}>
                  {shortId(release.id)}
                </td>
                <td>{release.name}</td>
                <td className="cell-id" title={release.artifactId}>
                  {shortId(release.artifactId)}
                </td>
                <td>{statusBadge(release.status)}</td>
                <td className="cell-rules">{ruleSummary(release)}</td>
                <td>
                  <button className="btn-small" onClick={() => openEdit(release)}>
                    编辑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showModal && (
        <ReleaseModal
          release={editing}
          artifacts={artifacts}
          onClose={handleClose}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
