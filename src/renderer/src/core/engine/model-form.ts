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
}

function choice(value: boolean | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
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
    thinking: choice(model?.capabilityOverrides?.thinking)
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
  if (Object.keys(capabilities).length) patch.capabilityOverrides = capabilities
  return patch
}

export function newModelOverrides(form: ModelFormState): ModelCapabilities | undefined {
  const overrides: ModelCapabilities = {}
  if (form.vision !== null) overrides.vision = form.vision
  if (form.thinking !== null) overrides.thinking = form.thinking
  return Object.keys(overrides).length ? overrides : undefined
}
