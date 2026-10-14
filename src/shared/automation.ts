/** Shared Cron v2 HTTP contract. Capabilities report the engine's actual support. */
export type CronThinkingMode = boolean | 'low' | 'medium' | 'high' | null
export type CronSchedule =
  | { kind: 'interval'; everyMinutes: number; anchorAt: number }
  | { kind: 'calendar'; localTime: string; daysOfWeek?: number[]; timeZone: string }
  | { kind: 'legacy'; expression: string; timeZone: string }
export interface CronConfigurationV2 {
  version: 2
  schedule: CronSchedule
  target:
    | { kind: 'session'; sessionId: string }
    | { kind: 'standalone' }
    | { kind: 'workspace'; sourceSessionId: string }
  notificationPolicy: 'all_runs' | 'silent'
  toolProfile: 'general' | 'code'
}
export interface CronJobV2 {
  id: string
  tenantId: string
  name: string
  description?: string
  message: string
  agentId?: string
  thinkingMode?: CronThinkingMode
  timeoutSeconds?: number | null
  enabled: boolean
  cronExpr: string | null
  sessionId: string | null
  configuration: CronConfigurationV2
  revision: number
  scheduleRevision: number
  lastRunAt?: number
  nextRunAt?: number
  createdAt: number
  updatedAt: number
}
export interface CreateCronJobV2 {
  name: string
  description?: string
  message: string
  agentId?: string | null
  thinkingMode?: CronThinkingMode
  timeoutSeconds?: number | null
  enabled?: boolean
  configuration: CronConfigurationV2
}
export type UpdateCronJobV2 = Partial<CreateCronJobV2> & { expectedRevision?: number }
export interface CronCapabilities {
  version: 2
  executionSupported: boolean
  reason?: 'authenticated_dispatch_not_supported'
  schedules: Array<'interval' | 'calendar' | 'legacy'>
  targets: Array<'session' | 'standalone' | 'workspace'>
  notificationPolicies: Array<'all_runs' | 'silent'>
  overlapPolicy: 'skip'
  missedRunPolicy: 'skip'
  manualRun: false
  authEnabledDispatch: false
  runHistory: boolean
  ownedCancellation: boolean
  persistentNotifications: boolean
}
export interface CronPreviewRequest { schedule: CronSchedule; after?: number; count?: number }
export interface CronPreviewResponse { schedule: CronSchedule; summary: string; nextRunAt: number | null; occurrences: number[] }
export type CronRunStatus = 'claimed' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'skipped'
export interface CronRunSnapshot {
  name: string
  message: string
  configuration: CronConfigurationV2
  agentId?: string
  thinkingMode?: CronThinkingMode
  timeoutSeconds?: number | null
  /** Resolved by root admission/reconciliation, never accepted in client configuration. */
  effectiveAgentId?: string
  effectiveAgentName?: string
  effectiveModelId?: string
}
export interface CronAutomationRun {
  id: string
  tenantId: string
  jobId: string
  jobRevision: number
  scheduleRevision: number
  scheduledAt: number
  status: CronRunStatus
  reason?: string
  sessionId: string
  rootRunId?: string
  snapshot: CronRunSnapshot
  startedAt?: number
  finishedAt?: number
  deadlineAt?: number
  jobDeleted?: boolean
}
export interface CronNotificationPayload {
  jobId: string
  jobName: string
  status: CronRunStatus
  sessionId: string
  rootRunId?: string
  requestId?: string
}
export interface CronNotification {
  id: string
  tenantId: string
  runId: string
  eventKey: string
  payload: CronNotificationPayload
  createdAt: number
  readAt?: number
}
export interface CronPage<T> { items: T[]; nextCursor: string | null }
export type CronNotificationPage = CronPage<CronNotification> & { unreadCount: number }

/** Structured tool receipt; arbitrary output must not masquerade as an automation card. */
export interface AutomationReceipt {
  kind: 'automation'
  schemaVersion: 2
  jobId: string
  operation: 'created' | 'updated' | 'enabled' | 'disabled'
}
