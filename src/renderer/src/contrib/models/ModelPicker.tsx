import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX
} from 'react'
import { useModels } from '@renderer/core/engine/model-store'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import type { EngineModel } from '@renderer/core/engine/models'
import { Select, type SelectAction, type SelectOption } from '@renderer/workbench/Select'
import { ModelFormDialog } from './ModelFormDialog'
import './model-picker.css'

export interface ModelPickerProps {
  /** Empty selects the mode controller's default; old stored record IDs remain readable. */
  value: string
  disabled?: boolean
  onChange: (modelId: string) => void
  onManage: () => void
  ariaLabel?: string
  /** Keep-alive views close their menu and dialog immediately when the mode changes. */
  active?: boolean
  /** Session/task ownership must also close dialogs and reject late selection callbacks. */
  scopeKey?: string
  includeDefault?: boolean
  /** Only a model confirmed by the request controller belongs here, never models[0]. */
  defaultModelId?: string
  defaultModelSource?: string
}

function findModel(models: EngineModel[], value: string): EngineModel | undefined {
  return value ? models.find((model) => model.modelId === value || model.id === value) : undefined
}

function displayName(model: EngineModel | undefined, fallback: string): string {
  return model?.displayName?.trim() || model?.modelId || fallback
}

/** Both modes use the same quiet Select, with management actions inside its menu. */
export function ModelPicker({
  value,
  disabled = false,
  onChange,
  onManage,
  ariaLabel = '选择模型',
  active = true,
  scopeKey = '',
  includeDefault = true,
  defaultModelId,
  defaultModelSource
}: ModelPickerProps): JSX.Element {
  const { models, loading, error, loaded, refresh } = useModels()
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const [adding, setAdding] = useState(false)
  const scope = `${source}:${active}:${scopeKey}`
  const [scopeGeneration, setScopeGeneration] = useState(0)
  const liveScope = useRef(scopeGeneration)
  useLayoutEffect(() => {
    liveScope.current = scopeGeneration
    return () => {
      liveScope.current = -1
    }
  }, [scopeGeneration])
  const [previousScope, setPreviousScope] = useState(scope)
  if (scope !== previousScope) {
    setPreviousScope(scope)
    setScopeGeneration(scopeGeneration + 1)
    setAdding(false)
  }

  const current = findModel(models, value)
  const defaultModel = findModel(models, defaultModelId ?? '')
  const confirmedDefault = defaultModelId?.trim() || ''
  const defaultName = confirmedDefault
    ? displayName(defaultModel, confirmedDefault)
    : '跟随引擎配置'
  const defaultSource =
    defaultModelSource?.trim() || (confirmedDefault ? '默认配置' : '发送时由引擎解析')
  const defaultLabel = confirmedDefault ? `${defaultName} · ${defaultSource}` : defaultName
  const selectedValue = current?.modelId ?? value
  const label = value ? displayName(current, value) : defaultLabel
  const selectedDescription = value
    ? `当前模型：${current?.modelId ?? value}`
    : `${defaultName} · ${defaultSource}`

  // Multiple records can share a model ID. The engine resolves its first matching
  // record, so don't expose duplicate values whose selection cannot be distinguished.
  const uniqueModels = models.filter(
    (model, index) => models.findIndex((item) => item.modelId === model.modelId) === index
  )
  const options: SelectOption[] = [
    ...(includeDefault
      ? [{ value: '', label: `默认 · ${defaultName}`, description: defaultSource }]
      : []),
    ...uniqueModels.map((model) => ({
      value: model.modelId,
      label: displayName(model, model.modelId),
      description: `${model.provider} · ${model.modelId}`
    }))
  ]
  // An old conversation may reference a removed model or a request-only endpoint.
  // Preserve the selection visibly instead of silently switching its next request.
  if (value && !current)
    options.unshift({ value, label: value, description: '当前会话模型 · 尚未在模型列表中配置' })

  const handleOpen = useCallback(
    (open: boolean): void => {
      if (open && !loaded && !loading) void refresh()
    },
    [loaded, loading, refresh]
  )
  const actions: SelectAction[] = [
    ...(error
      ? [
          {
            id: 'reload',
            label: '重新加载模型',
            icon: 'restart' as const,
            onSelect: () => {
              void refresh()
            }
          }
        ]
      : []),
    { id: 'add', label: '添加模型', icon: 'plus', onSelect: () => setAdding(true) },
    { id: 'manage', label: '管理模型', icon: 'settings', onSelect: onManage }
  ]
  const hint =
    loading && !loaded
      ? '正在加载模型…'
      : error
        ? `模型列表加载失败：${error}`
        : !models.length
          ? '还没有配置模型，可在下方添加或管理。'
          : undefined

  return (
    <>
      <Select
        key={scope}
        className="model-picker"
        panelClassName="model-select-menu"
        value={selectedValue}
        options={options}
        triggerLabel={label}
        title={selectedDescription}
        ariaLabel={ariaLabel}
        placement="up"
        align="end"
        width={280}
        disabled={disabled || !active}
        onChange={onChange}
        onOpenChange={handleOpen}
        actions={actions}
        hint={hint}
      />
      {adding && active ? (
        <ModelFormDialog
          onClose={() => setAdding(false)}
          onSaved={(model) => {
            if (active && liveScope.current === scopeGeneration && source === getEngineSource())
              onChange(model.modelId)
          }}
        />
      ) : null}
    </>
  )
}
