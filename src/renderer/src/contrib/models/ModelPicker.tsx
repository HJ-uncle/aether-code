import { useEffect, useState, type JSX } from 'react'
import { useModels } from '@renderer/core/engine/model-store'
import type { EngineModel } from '@renderer/core/engine/models'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'
import { ModelFormDialog } from './ModelFormDialog'

interface ModelPickerProps {
  /** 当前选中的 modelId；空串表示使用引擎默认 */
  value: string
  disabled?: boolean
  onChange: (modelId: string) => void
  /** 打开完整管理页 */
  onManage: () => void
}

/**
 * 输入框旁的模型快捷入口
 *
 * 点开列出已配置模型，可直接切换；底部提供「添加模型」，避免为了加一个模型
 * 必须先跳转到设置页。列表为空时会把「添加模型」作为主行动突出显示。
 */
export function ModelPicker({ value, disabled = false, onChange, onManage }: ModelPickerProps): JSX.Element {
  const { models, loading, error, loaded, refresh } = useModels()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)

  // 首次打开时拉取；引擎重启后 loaded 会被重置
  useEffect(() => {
    if (open && !loaded && !loading) void refresh()
  }, [open, loaded, loading, refresh])

  const current = models.find((model) => model.modelId === value)
  const label = current ? displayNameOf(current) : value || '默认模型'

  return (
    <>
      <Popover
        className="model-picker"
        label="选择模型"
        open={open}
        onOpenChange={setOpen}
        disabled={disabled}
        placement="up"
        align="start"
        width={300}
        flush
        trigger={({ open: isOpen }) => (
          <button
            type="button"
            disabled={disabled}
            className={`model-picker__trigger${isOpen ? ' is-open' : ''}`}
            title={value ? `当前模型：${value}` : '未指定模型，将使用引擎默认配置'}
          >
            <span className="picker__label">{label}</span>
            <span className="model-picker__caret">⌃</span>
          </button>
        )}
      >
        <div className="model-picker__popup" role="menu">
          <div className="model-picker__list">
            {loading && !loaded ? (
              <div className="model-picker__hint">加载中…</div>
            ) : error ? (
              <div className="model-picker__hint model-picker__hint--error">{error}</div>
            ) : models.length === 0 ? (
              <div className="model-picker__hint">
                还没有配置任何模型。
                <br />
                添加一个即可开始对话。
              </div>
            ) : (
              <>
                <div className="model-picker__section">已配置模型</div>
                {models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitem"
                    className={`model-picker__item${model.modelId === value ? ' is-active' : ''}`}
                    onClick={() => {
                      onChange(model.modelId)
                      setOpen(false)
                    }}
                  >
                    <span className="model-picker__item-main">
                      <span className="model-picker__avatar">{initialOf(model)}</span>
                      <span className="model-picker__name">{displayNameOf(model)}</span>
                      {capabilityTags(model).map((tag) => (
                        <span key={tag.key} className="model-picker__tag" title={tag.hint}>
                          {tag.label}
                        </span>
                      ))}
                    </span>
                    <span className="model-picker__provider">{model.provider}</span>
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="model-picker__footer">
            <button
              type="button"
              className="model-picker__action"
              onClick={() => {
                setAdding(true)
                setOpen(false)
              }}
            >
              <Icon name="plus" size={16} />
              添加模型
            </button>
            <button
              type="button"
              className="model-picker__action model-picker__action--muted"
              onClick={() => {
                setOpen(false)
                onManage()
              }}
            >
              管理模型
            </button>
          </div>
        </div>
      </Popover>

      {adding ? (
        <ModelFormDialog
          onClose={() => setAdding(false)}
          onSaved={(created) => onChange(created.modelId)}
        />
      ) : null}
    </>
  )
}

function displayNameOf(model: EngineModel): string {
  return model.displayName?.trim() || model.modelId
}

function initialOf(model: EngineModel): string {
  return displayNameOf(model).slice(0, 1).toUpperCase()
}

/** 列表上的能力标签：多模态（图片/音频/视频）与思考，让模型差异一眼可辨 */
function capabilityTags(model: EngineModel): Array<{ key: string; label: string; hint: string }> {
  const caps = model.resolvedCapabilities ?? model.capabilities
  if (!caps) return []
  const tags: Array<{ key: string; label: string; hint: string }> = []
  if (caps.vision || caps.audio || caps.video) {
    const kinds = [
      caps.vision ? '图片' : null,
      caps.audio ? '音频' : null,
      caps.video ? '视频' : null
    ].filter(Boolean)
    tags.push({ key: 'multimodal', label: '多模态', hint: `支持${kinds.join('、')}输入` })
  }
  if (caps.thinking) tags.push({ key: 'thinking', label: '思考', hint: '支持思考模式' })
  return tags
}
