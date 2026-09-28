import { useEffect, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { removeModel, useModels } from '@renderer/core/engine/model-store'
import { Icon } from '@renderer/workbench/icons'
import { SettingsContent, SettingsGroup, SettingsRow } from '../settings/SettingsGroup'
import { ModelFormDialog } from './ModelFormDialog'

/**
 * 模型管理页
 *
 * 与输入框旁的快捷选择器共用同一份 store，因此这里的改动会立刻反映到选择器。
 * 引擎侧的一个重要语义：模型记录按 modelId 匹配，只有当请求里的 model
 * 命中某条记录时才会使用该记录的密钥与地址，所以这里的「已配置」列表
 * 就是实际可用的模型集合。
 */
export function ModelsSettingsView(): JSX.Element {
  const { ready } = useApp()
  const { models, loading, error, loaded, refresh } = useModels()
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (ready && !loaded && !loading) void refresh()
  }, [ready, loaded, loading, refresh])

  const editingModel = models.find((model) => model.id === editing)

  const guard = async (id: string, action: () => Promise<void>): Promise<void> => {
    setBusyId(id)
    setActionError(null)
    try {
      await action()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="settings-view">
      {!ready ? <div className="notice">引擎未就绪，无法读取模型配置。</div> : null}

      <div className="settings-view__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!ready}
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" size={13} />
          添加模型
        </button>
        <button type="button" className="btn" disabled={!ready || loading} onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      {error ? <div className="notice notice--error">{error}</div> : null}
      {actionError ? <div className="notice notice--error">{actionError}</div> : null}

      {loading && !loaded ? (
        <div className="settings-view__saved">加载中…</div>
      ) : models.length === 0 && ready ? (
        <div className="notice">还没有配置模型。点击「添加模型」填写服务商与 API Key 后即可开始对话。</div>
      ) : models.length > 0 ? (
        <SettingsGroup title="已配置的模型">
          {models.map((model) => (
            <SettingsRow
              key={model.id}
              label={
                <>
                  {model.displayName?.trim() || model.modelId}
                  <span className="model-row__provider">{model.provider}</span>
                </>
              }
              description={`${model.baseUrl} · key ${model.apiKey || '未设置'}`}
            >
              <button
                type="button"
                className="btn btn--sm"
                disabled={busyId === model.id}
                onClick={() => setEditing(model.id)}
              >
                编辑
              </button>
              <button
                type="button"
                className="exclude-row__remove"
                aria-label={`删除模型 ${model.modelId}`}
                title="删除该模型"
                disabled={busyId === model.id}
                onClick={() => {
                  if (!window.confirm(`确定删除模型「${model.modelId}」吗？此操作不可撤销。`)) return
                  void guard(model.id, () => removeModel(model.id))
                }}
              >
                ×
              </button>
            </SettingsRow>
          ))}
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="说明">
        <SettingsContent>
          <p className="sg__note">
            密钥由引擎使用本机 ENCRYPTION_KEY 加密后存入库中，界面只显示尾号。 若更换过
            ENCRYPTION_KEY 导致解密失败，请用「编辑」重新填写密钥。
          </p>
        </SettingsContent>
      </SettingsGroup>

      {adding ? (
        <ModelFormDialog onClose={() => setAdding(false)} />
      ) : editingModel ? (
        <ModelFormDialog model={editingModel} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  )
}
