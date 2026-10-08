import type {
  EngineModel,
  ModelCapabilities,
  CapabilityOverridePatch,
  UpdateModelInput
} from './models'

export interface ModelFormState {
  provider: string
  displayName: string
  modelId: string
  baseUrl: string
  apiKey: string
  vision: boolean | null
  thinking: boolean | null
  /** 上下文窗口（token 数）文本框原样内容，空串表示不覆盖 */
  contextWindow: string
}

function choice(value: boolean | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** 文本框 → token 数（表单以 K 为单位，1K = 1000 token）；空串返回 null（不覆盖） */
function parseContextWindow(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!/^\d+$/.test(trimmed)) throw new Error('上下文窗口必须是正整数（单位 K）')
  const value = Number(trimmed)
  if (value <= 0) throw new Error('上下文窗口必须是正整数（单位 K）')
  return value * 1000
}

/** Form choices describe manual overrides, never inferred/resolved defaults. */
export function initialModelForm(model?: EngineModel): ModelFormState {
  return {
    provider: model?.provider ?? 'deepseek',
    displayName: model?.displayName ?? '',
    modelId: model?.modelId ?? '',
    baseUrl: model?.baseUrl ?? 'https://api.deepseek.com',
    apiKey: '',
    vision: choice(model?.capabilityOverrides?.vision),
    thinking: choice(model?.capabilityOverrides?.thinking),
    contextWindow: model?.capabilityOverrides?.contextWindow
      ? String(model.capabilityOverrides.contextWindow / 1000)
      : ''
  }
}

export function buildModelUpdate(model: EngineModel, form: ModelFormState): UpdateModelInput {
  const patch: UpdateModelInput = {}
  if (form.displayName.trim() !== (model.displayName ?? ''))
    patch.displayName = form.displayName.trim()
  if (form.baseUrl.trim() !== model.baseUrl) patch.baseUrl = form.baseUrl.trim()
  if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim()
  const capabilities: CapabilityOverridePatch = {}
  for (const key of ['vision', 'thinking'] as const) {
    if (form[key] !== choice(model.capabilityOverrides?.[key])) capabilities[key] = form[key]
  }
  const contextWindow = parseContextWindow(form.contextWindow)
  if (contextWindow !== (model.capabilityOverrides?.contextWindow ?? null)) {
    capabilities.contextWindow = contextWindow
  }
  if (Object.keys(capabilities).length) patch.capabilityOverrides = capabilities
  return patch
}

export function newModelOverrides(form: ModelFormState): ModelCapabilities | undefined {
  const overrides: ModelCapabilities = {}
  if (form.vision !== null) overrides.vision = form.vision
  if (form.thinking !== null) overrides.thinking = form.thinking
  const contextWindow = parseContextWindow(form.contextWindow)
  if (contextWindow !== null) overrides.contextWindow = contextWindow
  return Object.keys(overrides).length ? overrides : undefined
}
