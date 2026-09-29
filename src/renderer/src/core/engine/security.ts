/**
 * 引擎安全策略客户端
 *
 * 对接引擎的 /api/v1/security 系列接口。理解这块的关键是三个概念：
 *
 *  1. **安全模式（会话级）**：safe / standard / full-access。
 *     模式存在引擎内存里，按 tenant+sessionId 区分，**不持久化**——
 *     引擎重启或换会话就回到默认值。因此这里所有模式读写都必须带 sessionId。
 *     各模式的实际行为（见引擎 policy-engine）：
 *       - safe:        完整策略 + 注入/穿越检测，高危命令硬拒绝，未知命令弹确认
 *       - standard:    能放行的放行；deny 降级为确认、ask 升为放行，零硬报错
 *       - full-access: 跳过策略与白名单，全部放行（仍写审计日志）
 *
 *  2. **策略规则（全局）**：按 command + argPattern 匹配，priority 越小越优先。
 *     界面上的「放行 / 询问 / 拒绝」调的是规则本身，对所有会话生效。
 *
 *  3. **会话白名单**：用户在授权卡片上点「允许执行」后，引擎把该命令
 *     写入当前会话白名单，同会话同参数不再询问。这条链路不走本文件
 *     （它由 /chat 的 toolResponse 驱动），但它是"反复打断"的直接来源之一。
 *
 * standard / full-access 都会跳过工具路径边界检查，允许读写工作区外文件。
 * UI 必须分别说明命令审批与文件路径范围，不能把后者仅归于 full-access。
 */
import { request } from './client'

export type SecurityMode = 'safe' | 'standard' | 'full-access'
export type PolicyAction = 'allow' | 'ask' | 'deny'

export interface PolicyRule {
  /** 新建时省略；引擎会忽略请求体里的 id */
  id?: number
  name: string
  /** 命令名（basename，大小写不敏感）；'*' 表示匹配所有命令 */
  command: string
  /** 可选：对「参数以空格 join 后的整串」做正则匹配 */
  argPattern?: string | null
  action: PolicyAction
  /** 数字越小越优先命中 */
  priority: number
  enabled: boolean
  description?: string | null
  createdAt?: number
  updatedAt?: number
}

export interface ModeDescriptor {
  value: SecurityMode
  label: string
  summary: string
  /** 选中时需要额外警示的副作用 */
  warning?: string
}

export const SECURITY_MODES: readonly SecurityMode[] = ['safe', 'standard', 'full-access']

export const MODE_DESCRIPTORS: readonly ModeDescriptor[] = [
  {
    value: 'safe',
    label: '安全模式',
    summary: '白名单 + 完整策略检查：高危命令直接拒绝，未知命令先问你。'
  },
  {
    value: 'standard',
    label: '标准模式',
    summary: '普通命令直接执行；被拒绝规则或注入检测命中的命令仍需确认。',
    warning: '允许 Agent 读写工作区以外的文件。'
  },
  {
    value: 'full-access',
    label: '完全访问',
    summary: '跳过策略与白名单，所有命令直接执行（仍写审计日志）。',
    warning: '同时会解除工具的工作区路径限制，Agent 可读写工作区以外的文件。'
  }
]

export const ACTION_LABELS: Record<PolicyAction, string> = {
  allow: '放行',
  ask: '询问',
  deny: '拒绝'
}

/** 模式取值校验（纯函数，用于校验外部返回与界面入参） */
export function isSecurityMode(value: unknown): value is SecurityMode {
  return typeof value === 'string' && (SECURITY_MODES as readonly string[]).includes(value)
}

/**
 * 解析 GET /security/mode 的返回。
 *
 * 引擎返回的是 `{ sessionId, mode }`（不是裸字符串），但这里对两种形状都兼容，
 * 避免引擎侧改字段名时整个界面挂掉。无法识别时返回 null，由调用方兜底。
 */
export function parseSecurityMode(data: unknown): SecurityMode | null {
  if (isSecurityMode(data)) return data
  if (data && typeof data === 'object') {
    const mode = (data as Record<string, unknown>).mode
    if (isSecurityMode(mode)) return mode
  }
  return null
}

/** 构造 PUT /security/mode 的请求体；参数非法时抛错（宁可失败也不要静默设错模式） */
export function buildModePayload(
  sessionId: string,
  mode: SecurityMode
): { sessionId: string; mode: SecurityMode } {
  if (!sessionId) throw new Error('缺少会话 ID，无法切换安全模式')
  if (!isSecurityMode(mode)) throw new Error(`未知的安全模式：${String(mode)}`)
  return { sessionId, mode }
}

/** 该模式是否需要显著提示风险（用于 UI 决定是否加警示样式） */
export function isRiskyMode(mode: SecurityMode | null): boolean {
  return mode === 'standard' || mode === 'full-access'
}

// ==================== 安全模式 ====================

export async function getSecurityMode(sessionId: string): Promise<SecurityMode> {
  if (!sessionId) throw new Error('缺少会话 ID，无法读取安全模式')
  const result = await request({ method: 'GET', path: '/security/mode', query: { sessionId } })
  if (!result.ok) throw new Error(result.message || '读取安全模式失败')
  const mode = parseSecurityMode(result.data)
  if (!mode) throw new Error('引擎返回了未知的安全模式，请重新读取')
  if (result.data && typeof result.data === 'object' && 'sessionId' in result.data && result.data.sessionId !== sessionId) {
    throw new Error('安全模式响应的会话不匹配，请重新读取')
  }
  return mode
}

export async function setSecurityMode(sessionId: string, mode: SecurityMode): Promise<void> {
  const result = await request({
    method: 'PUT',
    path: '/security/mode',
    body: buildModePayload(sessionId, mode)
  })
  if (!result.ok) throw new Error(result.message || '切换安全模式失败')
}

// ==================== 策略规则 ====================

export async function listPolicies(): Promise<PolicyRule[]> {
  const result = await request<PolicyRule[]>({
    method: 'GET',
    path: '/security/policies',
    query: { current: 1, pageSize: 200 }
  })
  if (!result.ok) throw new Error(result.message || '读取策略规则失败')
  return result.data ?? []
}

/**
 * 更新规则。引擎会与库中现有记录做浅合并（PUT /security/policies/:id），
 * 因此只传要改的字段即可。
 */
export async function updatePolicy(id: number, patch: Partial<PolicyRule>): Promise<void> {
  const result = await request({ method: 'PUT', path: `/security/policies/${id}`, body: patch })
  if (!result.ok) throw new Error(result.message || '更新策略规则失败')
}

export async function deletePolicy(id: number): Promise<void> {
  const result = await request({ method: 'DELETE', path: `/security/policies/${id}` })
  if (!result.ok) throw new Error(result.message || '删除策略规则失败')
}

/** 恢复默认规则：引擎会清空后重新注入内置规则，用户的改动会丢失 */
export async function resetPolicies(): Promise<void> {
  const result = await request({ method: 'POST', path: '/security/policies/reset' })
  if (!result.ok) throw new Error(result.message || '恢复默认规则失败')
}
