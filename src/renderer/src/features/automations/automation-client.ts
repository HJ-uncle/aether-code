import type { CronCapabilities, CronConfigurationV2, CronJobV2, CronPreviewRequest } from '@shared/automation'
import type { EngineRequestInput } from '@shared/ipc'
import { request, requestOrThrow } from '@renderer/core/engine/client'
import { assertEngineSource, getEngineSource } from '@renderer/core/engine/source'
import { validateAutomationAgents, validateAutomationBinding, validateAutomationCapabilities, validateAutomationJob, validateAutomationList,
  validateAutomationNotification, validateAutomationNotificationPage, validateAutomationPreview, validateAutomationRun, validateAutomationRunPage } from './automation-response'

/** Old jobs stay editable without inventing a structured rule or revision. */
export interface AutomationJob extends Omit<CronJobV2, 'tenantId' | 'configuration' | 'revision' | 'scheduleRevision' | 'updatedAt' | 'cronExpr' | 'sessionId'> {
  tenantId?: string
  cronExpr?: string | null
  sessionId?: string | null
  configuration?: CronConfigurationV2
  revision?: number
  scheduleRevision?: number
  updatedAt?: number
}
export interface AutomationAgent { id: string; name: string; model?: string }
export interface AutomationSession { id: string; title: string; workspacePath?: string | null; agentId?: string }
export interface AutomationSessionBinding {
  started: boolean
  agentId: string | null
  agent: { id: string; name: string; description?: string } | null
}

async function ownedRequest<T>(input: EngineRequestInput): Promise<T> {
  const source = getEngineSource()
  const value = await requestOrThrow<T>(input)
  assertEngineSource(source)
  return value
}

export async function automationCapabilities(): Promise<CronCapabilities | null> {
  const source = getEngineSource()
  const response = await request<unknown>({ method: 'GET', path: '/cron/capabilities' })
  assertEngineSource(source)
  if (!response.ok) {
    if ([404, 40400, 501, 50100].includes(response.code)) return null
    throw new Error(response.message || '无法读取自动化能力')
  }
  return validateAutomationCapabilities(response.data)
}
export const listAutomations = async (): Promise<AutomationJob[]> => validateAutomationList(await ownedRequest({ method: 'GET', path: '/cron' }))
export const getAutomation = async (id: string): Promise<AutomationJob> => validateAutomationJob(await ownedRequest({ method: 'GET', path: `/cron/${encodeURIComponent(id)}` }), id)
export const saveAutomation = async (id: string | undefined, body: object): Promise<AutomationJob> => validateAutomationJob(await ownedRequest({ method: id ? 'PUT' : 'POST', path: id ? `/cron/${encodeURIComponent(id)}` : '/cron', body }), id)
export const setAutomationEnabled = async (id: string, enabled: boolean): Promise<AutomationJob> => validateAutomationJob(await ownedRequest({ method: 'POST', path: `/cron/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, body: {} }), id)
export const deleteAutomation = (id: string): Promise<{ deleted: boolean }> => ownedRequest({ method: 'DELETE', path: `/cron/${encodeURIComponent(id)}` })
export const previewAutomation = async (body: CronPreviewRequest) => validateAutomationPreview(await ownedRequest({ method: 'POST', path: '/cron/preview', body }), body.schedule)
export const getAutomationRuns = async (id: string, cursor?: string) => validateAutomationRunPage(await ownedRequest({ method: 'GET', path: `/cron/${encodeURIComponent(id)}/runs`, query: { limit: 24, ...(cursor ? { cursor } : {}) } }), id)
export const getAutomationRun = async (id: string) => validateAutomationRun(await ownedRequest({ method: 'GET', path: `/cron/runs/${encodeURIComponent(id)}` }), id)
export const cancelAutomationRun = async (id: string) => validateAutomationRun(await ownedRequest({ method: 'POST', path: `/cron/runs/${encodeURIComponent(id)}/cancel`, body: {} }), id)
export const getAutomationNotifications = async (cursor?: string) => validateAutomationNotificationPage(await ownedRequest({ method: 'GET', path: '/cron/notifications', query: { limit: 24, ...(cursor ? { cursor } : {}) } }))
export const markAutomationNotificationRead = async (id: string) => validateAutomationNotification(await ownedRequest({ method: 'POST', path: `/cron/notifications/${encodeURIComponent(id)}/read`, body: {} }), id)
export const getAutomationSessionBinding = async (id: string) => validateAutomationBinding(await ownedRequest({ method: 'GET', path: `/sessions/${encodeURIComponent(id)}/binding` }))
export const getAutomationAgents = async () => validateAutomationAgents(await ownedRequest({ method: 'GET', path: '/agents' }))
