/** Work service tray contract: only background services for this session are
 * listed, active jobs stay in running, and terminal jobs move to history. */
import { expect, test } from '@playwright/test'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import { partitionWorkServices } from '../src/renderer/src/contrib/work/WorkServiceTray'

const job = (patch: Partial<CommandJobSnapshot> = {}): CommandJobSnapshot => ({
  schemaVersion: 1, jobId: 'job', sessionId: 'session', ownerSessionId: 'session',
  version: 1, status: 'running', command: 'node', args: ['server.mjs'], cwd: 'C:/work',
  background: true, runId: 'run', ownerRunId: 'run', turnId: 'turn', toolCallId: 'tool',
  createdAt: 1, updatedAt: 1, finishedAt: undefined, exitCode: null, signal: null,
  error: undefined, cursor: 0, earliestCursor: 0, ...patch
})

test('服务弹层只展示当前会话后台服务并将终态归入历史', () => {
  const view = partitionWorkServices([
    job(),
    job({ version: 2, updatedAt: 3, status: 'succeeded', finishedAt: 3 }),
    job({ jobId: 'other', sessionId: 'other-session', updatedAt: 4 }),
    job({ jobId: 'foreground', background: false, updatedAt: 5 }),
    job({ jobId: 'live', updatedAt: 2 })
  ], 'session')
  expect(view.running.map(item => item.jobId)).toEqual(['live'])
  expect(view.history.map(item => item.jobId)).toEqual(['job'])
})
