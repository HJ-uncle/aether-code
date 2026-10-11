/** Multiple live product surfaces must not evict each other's command output.
 * These tests exercise asynchronous cache ownership without launching Electron. */
import { expect, test } from '@playwright/test'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import {
  activateCommandSession,
  deactivateCommandSession,
  getCommandJobs,
  ingestCommandJob,
  refreshCommandOutput
} from '../src/renderer/src/core/engine/command-job-store'

const makeJob = (sessionId: string): CommandJobSnapshot => ({
  schemaVersion: 1,
  jobId: `job-${sessionId}`,
  sessionId,
  ownerSessionId: sessionId,
  version: 1,
  status: 'running',
  command: 'node',
  args: [],
  cwd: '/workspace',
  background: true,
  createdAt: 1,
  updatedAt: 1,
  exitCode: null,
  signal: null,
  cursor: 0,
  earliestCursor: 0
})
const codeJob = makeJob('code-command-session'),
  workJob = makeJob('work-command-session')
const result = (job: CommandJobSnapshot, text: string) => ({
  ok: true,
  data: {
    job,
    entries: [{ seq: 1, stream: 'stdout', text }],
    nextCursor: 1,
    earliestCursor: 0,
    truncated: false,
    hasMore: false
  }
})
function bridge(request: () => Promise<unknown>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { aether: { engine: { request } } }
  })
}
test.afterEach(() => {
  deactivateCommandSession('code')
  deactivateCommandSession('work')
  Reflect.deleteProperty(globalThis, 'window')
})

test('同时激活 Code 和 Work 后两者命令均保留，切换 Work 任务只释放其旧输出', async () => {
  activateCommandSession(codeJob.sessionId, 'code')
  ingestCommandJob(codeJob)
  activateCommandSession(workJob.sessionId, 'work')
  ingestCommandJob(workJob)
  expect(getCommandJobs(codeJob.sessionId)).toEqual([codeJob])
  expect(getCommandJobs(workJob.sessionId)).toEqual([workJob])
  activateCommandSession('work-other-command-session', 'work')
  expect(getCommandJobs(workJob.sessionId)).toEqual([])
  expect(ingestCommandJob(workJob)).toBeUndefined()
  expect(getCommandJobs(codeJob.sessionId)).toEqual([codeJob])
  deactivateCommandSession('work')
  bridge(async () => result(codeJob, 'CODE_OUTPUT_REMAINS'))
  const output = await refreshCommandOutput(codeJob.sessionId, codeJob.jobId)
  expect(output.output.entries.map((entry) => entry.text)).toEqual(['CODE_OUTPUT_REMAINS'])
})

test('打开 Work 不能使 Code 已发出的输出请求失效', async () => {
  activateCommandSession(codeJob.sessionId, 'code')
  ingestCommandJob(codeJob)
  let release!: (value: unknown) => void
  bridge(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = refreshCommandOutput(codeJob.sessionId, codeJob.jobId)
  activateCommandSession(workJob.sessionId, 'work')
  ingestCommandJob(workJob)
  release(result(codeJob, 'CODE_REQUEST_COMPLETED'))
  const output = await pending
  expect(output.output.entries.map((entry) => entry.text)).toEqual(['CODE_REQUEST_COMPLETED'])
  expect(getCommandJobs(workJob.sessionId)).toEqual([workJob])
})

test('Work 切换后的旧输出不能复活缓存，Code 输出仍有效', async () => {
  activateCommandSession(codeJob.sessionId, 'code')
  ingestCommandJob(codeJob)
  activateCommandSession(workJob.sessionId, 'work')
  ingestCommandJob(workJob)
  let release!: (value: unknown) => void
  bridge(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = refreshCommandOutput(workJob.sessionId, workJob.jobId)
  activateCommandSession('work-next-command-session', 'work')
  release(result(workJob, 'STALE_WORK_OUTPUT'))
  await expect(pending).rejects.toThrow('会话已切换')
  expect(getCommandJobs(workJob.sessionId)).toEqual([])
  expect(getCommandJobs(codeJob.sessionId)).toEqual([codeJob])
})

test('两个界面临时查看同一会话时，仅释放一个持有者不能清空共享输出', () => {
  activateCommandSession(codeJob.sessionId, 'code')
  activateCommandSession(codeJob.sessionId, 'work')
  ingestCommandJob(codeJob)
  deactivateCommandSession('work')
  expect(getCommandJobs(codeJob.sessionId)).toEqual([codeJob])
  deactivateCommandSession('code')
  expect(getCommandJobs(codeJob.sessionId)).toEqual([])
})
