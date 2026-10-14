/** Pure transport boundaries: reject malformed/foreign jobs, runs, pages and bindings;
 * retain legacy values and semantically equal timezone previews without rewriting them. */
import { expect, test } from '@playwright/test'
import type { CronAutomationRun, CronCapabilities, CronConfigurationV2, CronJobV2, CronNotification } from '../src/shared/automation'
import { validateAutomationAgents, validateAutomationBinding, validateAutomationCapabilities, validateAutomationJob, validateAutomationList, validateAutomationNotificationPage, validateAutomationPreview, validateAutomationRun, validateAutomationRunPage } from '../src/renderer/src/contrib/automations/automation-response'

const configuration: CronConfigurationV2 = { version: 2, schedule: { kind: 'calendar', localTime: '09:30', timeZone: 'Asia/Shanghai', daysOfWeek: [1, 3] }, target: { kind: 'standalone' }, notificationPolicy: 'all_runs', toolProfile: 'general' }
const job: CronJobV2 = { id: 'plan-a', tenantId: 'fixture', name: '计划', message: '合成目标', enabled: true, cronExpr: null, sessionId: null, createdAt: 1, updatedAt: 1, configuration, revision: 2, scheduleRevision: 1 }
const run: CronAutomationRun = { id: 'run-a', tenantId: 'fixture', jobId: job.id, jobRevision: 2, scheduleRevision: 1, scheduledAt: 1, status: 'running', sessionId: 'work-run-a', rootRunId: 'root-a', snapshot: { name: job.name, message: job.message, configuration, effectiveModelId: 'actual-model' } }
const capabilities: CronCapabilities = { version: 2, executionSupported: true, schedules: ['interval', 'calendar', 'legacy'], targets: ['session', 'standalone', 'workspace'], notificationPolicies: ['all_runs', 'silent'], overlapPolicy: 'skip', missedRunPolicy: 'skip', manualRun: false, authEnabledDispatch: false, runHistory: true, ownedCancellation: true, persistentNotifications: true }

test('v2 plan identity and nullable legacy columns are checked without rewriting data', () => {
  expect(validateAutomationJob(job, job.id)).toBe(job)
  expect(() => validateAutomationJob(job, 'another-plan')).toThrow(/协议无效/)
  expect(() => validateAutomationJob({ ...job, sessionId: 'foreign-session' })).toThrow(/计划目标/)
  expect(() => validateAutomationJob({ ...job, configuration: { ...configuration, target: { kind: 'workspace' } } })).toThrow(/计划/)
})
test('legacy null and zero timeout remain different and absent revisions stay absent', () => {
  for (const timeoutSeconds of [undefined, null, 0, 125]) {
    const old = { id: 'legacy', name: '旧计划', message: '目标', enabled: false, createdAt: 1, cronExpr: '0 9 * * 1-5', sessionId: 'original-session', thinkingMode: false, timeoutSeconds }
    expect(validateAutomationJob(old)).toBe(old)
    expect(validateAutomationJob(old)).not.toHaveProperty('revision')
    expect(validateAutomationJob(old).timeoutSeconds).toBe(timeoutSeconds)
  }
})
test('malformed job data and duplicate list identities fail visibly', () => {
  for (const value of [[], {}, null, { ...job, enabled: 'false' }, { ...job, createdAt: Number.MAX_SAFE_INTEGER }, { ...job, revision: 0 }]) expect(() => validateAutomationJob(value)).toThrow(/协议无效/)
  expect(() => validateAutomationList({ list: [job] })).toThrow(/列表/)
  expect(() => validateAutomationList([job, job])).toThrow(/列表/)
})
test('capabilities cannot fabricate supported scheduling or actions from a generic object', () => {
  expect(validateAutomationCapabilities(capabilities)).toBe(capabilities)
  for (const value of [[], {}, { ...capabilities, manualRun: true }, { ...capabilities, targets: ['server-path'] }, { ...capabilities, runHistory: undefined }]) expect(() => validateAutomationCapabilities(value)).toThrow(/能力/)
})
test('a reordered equivalent preview is accepted while another submitted rule is rejected', () => {
  const schedule = { daysOfWeek: [3, 1], timeZone: 'Asia/Shanghai', localTime: '09:30', kind: 'calendar' as const }
  const preview = { schedule, summary: '每周一、三', nextRunAt: 60000, occurrences: [60000, 120000] }
  expect(validateAutomationPreview(preview, configuration.schedule)).toBe(preview)
  expect(() => validateAutomationPreview({ ...preview, schedule: { ...schedule, localTime: '10:30' } }, configuration.schedule)).toThrow(/预览规则/)
  expect(() => validateAutomationPreview({ ...preview, nextRunAt: Number.MAX_SAFE_INTEGER }, configuration.schedule)).toThrow(/预览/)
})
test('a run and its page must belong to the requested exact identities', () => {
  expect(validateAutomationRun(run, run.id, job.id)).toBe(run)
  expect(() => validateAutomationRun(run, 'other-run')).toThrow(/运行记录/)
  expect(() => validateAutomationRunPage({ items: [run], nextCursor: null }, 'other-job')).toThrow(/运行记录/)
  expect(() => validateAutomationRun({ ...run, snapshot: { ...run.snapshot, effectiveModelId: 42 } })).toThrow(/运行配置/)
  expect(() => validateAutomationRunPage({ items: [run], nextCursor: 24 }, job.id)).toThrow(/分页/)
})
test('notification read timestamps and unread counts are real transport values', () => {
  const notification: CronNotification = { id: 'notice-a', tenantId: 'fixture', runId: run.id, eventKey: 'terminal', createdAt: 1, payload: { jobId: job.id, jobName: job.name, status: 'succeeded', sessionId: run.sessionId } }
  expect(validateAutomationNotificationPage({ items: [notification], nextCursor: null, unreadCount: 1 })).toEqual({ items: [notification], nextCursor: null, unreadCount: 1 })
  expect(() => validateAutomationNotificationPage({ items: [{ ...notification, readAt: 'now' }], nextCursor: null, unreadCount: 0 })).toThrow(/通知/)
  expect(() => validateAutomationNotificationPage({ items: [], nextCursor: null, unreadCount: -1 })).toThrow(/未读数量/)
})
test('a reuse binding cannot show a different Agent as the locked identity', () => {
  expect(validateAutomationBinding({ started: true, agentId: 'agent-a', agent: { id: 'agent-a', name: '审查 Agent' } })).toMatchObject({ agentId: 'agent-a' })
  expect(() => validateAutomationBinding({ started: true, agentId: 'agent-a', agent: { id: 'agent-b', name: '不匹配' } })).toThrow(/聊天绑定/)
  expect(() => validateAutomationBinding([])).toThrow(/聊天绑定/)
  expect(validateAutomationAgents({ list: [{ id: 'agent-a', name: '审查 Agent', model: 'model-a' }] })).toEqual([{ id: 'agent-a', name: '审查 Agent', model: 'model-a' }])
  expect(() => validateAutomationAgents({ list: [{ id: 'agent-a' }] })).toThrow(/Agent/)
})
