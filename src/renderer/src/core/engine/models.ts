/**
 * 引擎模型管理客户端
 *
 * 对接引擎的 /api/v1/models 系列接口。要点：
 *
 *  - 列表接口返回的 apiKey 是脱敏串（形如 `...abcd`）。更新时必须原样回传或
 *    干脆不传，引擎会识别 `...` 前缀并忽略该字段，避免把脱敏串写成真 key。
 *  - 新建的模型 isEnabled 默认为 false（引擎侧硬编码）。而 chat 侧是按
 *    modelId 匹配、并不校验 isEnabled，所以开关只影响语义清晰度。
 *  - baseUrl 有公网校验：私网/回环地址会被拒（引擎侧 isPrivateIP）。
 *    本地模型请走引擎的 OLLAMA_BASE_URL 等配置，不能在此添加。
 */
import { request } from './client'
import { assertEngineSource, getEngineSource, getExpectedEngine } from './source'

/**
 * Newly initialized models start with a predictable 200K context budget.
 * Provider-reported capabilities still take precedence once a model has been
 * saved and the engine has resolved its actual window.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000
export const DEFAULT_CONTEXT_WINDOW_K = '200'

export interface ModelCapabilities {
  vision?: boolean
  video?: boolean
  audio?: boolean
  thinking?: boolean
  toolCalling?: boolean
  parallelTools?: boolean
  jsonMode?: boolean
  search?: boolean
  caching?: boolean
  streamUsage?: boolean
  prefix?: boolean
  /** 上下文窗口上限（token 数），用量环分母；与输出上限 maxTokens 区分 */
  contextWindow?: number
}

export type CapabilityOverridePatch = {
  [Key in keyof ModelCapabilities]?: ModelCapabilities[Key] | null
}
export type UpdateModelInput = Partial<
  Pick<EngineModel, 'isEnabled' | 'displayName' | 'baseUrl'>
> & {
  apiKey?: string
  capabilityOverrides?: CapabilityOverridePatch | null
}

export interface EngineModel {
  id: string
  tenantId: string
  provider: string
  modelId: string
  /** 脱敏后的 key，形如 `...abcd` */
  apiKey: string
  baseUrl: string
  displayName?: string
  isEnabled: boolean
  version?: string
  /** Effective read alias used by chat consumers. */
  capabilities?: ModelCapabilities | null
  resolvedCapabilities?: ModelCapabilities
  capabilityOverrides?: ModelCapabilities | null
  createdAt: number
  updatedAt: number
}

export interface CapabilityDef {
  key: keyof ModelCapabilities
  label: string
  description: string
  icon: string
  group: 'multimodal' | 'reasoning' | 'protocol' | 'optimization'
}

export interface CreateModelInput {
  provider: string
  modelId: string
  apiKey: string
  baseUrl: string
  displayName?: string
  capabilityOverrides?: ModelCapabilities
}

export interface TestResult {
  success: boolean
  latency?: number
  thinkingSupported?: boolean
  error?: string
}

/** 常用 Provider。deepseek / qwen 在引擎侧会走专有通道（自动识别）。 */
export const PROVIDERS: Array<{ value: string; label: string; hint: string; baseUrl: string }> = [
  {
    value: 'deepseek',
    label: 'DeepSeek',
    hint: '推理与工具调用均衡，国内直连；接口地址以 /anthropic 结尾时自动按 Anthropic 协议请求',
    baseUrl: 'https://api.deepseek.com'
  },
  {
    value: 'openai',
    label: 'OpenAI 兼容',
    hint: '适用于绝大多数 OpenAI 兼容网关',
    baseUrl: 'https://api.openai.com/v1'
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude 系列',
    baseUrl: 'https://api.anthropic.com'
  },
  {
    value: 'qwen',
    label: '通义千问',
    hint: 'DashScope，支持联网搜索',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  },
  {
    value: 'custom',
    label: '自定义',
    hint: '自建网关或其它兼容服务',
    baseUrl: ''
  }
]

export async function listModels(): Promise<EngineModel[]> {
  const result = await request<EngineModel[]>({ method: 'GET', path: '/models' })
  if (!result.ok) throw new Error(result.message || '获取模型列表失败')
  return result.data ?? []
}

export async function createModel(input: CreateModelInput): Promise<EngineModel> {
  const source = getEngineSource()
  const expectedEngine = getExpectedEngine()
  const result = await request<EngineModel>({ method: 'POST', path: '/models', body: input, expectedEngine })
  if (!result.ok) throw new Error(result.message || '添加模型失败')

  const created = result.data as EngineModel

  // 引擎在创建时硬编码 is_enabled = false，但该字段目前只存不用
  // （chat 仅按 modelId 匹配，从不检查它）。若不纠正，库里会留一条
  // 显示为"未启用"、实际却能正常使用的记录，属于误导性数据。
  if (created && !created.isEnabled) {
    assertEngineSource(source)
    await request({ method: 'PUT', path: `/models/${created.id}`, body: { isEnabled: true }, expectedEngine })
    return { ...created, isEnabled: true }
  }

  return created
}

export async function updateModel(id: string, patch: UpdateModelInput): Promise<EngineModel> {
  const result = await request<EngineModel>({ method: 'PUT', path: `/models/${id}`, body: patch })
  if (!result.ok || !result.data) throw new Error(result.message || '更新模型失败')
  return result.data
}

export async function deleteModel(id: string): Promise<void> {
  const result = await request({ method: 'DELETE', path: `/models/${id}` })
  if (!result.ok) throw new Error(result.message || '删除模型失败')
}

// 说明：引擎的 PUT /models/:id 还接受 isEnabled，但该字段在引擎侧
// 不参与任何判定（见 chat 路由只按 modelId 匹配）。为避免提供无效控件，
// 界面不暴露该开关，也没有对应的 setModelEnabled 导出。

/**
 * 测试连通性。
 * 支持在保存前测试：此时传 id='new' 并把凭据放在 body 里。
 */
export async function testModel(
  id: string,
  temp?: { provider?: string; modelId?: string; apiKey?: string; baseUrl?: string }
): Promise<TestResult> {
  const result = await request<TestResult>({
    method: 'POST',
    path: `/models/${id}/test`,
    body: temp ?? {}
  })
  // 该接口固定返回 code 200，成功与否在 data.success 里
  if (!result.ok) return { success: false, error: result.message }
  return (result.data as TestResult) ?? { success: false, error: '无返回内容' }
}

/** 依据内置规则推断模型能力（用于表单预填/预览） */
export async function detectCapabilities(input: {
  provider?: string
  modelId: string
  baseUrl?: string
}): Promise<ModelCapabilities> {
  const result = await request<ModelCapabilities>({
    method: 'POST',
    path: '/models/detect-capabilities',
    body: input
  })
  if (!result.ok) throw new Error(result.message || '能力检测失败')
  return result.data ?? {}
}

export async function fetchCapabilityDefs(): Promise<CapabilityDef[]> {
  const result = await request<CapabilityDef[]>({ method: 'GET', path: '/models/capability-defs' })
  if (!result.ok) return []
  return result.data ?? []
}
