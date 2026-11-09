/** Idle polling must preserve readers; repeated pages never duplicate output and final stderr is retained. */
import { expect, test } from '@playwright/test'
import type { CommandJobOutput, CommandJobSnapshot } from '../src/shared/command-job'
import { emptyCommandOutput, mergeCommandOutput } from '../src/renderer/src/core/engine/command-job-state'

const job: CommandJobSnapshot = { schemaVersion: 1, jobId: 'service', sessionId: 'task', ownerSessionId: 'task',
  version: 1, status: 'running', command: 'node', args: ['serve.js'], cwd: '/project', background: true,
  createdAt: 1, updatedAt: 1, exitCode: null, signal: null, cursor: 1, earliestCursor: 0 }
const first: CommandJobOutput = { job, entries: [{ seq: 1, stream: 'stdout', text: 'ready\n' }],
  nextCursor: 1, earliestCursor: 0, truncated: false, hasMore: false }

test('idle and replayed pages preserve log identity instead of waking readers', () => {
  const state = mergeCommandOutput(emptyCommandOutput, first)
  expect(mergeCommandOutput(state, { ...first, entries: [] })).toBe(state)
  expect(mergeCommandOutput(state, first)).toBe(state)
  expect(state.entries.map(entry => entry.text).join('')).toBe('ready\n')
})

test('final stderr advances once and a new truncation notice still reaches readers', () => {
  const state = mergeCommandOutput(emptyCommandOutput, first)
  const page: CommandJobOutput = { ...first, nextCursor: 2,
    job: { ...job, cursor: 2, version: 2, status: 'failed', exitCode: 1 },
    entries: [...first.entries, { seq: 2, stream: 'stderr', text: 'final error\n' }] }
  const final = mergeCommandOutput(state, page)
  expect(final.cursor).toBe(2)
  expect(final.entries.map(entry => entry.text).join('')).toBe('ready\nfinal error\n')
  expect(mergeCommandOutput(final, page)).toBe(final)
  const truncated = mergeCommandOutput(final, { ...page, entries: [], truncated: true })
  expect(truncated).not.toBe(final)
  expect(truncated.truncated).toBe(true)
  expect(truncated.entries).toEqual(final.entries)
})
