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
import { PROVIDERS, type EngineModel } from '@renderer/core/engine/models'
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
  /** Only a model confirmed by the request controller belongs here, never models[0]. */
  defaultModelId?: string
}

function findModel(models: EngineModel[], value: string): EngineModel | undefined {
  return value ? models.find((model) => model.modelId === value || model.id === value) : undefined
}

function displayName(model: EngineModel | undefined, fallback: string): string {
  return model?.displayName?.trim() || model?.modelId || fallback
}

function providerName(model: EngineModel): string {
  return PROVIDERS.find(provider => provider.value === model.provider)?.label || model.provider.trim() || '未提供供应商'
}

const CAPABILITY_LABELS = [
  ['thinking', '思考'], ['vision', '图片'], ['video', '视频'], ['audio', '音频']
] as const

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function ModelDetails({ model }: { model: EngineModel }): JSX.Element {
  // Expose only named, non-sensitive fields. Capability absence is unknown,
  // never evidence of support, and a generic window fallback is not model data.
  const capabilities = { ...model.capabilities, ...model.resolvedCapabilities }
  const configuredWindow = positiveNumber(capabilities.contextWindow)
  const effectiveWindow = positiveNumber(model.effectiveContextWindow)
  const facts: Array<[string, string]> = []
  const tokens = (value: number): string => `${value.toLocaleString('en-US')} tokens`
  if (effectiveWindow) facts.push([configuredWindow === effectiveWindow ? '上下文' : '有效上下文', tokens(effectiveWindow)])
  if (configuredWindow && configuredWindow !== effectiveWindow) facts.push([effectiveWindow ? '模型上下文' : '上下文', tokens(configuredWindow)])
  if (model.apiFormat) facts.push(['接口格式', { auto: '自动识别', openai: 'OpenAI 兼容', anthropic: 'Anthropic' }[model.apiFormat]])
  if (model.version?.trim()) facts.push(['版本', model.version.trim()])
  return <div className="model-picker-detail">
    <div className="model-picker-detail__header">
      <strong>{displayName(model, model.modelId)}</strong>
      <span>{providerName(model)}</span>
    </div>
    {facts.length ? <dl className="model-picker-detail__facts">
      {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl> : null}
    <div className="model-picker-detail__capabilities">
      <span className="model-picker-detail__heading">能力</span>
      <dl className="model-picker-detail__facts">
        {CAPABILITY_LABELS.map(([key, label]) => <div key={key}>
          <dt>{label}</dt><dd className={capabilities[key] === true ? undefined : 'is-unavailable'}>
            {capabilities[key] === true ? '支持' : capabilities[key] === false ? '不支持' : '未声明'}
          </dd>
        </div>)}
      </dl>
    </div>
  </div>
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
  defaultModelId
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
  const defaultModel = findModel(models, defaultModelId?.trim() ?? '')
  const displayedModel = current ?? (!value ? defaultModel : undefined)
  // A confirmed default is a read-only reflection of the request controller,
  // not a synthetic menu item or a reason to change the stored selection.
  const selectedValue = current?.modelId ?? (value || defaultModel?.modelId || '')
  const label = displayedModel ? displayName(displayedModel, displayedModel.modelId) : value || '选择模型'
  const selectedDescription = displayedModel ? `${label} · ${providerName(displayedModel)}` : label

  // Multiple records can share a model ID. The engine resolves its first matching
  // record, so don't expose duplicate values whose selection cannot be distinguished.
  const uniqueModels = models.filter(
    (model, index) => models.findIndex((item) => item.modelId === model.modelId) === index
  )
  const options: SelectOption[] = uniqueModels.map((model) => ({
    value: model.modelId,
    label: displayName(model, model.modelId),
    description: providerName(model),
    detail: <ModelDetails model={model} />,
    detailLabel: `${displayName(model, model.modelId)}详情`
  }))
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
        compactTriggerLabel="模型"
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
