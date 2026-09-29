/** D7 async session lifetimes: navigation/clear cannot repopulate prior command output. */
import { expect, test } from '@playwright/test'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import { activateCommandSession, cancelCommandJob, commandJobMissing, forgetCommandSession, getCommandJobs, ingestCommandJob, refreshCommandJobs, refreshCommandOutput } from '../src/renderer/src/core/engine/command-job-store'

const job: CommandJobSnapshot = { schemaVersion: 1, jobId: 'store-job', sessionId: 'store-session', ownerSessionId: 'store-session', runId: 'root', toolCallId: 'call', version: 1, status: 'running', command: 'node', args: [], cwd: 'D:/workspace', background: true, createdAt: 1, updatedAt: 1, exitCode: null, signal: null, cursor: 0, earliestCursor: 0 }
function bridge(request: (input: unknown) => Promise<unknown>) { Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: { request } } } }) }
test.afterEach(() => { forgetCommandSession(job.sessionId); Reflect.deleteProperty(globalThis, 'window') })
test('switching sessions releases previous buffers and ignores an in-flight output response', async () => {
  activateCommandSession(job.sessionId); ingestCommandJob(job)
  let release!: (value: unknown) => void
  bridge(() => new Promise(resolve => { release = resolve }))
  const pending = refreshCommandOutput(job.sessionId, job.jobId)
  activateCommandSession('other-session')
  release({ ok: true, data: { job, entries: [], nextCursor: 0, earliestCursor: 0, truncated: false, hasMore: false } })
  await expect(pending).rejects.toThrow('会话已切换')
  expect(getCommandJobs(job.sessionId)).toEqual([])
  expect(ingestCommandJob(job)).toBeUndefined()
})
test('clear invalidates pending list/cancel results and cannot resurrect the old job', async () => {
  activateCommandSession(job.sessionId); ingestCommandJob(job)
  const releases: Array<(value: unknown) => void> = []
  bridge(() => new Promise(resolve => { releases.push(resolve) }))
  const list = refreshCommandJobs(job.sessionId), cancel = cancelCommandJob(job.sessionId, job.jobId)
  forgetCommandSession(job.sessionId)
  releases[0]({ ok: true, data: { jobs: [job] } }); releases[1]({ ok: true, data: { ...job, version: 2, status: 'cancelled' } })
  await list; await expect(cancel).rejects.toThrow('会话已切换'); expect(getCommandJobs(job.sessionId)).toEqual([])
})
test('cancel failure retains running state; expired output is classified without faking a terminal state', async () => {
  activateCommandSession(job.sessionId); ingestCommandJob(job)
  bridge(async () => ({ ok: false, code: 500, message: 'REAL_CANCEL_FAILURE', data: null }))
  await expect(cancelCommandJob(job.sessionId, job.jobId)).rejects.toThrow('REAL_CANCEL_FAILURE')
  expect(getCommandJobs(job.sessionId)[0].status).toBe('running')
  bridge(async () => ({ ok: false, code: 404, message: 'missing', data: null }))
  const error = await refreshCommandOutput(job.sessionId, job.jobId).catch(error => error)
  expect(commandJobMissing(error)).toBe(true); expect(error.message).toBe('任务已过期或不存在')
  expect(getCommandJobs(job.sessionId)[0].status).toBe('running')
})
