import { useEffect, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { removeModel, useModels } from '@renderer/core/engine/model-store'
import { Icon } from '@renderer/workbench/icons'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Select } from '@renderer/workbench/Select'
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
  const { ready, settings, updateSettings } = useApp()
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
                  void confirmDialog({
                    title: '删除模型',
                    body: `确定删除模型「${model.modelId}」吗？此操作不可撤销。`,
                    confirmText: '删除',
                    danger: true
                  }).then((confirmed) => {
                    if (!confirmed) return
                    void guard(model.id, () => removeModel(model.id))
                  })
                }}
              >
                ×
              </button>
            </SettingsRow>
          ))}
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="按用途指派">
        <SettingsContent>
          <p className="sg__note">
            默认所有场景都用输入框旁选的主对话模型。这里可以把子代理、轻任务单独指派给
            更便宜的模型省 token——子代理跑的是范围明确的子任务；轻任务是图片理解、
            提交信息生成、输入润色这类「拿结果即走」的旁路调用，都不需要最强推理。
          </p>
        </SettingsContent>
        <SettingsRow
          label="子代理"
          description="派发的子 Agent（调研/并行任务）使用的模型"
        >
          <Select
            className="sg__select-field"
            title="子代理使用的模型"
            width={240}
            disabled={!ready || models.length === 0}
            value={settings.subagentModelId}
            onChange={(value) => void updateSettings({ subagentModelId: value })}
            options={[
              { value: '', label: '跟随主对话模型' },
              ...models.map((model) => ({
                value: model.modelId,
                label: model.displayName?.trim() || model.modelId
              }))
            ]}
          />
        </SettingsRow>
        <SettingsRow
          label="轻任务"
          description="图片理解、提交信息生成、输入润色等旁路调用使用的模型"
        >
          <Select
            className="sg__select-field"
            title="轻任务使用的模型"
            width={240}
            disabled={!ready || models.length === 0}
            value={settings.utilityModelId}
            onChange={(value) => void updateSettings({ utilityModelId: value })}
            options={[
              { value: '', label: '跟随主对话模型' },
              ...models.map((model) => ({
                value: model.modelId,
                label: model.displayName?.trim() || model.modelId
              }))
            ]}
          />
        </SettingsRow>
      </SettingsGroup>

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
