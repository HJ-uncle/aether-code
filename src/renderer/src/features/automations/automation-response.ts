import type { CronAutomationRun, CronCapabilities, CronConfigurationV2, CronNotification, CronNotificationPage, CronPage, CronPreviewResponse, CronSchedule } from '@shared/automation'
import type { AutomationAgent, AutomationJob, AutomationSessionBinding } from './automation-client'

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000
const positive = (value: unknown): value is number => time(value) && value > 0
const maybeText = (value: unknown): boolean => value === undefined || typeof value === 'string'
const maybeTime = (value: unknown): boolean => value === undefined || time(value)
const thinking = (value: unknown): boolean => value == null || typeof value === 'boolean' || ['low', 'medium', 'high'].includes(String(value))
const timeout = (value: unknown): boolean => value == null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const status = (value: unknown): boolean => typeof value === 'string' && ['claimed', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(value)
function invalid(name: string): never { throw new Error(`自动化${name}协议无效，请刷新或检查引擎版本。`) }

/** Validate transport shape without rewriting saved values or reparsing legacy cron syntax. */
export function isAutomationSchedule(value: unknown): value is CronSchedule {
  if (!record(value)) return false
  if (value.kind === 'interval') return positive(value.everyMinutes) && time(value.anchorAt)
  if (value.kind === 'legacy') return typeof value.expression === 'string' && text(value.timeZone)
  return value.kind === 'calendar' && typeof value.localTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime)
    && text(value.timeZone) && (value.daysOfWeek === undefined || Array.isArray(value.daysOfWeek)
      && value.daysOfWeek.length > 0 && value.daysOfWeek.every(day => time(day) && day <= 6))
}
export function isAutomationConfiguration(value: unknown): value is CronConfigurationV2 {
  if (!record(value) || value.version !== 2 || !isAutomationSchedule(value.schedule) || !record(value.target)) return false
  const target = value.target
  return (target.kind === 'standalone' || target.kind === 'session' && text(target.sessionId) || target.kind === 'workspace' && text(target.sourceSessionId))
    && ['all_runs', 'silent'].includes(String(value.notificationPolicy)) && ['general', 'code'].includes(String(value.toolProfile))
}
export function validateAutomationCapabilities(value: unknown): CronCapabilities {
  if (!record(value) || value.version !== 2 || typeof value.executionSupported !== 'boolean'
    || !Array.isArray(value.schedules) || !value.schedules.every(item => ['interval', 'calendar', 'legacy'].includes(item))
    || !Array.isArray(value.targets) || !value.targets.every(item => ['session', 'standalone', 'workspace'].includes(item))
    || !Array.isArray(value.notificationPolicies) || !value.notificationPolicies.every(item => ['all_runs', 'silent'].includes(item))
    || value.overlapPolicy !== 'skip' || value.missedRunPolicy !== 'skip' || value.manualRun !== false || value.authEnabledDispatch !== false
    || ['runHistory', 'ownedCancellation', 'persistentNotifications'].some(key => typeof value[key] !== 'boolean')) invalid('能力')
  return value as unknown as CronCapabilities
}
export function validateAutomationJob(value: unknown, expectedId?: string): AutomationJob {
  if (!record(value) || !text(value.id) || expectedId !== undefined && value.id !== expectedId || typeof value.name !== 'string' || typeof value.message !== 'string'
    || typeof value.enabled !== 'boolean' || !time(value.createdAt) || !maybeText(value.description) || !maybeText(value.agentId)
    || !thinking(value.thinkingMode) || !timeout(value.timeoutSeconds) || !maybeTime(value.lastRunAt) || !maybeTime(value.nextRunAt)) invalid('计划')
  if (value.configuration !== undefined) {
    if (!isAutomationConfiguration(value.configuration) || !positive(value.revision) || !positive(value.scheduleRevision)
      || !time(value.updatedAt) || !text(value.tenantId)) invalid('计划')
    const { schedule, target } = value.configuration
    if (value.cronExpr !== (schedule.kind === 'legacy' ? schedule.expression : null)
      || value.sessionId !== (target.kind === 'session' ? target.sessionId : null)) invalid('计划目标')
  } else if (!text(value.cronExpr) || !text(value.sessionId)) invalid('旧版计划')
  return value as unknown as AutomationJob
}
export function validateAutomationList(value: unknown): AutomationJob[] {
  if (!Array.isArray(value)) invalid('列表')
  const jobs = value.map(item => validateAutomationJob(item))
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) invalid('列表')
  return jobs
}
export function validateAutomationPreview(value: unknown, expected: CronSchedule): CronPreviewResponse {
  if (!record(value) || !isAutomationSchedule(value.schedule) || typeof value.summary !== 'string'
    || value.nextRunAt !== null && !time(value.nextRunAt) || !Array.isArray(value.occurrences) || !value.occurrences.every(time)) invalid('预览')
  // A preview belongs to the submitted rule; a stale or unrelated response cannot become its next run.
  const received = value.schedule
  const equal = received.kind === 'interval' && expected.kind === 'interval' ? received.everyMinutes === expected.everyMinutes && received.anchorAt === expected.anchorAt
    : received.kind === 'legacy' && expected.kind === 'legacy' ? received.expression === expected.expression && received.timeZone === expected.timeZone
      : received.kind === 'calendar' && expected.kind === 'calendar' && received.localTime === expected.localTime && received.timeZone === expected.timeZone
        && [...new Set(received.daysOfWeek ?? [])].sort().join(',') === [...new Set(expected.daysOfWeek ?? [])].sort().join(',')
  if (!equal) invalid('预览规则')
  return value as unknown as CronPreviewResponse
}
export function validateAutomationRun(value: unknown, expectedId?: string, expectedJobId?: string): CronAutomationRun {
  if (!record(value) || !text(value.id) || expectedId !== undefined && value.id !== expectedId || !text(value.tenantId) || !text(value.jobId)
    || expectedJobId !== undefined && value.jobId !== expectedJobId || !positive(value.jobRevision) || !positive(value.scheduleRevision)
    || !time(value.scheduledAt) || !status(value.status) || !text(value.sessionId) || !maybeText(value.rootRunId) || !maybeText(value.reason)
    || !maybeTime(value.startedAt) || !maybeTime(value.finishedAt) || !maybeTime(value.deadlineAt)
    || value.jobDeleted !== undefined && typeof value.jobDeleted !== 'boolean') invalid('运行记录')
  const snapshot = value.snapshot
  if (!record(snapshot) || typeof snapshot.name !== 'string' || typeof snapshot.message !== 'string'
    || !isAutomationConfiguration(snapshot.configuration) || !thinking(snapshot.thinkingMode) || !timeout(snapshot.timeoutSeconds)
    || ['agentId', 'effectiveAgentId', 'effectiveAgentName', 'effectiveModelId'].some(key => !maybeText(snapshot[key]))) invalid('运行配置')
  return value as unknown as CronAutomationRun
}
function page<T>(value: unknown, validate: (item: unknown) => T): CronPage<T> {
  if (!record(value) || !Array.isArray(value.items) || value.nextCursor !== null && !text(value.nextCursor)) invalid('分页')
  return { items: value.items.map(validate), nextCursor: value.nextCursor as string | null }
}
export const validateAutomationRunPage = (value: unknown, jobId: string): CronPage<CronAutomationRun> => page(value, item => validateAutomationRun(item, undefined, jobId))
export function validateAutomationNotification(value: unknown, expectedId?: string): CronNotification {
  if (!record(value) || !text(value.id) || expectedId !== undefined && value.id !== expectedId || !text(value.tenantId) || !text(value.runId) || !text(value.eventKey)
    || !time(value.createdAt) || !maybeTime(value.readAt) || !record(value.payload) || !text(value.payload.jobId) || typeof value.payload.jobName !== 'string'
    || !status(value.payload.status) || !text(value.payload.sessionId) || !maybeText(value.payload.rootRunId) || !maybeText(value.payload.requestId)) invalid('通知')
  return value as unknown as CronNotification
}
export function validateAutomationNotificationPage(value: unknown): CronNotificationPage {
  if (!record(value) || !time(value.unreadCount)) invalid('未读数量')
  return { ...page(value, item => validateAutomationNotification(item)), unreadCount: value.unreadCount }
}
export function validateAutomationBinding(value: unknown): AutomationSessionBinding {
  if (!record(value) || typeof value.started !== 'boolean' || value.agentId !== null && !text(value.agentId)
    || value.agent !== null && (!record(value.agent) || !text(value.agent.id) || !text(value.agent.name) || value.agent.id !== value.agentId)) invalid('聊天绑定')
  return value as unknown as AutomationSessionBinding
}
export function validateAutomationAgents(value: unknown): AutomationAgent[] {
  const items = Array.isArray(value) ? value : record(value) ? value.list : undefined
  if (!Array.isArray(items) || items.some(item => !record(item) || !text(item.id) || !text(item.name) || !maybeText(item.model))) invalid('Agent 列表')
  return items as AutomationAgent[]
}
