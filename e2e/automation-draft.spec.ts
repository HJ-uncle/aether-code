/** Pure client contracts: exact v2/legacy writes, defaults, timeout preservation,
 * source/target identity, calendar validation and structured tool receipts. */
import { expect, test } from '@playwright/test'
import type { CronCapabilities, CronConfigurationV2 } from '../src/shared/automation'
import type { AutomationJob } from '../src/renderer/src/contrib/automations/automation-client'
import { automationTimeoutLabel, automationWriteBody, createAutomationDraft, draftErrors, parseAutomationReceipt, scheduleFromDraft, scheduleLabel } from '../src/renderer/src/contrib/automations/automation-draft'

const capabilities: CronCapabilities = { version: 2, executionSupported: true, schedules: ['interval', 'calendar', 'legacy'], targets: ['session', 'standalone', 'workspace'], notificationPolicies: ['all_runs', 'silent'], overlapPolicy: 'skip', missedRunPolicy: 'skip', manualRun: false, authEnabledDispatch: false, runHistory: true, ownedCancellation: true, persistentNotifications: true }
const configuration: CronConfigurationV2 = { version: 2, schedule: { kind: 'calendar', localTime: '09:00', timeZone: 'Asia/Shanghai' }, target: { kind: 'session', sessionId: 'source-session' }, notificationPolicy: 'all_runs', toolProfile: 'general' }
const job = (timeoutSeconds?: number | null): AutomationJob => ({ id: 'job-1', name: '计划', message: '完成合成工作', enabled: true, createdAt: 1, sessionId: 'source-session', cronExpr: '0 9 * * 1-5', thinkingMode: false, timeoutSeconds, configuration, revision: 7, scheduleRevision: 3 })
const valid = () => ({ ...createAutomationDraft({ capabilities, now: 120000 }), name: '合成任务', message: '完成合成任务' })

test('new standalone creation works without a project/session and never fabricates legacy fields', () => {
  const draft = valid()
  expect(draft.target).toBe('standalone')
  expect(draftErrors(draft, capabilities)).toEqual({})
  const body = automationWriteBody(draft, capabilities)
  expect(body).toMatchObject({ configuration: { version: 2, target: { kind: 'standalone' } }, enabled: true })
  expect(body).not.toHaveProperty('sessionId'); expect(body).not.toHaveProperty('cronExpr')
  expect(body).not.toHaveProperty('agentId')
})

test('editing an existing default Agent does not inherit the current task Agent', () => {
  const saved = { ...job(), sessionId: null, configuration: { ...configuration, target: { kind: 'standalone' as const } } }
  const draft = createAutomationDraft({ job: saved, capabilities, agentId: 'different-selected-agent' })
  expect(draft.agentId).toBe('')
  expect(automationWriteBody(draft, capabilities, saved)).not.toHaveProperty('agentId')
})

test('switching a configured standalone Agent to engine default clears it explicitly', () => {
  const saved = { ...job(), agentId: 'saved-agent', sessionId: null, configuration: { ...configuration, target: { kind: 'standalone' as const } } }
  const draft = createAutomationDraft({ job: saved, capabilities }); draft.agentId = ''
  expect(automationWriteBody(draft, capabilities, saved)).toHaveProperty('agentId', null)
})
test('workspace new saves only sourceSessionId, never a client directory path', () => {
  const draft = { ...valid(), target: 'workspace' as const, sourceSessionId: 'bound-session' }
  expect(automationWriteBody(draft, capabilities)).toMatchObject({ configuration: { target: { kind: 'workspace', sourceSessionId: 'bound-session' } } })
  expect(JSON.stringify(automationWriteBody(draft, capabilities))).not.toContain('workspacePath')
})
test('reusing an old task does not accidentally follow the current selected session or switch Agent', () => {
  const saved = job(), draft = createAutomationDraft({ job: saved, capabilities, sessionId: 'different-session', agentId: 'different-agent' })
  expect(draft.sessionId).toBe('source-session')
  const body = automationWriteBody(draft, capabilities, saved)
  expect(body).toMatchObject({ expectedRevision: 7, thinkingMode: false, configuration: { target: { kind: 'session', sessionId: 'source-session' } } })
  expect(body).not.toHaveProperty('agentId'); expect(body).not.toHaveProperty('enabled')
})
for (const timeout of [undefined, null, 0, 125]) test(`unrelated edits preserve timeout ${String(timeout)}`, () => {
  const saved = job(timeout), draft = createAutomationDraft({ job: saved, capabilities })
  draft.name = '新的名称'
  const body = automationWriteBody(draft, capabilities, saved)
  expect(body).not.toHaveProperty('timeoutSeconds')
  expect(saved.timeoutSeconds).toBe(timeout)
})
test('legacy edits preserve explicit false, original session, raw rule and absent timeout', () => {
  const saved = { ...job(), configuration: undefined, revision: undefined }
  const draft = createAutomationDraft({ job: saved, capabilities: null, sessionId: 'different' })
  expect(automationWriteBody(draft, null, saved)).toMatchObject({ cronExpr: '0 9 * * 1-5', sessionId: 'source-session', thinkingMode: false })
  expect(automationWriteBody(draft, null, saved)).not.toHaveProperty('configuration')
  expect(automationWriteBody(draft, null, saved)).not.toHaveProperty('timeoutSeconds')
})
test('v2 task cannot be silently downgraded by an old engine', () => {
  expect(() => automationWriteBody(createAutomationDraft({ job: job(), capabilities: null }), null, job())).toThrow(/安全编辑新版/)
})
test('custom timeout sends exact seconds only after editing the control', () => {
  const saved = job(), draft = createAutomationDraft({ job: saved, capabilities })
  Object.assign(draft, { timeoutPreset: 'custom', customTimeout: '125', timeoutChanged: true })
  expect(automationWriteBody(draft, capabilities, saved)).toMatchObject({ timeoutSeconds: 125 })
  expect(automationTimeoutLabel(125)).toBe('2 分钟 5 秒')
})
for (const input of ['-1', '1.5', '', 'Infinity', '9007199254740992']) test(`invalid timeout ${JSON.stringify(input)} cannot be committed`, () => {
  const draft = { ...valid(), timeoutPreset: 'custom', customTimeout: input, timeoutChanged: true }
  expect(draftErrors(draft, capabilities).timeout).toMatch(/非负整数/)
  expect(() => automationWriteBody(draft, capabilities)).toThrow(/非负整数/)
})
test('calendar round trip retains multiple weekdays, local time and IANA timezone', () => {
  const saved = { ...job(), configuration: { ...configuration, schedule: { kind: 'calendar' as const, localTime: '18:35', timeZone: 'America/New_York', daysOfWeek: [0, 2, 6] } } }
  const draft = createAutomationDraft({ job: saved, capabilities })
  expect(scheduleFromDraft(draft)).toEqual(saved.configuration.schedule)
  expect(scheduleLabel(saved)).toBe('周日、周二、周六 18:35 · America/New_York')
})
test('calendar requires at least one valid weekday and an actual timezone', () => {
  expect(() => scheduleFromDraft({ ...valid(), repeat: 'weekly', daysOfWeek: [] })).toThrow(/至少选择/)
  expect(() => scheduleFromDraft({ ...valid(), timeZone: 'Not/AZone' })).toThrow(/有效的 IANA/)
  expect(() => scheduleFromDraft({ ...valid(), localTime: '24:00' })).toThrow(/有效的执行时间/)
})
test('interval preserves exact anchor and integer minutes', () => {
  expect(scheduleFromDraft({ ...valid(), repeat: 'interval', everyMinutes: '90', anchorAt: 120000 })).toEqual({ kind: 'interval', everyMinutes: 90, anchorAt: 120000 })
  expect(() => scheduleFromDraft({ ...valid(), repeat: 'interval', everyMinutes: '0' })).toThrow(/大于 0/)
  expect(() => scheduleFromDraft({ ...valid(), repeat: 'interval', everyMinutes: '1.5' })).toThrow(/整数/)
  expect(() => scheduleFromDraft({ ...valid(), repeat: 'interval', anchorAt: 1 })).toThrow(/精确到分钟/)
})
test('unsupported authentication can save a paused draft but cannot pretend to execute', () => {
  const caps = { ...capabilities, executionSupported: false, reason: 'authenticated_dispatch_not_supported' as const }
  const draft = { ...createAutomationDraft({ capabilities: caps }), name: '已暂停计划', message: '合成任务' }
  expect(draft.enabled).toBe(false)
  expect(draftErrors(draft, caps)).toEqual({})
  expect(draftErrors({ ...draft, enabled: true }, caps).capabilities).toMatch(/已暂停/)
})
test('missing targets, unsupported schedules and policies are not fake editable options', () => {
  const caps = { ...capabilities, targets: ['session' as const], schedules: ['legacy' as const], notificationPolicies: ['all_runs' as const] }
  const errors = draftErrors({ ...valid(), notificationPolicy: 'silent' }, caps)
  expect(errors.target).toMatch(/不支持/); expect(errors.schedule).toMatch(/不支持/); expect(errors.capabilities).toMatch(/不支持/)
})
test('card requires exact versioned successful-operation receipt, not arbitrary job-shaped JSON', () => {
  const receipt = { kind: 'automation' as const, schemaVersion: 2 as const, jobId: 'job-1', operation: 'created' as const }
  expect(parseAutomationReceipt(JSON.stringify({ automationReceipt: receipt, summary: '已保存' }))).toEqual(receipt)
  for (const value of [job(), { id: 'job-1', name: '自动化' }, { ...receipt, schemaVersion: 1 }, { ...receipt, operation: 'deleted' }, { ...receipt, jobId: '' }, 'not-json']) expect(parseAutomationReceipt(value)).toBeNull()
})
