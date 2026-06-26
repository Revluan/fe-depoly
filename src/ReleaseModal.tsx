import { useEffect, useState } from 'react'
import type { GrayRelease, GrayRule, ReleaseStatus, RuleType } from './api'
import { createRelease, deleteRelease, updateRelease } from './api'

interface Props {
  release: GrayRelease | null
  artifacts: string[]
  onClose: () => void
  onSaved: () => void
}

const STATUS_OPTIONS: ReleaseStatus[] = ['draft', 'running', 'paused', 'finished', 'rolled-back']
const RULE_TYPE_OPTIONS: RuleType[] = ['userIdList', 'percent', 'header']

const EMPTY_RULE: GrayRule = { type: 'userIdList', values: [] }

function emptyForm(): Omit<GrayRelease, 'id'> {
  return {
    name: '',
    artifactId: '',
    status: 'draft',
    rules: [],
  }
}

export function ReleaseModal({ release, artifacts, onClose, onSaved }: Props) {
  const isEdit = release !== null
  const [form, setForm] = useState<Omit<GrayRelease, 'id'>>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // 弹窗打开时,用 release 数据填充表单
  useEffect(() => {
    if (release) {
      setForm({
        name: release.name,
        artifactId: release.artifactId,
        status: release.status,
        rules: release.rules.length > 0 ? release.rules.map((r) => ({ ...r })) : [],
      })
    } else {
      setForm(emptyForm())
    }
    setError(null)
    setConfirmingDelete(false)
  }, [release])

  // Esc 键关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const updateField = <K extends keyof Omit<GrayRelease, 'id'>>(
    key: K,
    value: Omit<GrayRelease, 'id'>[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const addRule = () => {
    setForm((prev) => ({ ...prev, rules: [...prev.rules, { ...EMPTY_RULE }] }))
  }

  const removeRule = (idx: number) => {
    setForm((prev) => ({ ...prev, rules: prev.rules.filter((_, i) => i !== idx) }))
  }

  const updateRule = (idx: number, patch: Partial<GrayRule>) => {
    setForm((prev) => ({
      ...prev,
      rules: prev.rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }))
  }

  // 切换规则类型时,清空无关字段,避免脏数据
  const changeRuleType = (idx: number, type: RuleType) => {
    const base: GrayRule = { type }
    if (type === 'userIdList') base.values = []
    else if (type === 'percent') base.value = 0
    else if (type === 'header') {
      base.headerKey = ''
      base.headerValues = []
    }
    updateRule(idx, base)
  }

  const handleSave = async () => {
    setError(null)
    if (!form.name.trim()) {
      setError('名称必填')
      return
    }
    if (!form.artifactId) {
      setError('必须选择一个产物版本')
      return
    }
    setSaving(true)
    try {
      if (isEdit && release) {
        await updateRelease(release.id, form)
      } else {
        await createRelease(form)
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!release) return
    setSaving(true)
    setError(null)
    try {
      await deleteRelease(release.id)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={saving ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{isEdit ? '编辑灰度' : '新增灰度'}</h2>

        <div className="form-field">
          <label>名称</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => updateField('name', e.target.value)}
            placeholder="如:首页改版灰度"
            disabled={saving}
          />
        </div>

        <div className="form-field">
          <label>产物版本(artifactId)</label>
          <select
            value={form.artifactId}
            onChange={(e) => updateField('artifactId', e.target.value)}
            disabled={saving}
          >
            <option value="">— 请选择 —</option>
            {artifacts.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <label>状态</label>
          <select
            value={form.status}
            onChange={(e) => updateField('status', e.target.value as ReleaseStatus)}
            disabled={saving}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <label>
            规则(OR 关系,命中任一即生效)
            <button type="button" className="btn-small" onClick={addRule} disabled={saving}>
              + 添加规则
            </button>
          </label>
          {form.rules.length === 0 ? (
            <p className="hint">暂无规则,灰度不会命中任何用户</p>
          ) : (
            <div className="rule-list">
              {form.rules.map((rule, idx) => (
                <div key={idx} className="rule-row">
                  <select
                    value={rule.type}
                    onChange={(e) => changeRuleType(idx, e.target.value as RuleType)}
                    disabled={saving}
                  >
                    {RULE_TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>

                  {rule.type === 'userIdList' && (
                    <textarea
                      value={(rule.values || []).join('\n')}
                      onChange={(e) =>
                        updateRule(idx, {
                          values: e.target.value
                            .split('\n')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="每行一个 userId,如&#10;user-1&#10;user-2"
                      rows={3}
                      disabled={saving}
                    />
                  )}

                  {rule.type === 'percent' && (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={rule.value ?? 0}
                      onChange={(e) => updateRule(idx, { value: Number(e.target.value) })}
                      placeholder="0-100"
                      disabled={saving}
                    />
                  )}

                  {rule.type === 'header' && (
                    <div className="header-inputs">
                      <input
                        type="text"
                        value={rule.headerKey || ''}
                        onChange={(e) => updateRule(idx, { headerKey: e.target.value })}
                        placeholder="header 名,如 X-Region"
                        disabled={saving}
                      />
                      <input
                        type="text"
                        value={(rule.headerValues || []).join(',')}
                        onChange={(e) =>
                          updateRule(idx, {
                            headerValues: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="值,逗号分隔,如 beijing,shanghai"
                        disabled={saving}
                      />
                    </div>
                  )}

                  <button
                    type="button"
                    className="btn-danger btn-small"
                    onClick={() => removeRule(idx)}
                    disabled={saving}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          {isEdit &&
            (confirmingDelete ? (
              <button type="button" className="btn-danger" onClick={handleDelete} disabled={saving}>
                确认删除
              </button>
            ) : (
              <button
                type="button"
                className="btn-danger"
                onClick={() => setConfirmingDelete(true)}
                disabled={saving}
              >
                删除
              </button>
            ))}
          <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
