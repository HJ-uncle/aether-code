import type { AutomationReceipt, CronCapabilities, CronConfigurationV2, CronRunStatus, CronSchedule, CronThinkingMode } from '@shared/automation'
import type { AutomationJob } from './automation-client'

export interface AutomationDraft {
  name: string
  message: string
  description: string
  repeat: 'interval' | 'daily' | 'weekdays' | 'weekly' | 'legacy'
  everyMinutes: string
  anchorAt: number
  localTime: string
  daysOfWeek: number[]
  timeZone: string
  expression: string
  target: CronConfigurationV2['target']['kind']
  sessionId: string
  sourceSessionId: string
  agentId: string
  thinking: 'auto' | 'off' | 'on' | 'low' | 'medium' | 'high'
  timeoutPreset: string
  customTimeout: string
  timeoutChanged: boolean
  notificationPolicy: 'all_runs' | 'silent'
  toolProfile: 'general' | 'code'
  enabled: boolean
}
export const AUTOMATION_TIMEOUT_OPTIONS = [
  { value: 'unlimited', label: '不限' }, { value: '120', label: '2 分钟' },
  { value: '600', label: '10 分钟' }, { value: '1800', label: '30 分钟' },
  { value: '3600', label: '60 分钟' }, { value: '10800', label: '3 小时' },
  { value: '21600', label: '6 小时' }, { value: '86400', label: '24 小时' },
  { value: 'custom', label: '自定义时长' }
]
export const RUN_LABELS: Record<CronRunStatus, string> = {
  claimed: '准备中', running: '运行中', waiting: '等待你回复', succeeded: '已完成',
  failed: '执行失败', cancelled: '已停止', interrupted: '已中断', skipped: '已跳过'
}
export function localTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
export function automationTimeoutLabel(seconds?: number | null): string {
  if (seconds == null || seconds <= 0) return '不限'
  const preset = AUTOMATION_TIMEOUT_OPTIONS.find(option => option.value === String(seconds))
  if (preset) return preset.label
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60
  return minutes ? `${minutes} 分钟${remainder ? ` ${remainder} 秒` : ''}` : `${remainder} 秒`
}
export function createAutomationDraft(options: { job?: AutomationJob; sessionId?: string; agentId?: string; thinkingMode?: CronThinkingMode; capabilities: CronCapabilities | null; now?: number }): AutomationDraft {
  const { job, capabilities } = options
  const schedule = job?.configuration?.schedule
  const timeout = String(job?.timeoutSeconds ?? 0)
  const thinking = job ? job.thinkingMode : options.thinkingMode
  const target = job?.configuration?.target
  return {
    name: job?.name ?? '', message: job?.message ?? '', description: job?.description ?? '',
    repeat: schedule?.kind === 'interval' ? 'interval' : schedule?.kind === 'calendar'
      ? !schedule.daysOfWeek?.length || schedule.daysOfWeek.length === 7 ? 'daily'
        : schedule.daysOfWeek.length === 5 && [1, 2, 3, 4, 5].every(day => schedule.daysOfWeek!.includes(day)) ? 'weekdays' : 'weekly'
      : job || !capabilities ? 'legacy' : 'daily',
    everyMinutes: String(schedule?.kind === 'interval' ? schedule.everyMinutes : 60),
    anchorAt: schedule?.kind === 'interval' ? schedule.anchorAt : Math.floor((options.now ?? Date.now()) / 60000) * 60000,
    localTime: schedule?.kind === 'calendar' ? schedule.localTime : '09:00',
    daysOfWeek: schedule?.kind === 'calendar' ? schedule.daysOfWeek ?? [] : [1],
    timeZone: schedule && schedule.kind !== 'interval' ? schedule.timeZone : localTimeZone(),
    expression: schedule?.kind === 'legacy' ? schedule.expression : job?.cronExpr ?? '0 9 * * 1-5',
    target: target?.kind ?? (job?.sessionId ? 'session' : capabilities?.targets.includes('standalone') ? 'standalone' : 'session'),
    sessionId: target?.kind === 'session' ? target.sessionId : job?.sessionId ?? options.sessionId ?? '',
    sourceSessionId: target?.kind === 'workspace' ? target.sourceSessionId : options.sessionId ?? '',
    agentId: job ? job.agentId ?? '' : options.agentId ?? '',
    thinking: thinking === false ? 'off' : thinking === true ? 'on' : thinking ?? 'auto',
    timeoutPreset: Number(timeout) <= 0 ? 'unlimited' : AUTOMATION_TIMEOUT_OPTIONS.some(option => option.value === timeout) ? timeout : 'custom',
    customTimeout: timeout, timeoutChanged: false,
    notificationPolicy: job?.configuration?.notificationPolicy ?? 'all_runs', toolProfile: job?.configuration?.toolProfile ?? 'general',
    enabled: job?.enabled ?? (capabilities ? capabilities.executionSupported : true)
  }
}
export function scheduleFromDraft(draft: AutomationDraft): CronSchedule {
  if (draft.repeat === 'interval') {
    const minutes = Number(draft.everyMinutes)
    if (!/^\d+$/.test(draft.everyMinutes.trim()) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > Math.floor(Number.MAX_SAFE_INTEGER / 60000)) throw new Error('请输入有效的大于 0 的整数分钟数。')
    if (!Number.isSafeInteger(draft.anchorAt) || draft.anchorAt < 0 || draft.anchorAt > 8640000000000000 || draft.anchorAt % 60000 !== 0) throw new Error('起始时间必须有效并精确到分钟。')
    return { kind: 'interval', everyMinutes: minutes, anchorAt: draft.anchorAt }
  }
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: draft.timeZone }).format(0) } catch { throw new Error('请输入有效的 IANA 时区，例如 Asia/Shanghai。') }
  if (draft.repeat === 'legacy') {
    if (!draft.expression.trim()) throw new Error('请输入时间表达式。')
    return { kind: 'legacy', expression: draft.expression.trim(), timeZone: draft.timeZone }
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.localTime)) throw new Error('请选择有效的执行时间。')
  const days = draft.repeat === 'weekdays' ? [1, 2, 3, 4, 5] : draft.repeat === 'weekly' ? draft.daysOfWeek : []
  if (draft.repeat === 'weekly' && (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error('至少选择一个星期。')
  return { kind: 'calendar', localTime: draft.localTime, timeZone: draft.timeZone, ...(days.length ? { daysOfWeek: [...new Set(days)].sort() } : {}) }
}
export function draftErrors(draft: AutomationDraft, capabilities: CronCapabilities | null): Partial<Record<'name' | 'message' | 'schedule' | 'target' | 'timeout' | 'capabilities', string>> {
  const errors: ReturnType<typeof draftErrors> = {}
  if (!draft.name.trim()) errors.name = '请输入自动化名称。'
  if (!draft.message.trim()) errors.message = '请说明每次运行需要完成什么。'
  try {
    const schedule = scheduleFromDraft(draft)
    if (capabilities && !capabilities.schedules.includes(schedule.kind)) errors.schedule = '当前引擎不支持这种执行规则。'
  } catch (error) { errors.schedule = error instanceof Error ? error.message : '执行规则无效。' }
  if (draft.target === 'session' && !draft.sessionId) errors.target = '请选择要复用的聊天。'
  if (draft.target === 'workspace' && !draft.sourceSessionId) errors.target = '请选择一个已经绑定项目的聊天。'
  if (capabilities && !capabilities.targets.includes(draft.target)) errors.target = '当前引擎不支持这个运行目标。'
  const seconds = draft.timeoutPreset === 'unlimited' ? '0' : draft.timeoutPreset === 'custom' ? draft.customTimeout : draft.timeoutPreset
  if (!/^\d+$/.test(seconds.trim()) || !Number.isSafeInteger(Number(seconds))) errors.timeout = '请输入非负整数秒数，0 表示不限。'
  if (capabilities && !capabilities.executionSupported && draft.enabled) errors.capabilities = '当前引擎无法执行自动化，请先保存为已暂停。'
  if (capabilities && !capabilities.notificationPolicies.includes(draft.notificationPolicy)) errors.capabilities = '当前引擎不支持这个通知策略。'
  return errors
}
/** Names/metadata can be edited without replacing the legacy null/0 timeout. */
export function automationWriteBody(draft: AutomationDraft, capabilities: CronCapabilities | null, job?: AutomationJob): object {
  const errors = draftErrors(draft, capabilities)
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0])
  const seconds = Number(draft.timeoutPreset === 'unlimited' ? 0 : draft.timeoutPreset === 'custom' ? draft.customTimeout : draft.timeoutPreset)
  const thinkingMode = draft.thinking === 'off' ? false : draft.thinking === 'on' ? true : draft.thinking === 'auto' ? null : draft.thinking
  const common = { name: draft.name.trim(), message: draft.message.trim(), description: draft.description.trim(), thinkingMode,
    ...(!job || draft.timeoutChanged ? { timeoutSeconds: seconds > 0 ? seconds : null } : {}),
    ...(!job || draft.enabled !== job.enabled ? { enabled: draft.enabled } : {}) }
  if (!capabilities) {
    if (job?.configuration) throw new Error('当前引擎无法安全编辑新版自动化，请重新连接支持 v2 的引擎。')
    return { ...common, cronExpr: draft.expression.trim(), sessionId: job?.sessionId || draft.sessionId }
  }
  const target: CronConfigurationV2['target'] = draft.target === 'session' ? { kind: 'session', sessionId: draft.sessionId }
    : draft.target === 'workspace' ? { kind: 'workspace', sourceSessionId: draft.sourceSessionId } : { kind: 'standalone' }
  return { ...common, ...(draft.target === 'session' ? {} : draft.agentId ? { agentId: draft.agentId } : job?.agentId ? { agentId: null } : {}), configuration: {
    version: 2, schedule: scheduleFromDraft(draft), target, notificationPolicy: draft.notificationPolicy, toolProfile: draft.toolProfile
  }, ...(job?.revision !== undefined ? { expectedRevision: job.revision } : {}) }
}
export function scheduleLabel(job: Pick<AutomationJob, 'configuration' | 'cronExpr'>): string {
  const schedule = job.configuration?.schedule
  if (!schedule) return job.cronExpr || '规则不可用'
  if (schedule.kind === 'interval') return `每 ${schedule.everyMinutes} 分钟`
  if (schedule.kind === 'legacy') return `${schedule.expression} · ${schedule.timeZone}`
  const days = schedule.daysOfWeek
  const label = !days?.length || days.length === 7 ? '每天' : days.length === 5 && [1, 2, 3, 4, 5].every(day => days.includes(day)) ? '工作日'
    : days.map(day => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day]).join('、')
  return `${label} ${schedule.localTime} · ${schedule.timeZone}`
}
export function parseAutomationReceipt(value: unknown): AutomationReceipt | null {
  let parsed: unknown = value
  if (typeof value === 'string') { try { parsed = JSON.parse(value) } catch { return null } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const candidate = record.automationReceipt ?? parsed
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const receipt = candidate as Record<string, unknown>
  if (receipt.kind !== 'automation' || receipt.schemaVersion !== 2 || typeof receipt.jobId !== 'string' || !receipt.jobId.trim()
    || !['created', 'updated', 'enabled', 'disabled'].includes(String(receipt.operation))) return null
  return { kind: 'automation', schemaVersion: 2, jobId: receipt.jobId, operation: receipt.operation as AutomationReceipt['operation'] }
}
