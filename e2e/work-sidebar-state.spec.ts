/** Pure sidebar status contracts: scoped root observations, admission races,
 * bounded discovery and persisted UI preferences. No Electron or provider. */
import { expect, test } from '@playwright/test'
import type { RootRun } from '../src/shared/root-run'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import { normalizeWorkState, workStatus } from '../src/renderer/src/contrib/work/work-state'
import {
  acceptWorkTaskActivity, createWorkStatusDiscovery, pollWorkTaskStatuses, workTaskActivityFromRun, workTaskRunPatch,
  type WorkRunStatus, type WorkStatusTask
} from '../src/renderer/src/contrib/work/work-status-poller'

const run = (sessionId = 'work-one', patch: Partial<RootRun> = {}): RootRun => ({
  schemaVersion: 1, sessionId, runId: 'root-' + sessionId, turnId: 'turn', userMessageId: 'user', assistantMessageId: 'assistant',
  seq: 1, version: 1, status: 'running', createdAt: 10, updatedAt: 20, startedAt: 12, pending: [], ...patch
})
const task = (id = 'work-one', patch: Partial<WorkStatusTask> = {}): WorkStatusTask => ({ id, status: 'running', updatedAt: 20,
  activity: workTaskActivityFromRun({ run: run(id) }, id), ...patch })
const pending = (kind: 'ask' | 'permission', status: 'pending' | 'answered' = 'pending'): RootRun['pending'][number] => ({
  requestId: kind, kind, status, toolCallId: kind, toolName: kind, args: { private: 'not persisted' }, question: 'not persisted'
})

test('task preferences and activity survive restart while malformed fields and private payloads are stripped', () => {
  const activity = { ...workTaskActivityFromRun({ run: run() }, 'work-one')!, prompt: 'do not persist', pending: [pending('ask')] }
  const base = { id: 'work-one', title: 'one', createdAt: 1, status: 'running', pinned: true, labelColor: 'purple', activity }
  const state = normalizeWorkState({ tasks: [base, { ...base, id: 'work-two', pinned: 'true', labelColor: 'invalid', activity: { ...activity, version: -1 } }], activeTaskId: 'work-one' })
  expect(state.tasks[0]).toMatchObject({ pinned: true, labelColor: 'purple', status: 'running' })
  expect(Object.keys(state.tasks[0].activity!).sort()).toEqual(['pendingAsk', 'pendingPermission', 'runId', 'seq', 'status', 'updatedAt', 'version'])
  expect(state.tasks[1].pinned).toBeUndefined()
  expect(state.tasks[1].labelColor).toBeUndefined()
  expect(state.tasks[1].activity).toBeUndefined()
  expect(normalizeWorkState(JSON.parse(JSON.stringify(state))).tasks).toEqual(state.tasks)
})

test('only owned valid roots produce waiting counts; terminal states never keep stale questions', () => {
  const waiting = run('work-one', { status: 'waiting', pending: [pending('ask'), pending('permission'), pending('ask', 'answered')] })
  expect(workTaskActivityFromRun({ run: waiting }, 'work-one')).toMatchObject({ pendingAsk: 1, pendingPermission: 1 })
  expect(workTaskActivityFromRun({ run: { ...waiting, status: 'succeeded' } }, 'work-one')).toMatchObject({ pendingAsk: 0, pendingPermission: 0 })
  for (const malformed of [{ ...waiting, sessionId: 'foreign' }, { ...waiting, runId: '' }, { ...waiting, seq: -1 },
    { ...waiting, version: 0 }, { ...waiting, updatedAt: NaN }, { ...waiting, pending: [{}] }, { status: 'waiting' }]) {
    expect(workTaskActivityFromRun({ run: malformed }, 'work-one')).toBeUndefined()
  }
})

test('same-root versions and question changes update activity without reviving a settled root', () => {
  const current = task()
  const waiting = run('work-one', { status: 'waiting', version: 2, updatedAt: 30, pending: [pending('ask')] })
  const first = workTaskRunPatch(current, { run: waiting }, 40)!
  expect(first).toMatchObject({ status: 'waiting', activity: { pendingAsk: 1, pendingPermission: 0 }, runStartedAt: 12 })
  const permission = { ...waiting, version: 3, updatedAt: 35, pending: [pending('permission')] }
  const second = workTaskRunPatch({ ...current, ...first }, { run: permission }, 41)!
  expect(second).toMatchObject({ status: 'waiting', activity: { version: 3, pendingAsk: 0, pendingPermission: 1 } })
  expect(workTaskRunPatch({ ...current, ...second }, { run: permission }, 42)).toBeUndefined()
  expect(workTaskRunPatch({ ...current, ...second }, { run: waiting }, 42)).toBeUndefined()
  expect(workTaskRunPatch({ ...current, ...first, activity: { ...first.activity, pendingAsk: 0 } }, { run: waiting }, 42))
    .toMatchObject({ activity: { version: 2, pendingAsk: 1 } })
  const settled = workTaskActivityFromRun({ run: run('work-one', { status: 'succeeded', version: 4, updatedAt: 40 }) }, 'work-one')!
  expect(acceptWorkTaskActivity(settled, { ...settled, version: 5, status: 'running', updatedAt: 45 })).toBe(false)
  expect(acceptWorkTaskActivity(settled, { ...settled, runId: 'old-root', seq: 0 })).toBe(false)
  expect(acceptWorkTaskActivity(settled, { ...settled, runId: 'new-root', seq: 2, version: 1, status: 'running' })).toBe(true)
})

test('a local optimistic send ignores the previous root until a new root is admitted', () => {
  const previous = run('work-one', { status: 'succeeded' })
  const optimistic = task('work-one', { status: 'running', activity: workTaskActivityFromRun({ run: previous }, 'work-one') })
  const admission = { previousRunId: previous.runId, previousRunSeq: previous.seq, admitted: false }
  expect(workTaskRunPatch(optimistic, { run: previous }, 50, admission)).toBeUndefined()
  expect(workTaskRunPatch(optimistic, {}, 50, admission)).toBeUndefined()
  const next = run('work-one', { runId: 'next-root', seq: 2, createdAt: 40, startedAt: 45, updatedAt: 46 })
  expect(workTaskRunPatch(optimistic, { run: next }, 50, admission)).toMatchObject({ status: 'running', runStartedAt: 45, activity: { runId: 'next-root' } })
  // After restart, with no local admission, the confirmed previous result fixes a stale spinner.
  expect(workTaskRunPatch(optimistic, { run: previous }, 50)).toMatchObject({ status: 'done', runStartedAt: undefined })
})

test('passive root discovery preserves recency while genuine newer execution timestamps advance it', () => {
  const oldTask = task('work-one', { status: 'done', updatedAt: 500, activity: undefined })
  const oldRoot = run('work-one', { status: 'succeeded', updatedAt: 100 })
  expect(workTaskRunPatch(oldTask, { run: oldRoot }, 10000)).toMatchObject({ updatedAt: 500, activity: { updatedAt: 100 } })
  const withOldRoot = { ...oldTask, activity: workTaskActivityFromRun({ run: oldRoot }, oldTask.id) }
  const newRoot = run('work-one', { runId: 'new-root', seq: 2, createdAt: 800, startedAt: 810, updatedAt: 900 })
  expect(workTaskRunPatch(withOldRoot, { run: newRoot }, 10000)).toMatchObject({ updatedAt: 900, runStartedAt: 810 })
})

test('root versions advance despite server clock rollback while equal versions retain strict identity', () => {
  const previous = task()
  const response = { run: run('work-one', { version: 2, updatedAt: 15, status: 'waiting', pending: [pending('permission')] }) }
  expect(workTaskRunPatch(previous, response, 1000)).toMatchObject({ updatedAt: 20,
    activity: { version: 2, updatedAt: 15, status: 'waiting', pendingPermission: 1 } })
  expect(workTaskRunPatch(previous, { run: { ...response.run, version: 1 } }, 1000)).toBeUndefined()
})

test('a committed history rollback can rebuild an older root baseline while ordinary polls reject it', () => {
  const latest = task('work-one', { status: 'done', activity: workTaskActivityFromRun({ run: run('work-one', {
    runId: 'latest-root', seq: 2, status: 'succeeded'
  }) }, 'work-one') })
  const previous = { run: run('work-one', { status: 'failed' }) }
  expect(workTaskRunPatch(latest, previous, 1000)).toBeUndefined()
  const committedHistory = { ...latest, activity: undefined }
  expect(workTaskRunPatch(committedHistory, previous, 1000)).toMatchObject({ status: 'error', activity: { seq: 1, runId: 'root-work-one' } })
  expect(workStatus([], false)).toBeNull()
})

test('selected authoritative outcomes override transport streaming; legacy messages retain fallback behavior', () => {
  const message = (root?: RootRun): ChatMessage => ({ id: 'assistant', role: 'assistant', content: '', thinking: '', tools: [],
    createdAt: 10, status: 'streaming', ...(root ? { run: root } : {}) })
  for (const [status, expected] of [['succeeded', 'done'], ['failed', 'error'], ['cancelled', 'stopped'], ['interrupted', 'interrupted'], ['waiting', 'waiting']] as const)
    expect(workStatus([message(run('work-one', { status }))], true)).toBe(expected)
  expect(workStatus([message()], true)).toBe('running')
  expect(workStatus([], true, run('work-one', { status: 'waiting' }))).toBe('waiting')
})

test('idle discovery prioritizes visible recent rows, rotates old tasks and never exceeds two or fifteen seconds per row', () => {
  const discovery = createWorkStatusDiscovery()
  const tasks = Array.from({ length: 10 }, (_, index) => task('work-' + index, { status: 'done', updatedAt: index }))
  tasks.push(task('work-hidden', { status: 'done', archived: true, pinned: true }))
  tasks[0] = { ...tasks[0], pinned: true }
  const first = discovery.take(tasks, () => true, 0)
  expect(first.map(item => item.id)).toEqual(['work-0', 'work-9'])
  first.forEach(item => discovery.record(item.id, 0))
  const visited = first.map(item => item.id)
  for (let pass = 1; pass < 5; pass++) {
    const next = discovery.take(tasks, () => true, pass * 1500)
    expect(next).toHaveLength(2)
    visited.push(...next.map(item => item.id)); next.forEach(item => discovery.record(item.id, pass * 1500))
  }
  expect(new Set(visited).size).toBe(10)
  expect(discovery.take(tasks, () => true, 14999)).toEqual([])
  expect(discovery.take(tasks, () => true, 15000).map(item => item.id)).toEqual(['work-0', 'work-9'])
})

test('background terminal tasks discover a new root and same waiting status still refreshes permission type', async () => {
  let tasks: WorkStatusTask[] = [task('work-old', { status: 'done', activity: workTaskActivityFromRun({ run: run('work-old', { status: 'succeeded' }) }, 'work-old') }),
    task('work-wait', { status: 'waiting', activity: workTaskActivityFromRun({ run: run('work-wait', { status: 'waiting', pending: [pending('ask')] }) }, 'work-wait') })]
  const requests: string[] = []
  await pollWorkTaskStatuses({ tasks: () => tasks, revision: () => 0, shouldPoll: () => true, isCurrent: () => true,
    discovery: createWorkStatusDiscovery(), now: () => 50,
    request: async id => { requests.push(id); return { run: id === 'work-old'
      ? run(id, { runId: 'new-root', seq: 2 })
      : run(id, { status: 'waiting', version: 2, updatedAt: 30, pending: [pending('permission')] }) } },
    apply: (id, status, activity) => { tasks = tasks.map(item => item.id === id ? { ...item, status, activity } : item) }
  })
  expect(requests).toEqual(['work-wait', 'work-old'])
  expect(tasks[0]).toMatchObject({ status: 'running', activity: { runId: 'new-root' } })
  expect(tasks[1]).toMatchObject({ status: 'waiting', activity: { pendingAsk: 0, pendingPermission: 1 } })
})

test('late background replies cannot cross selection, source, local revision or root watermark changes', async () => {
  for (const race of ['revision', 'source', 'selected', 'activity'] as const) {
    let revision = 0, current = true, selected = false
    const tasks = [task()]
    let release!: (response: WorkRunStatus) => void
    const applied: string[] = []
    const promise = pollWorkTaskStatuses({ tasks: () => tasks, revision: () => revision, shouldPoll: () => !selected,
      isCurrent: () => current, request: () => new Promise(resolve => { release = resolve }), apply: id => { applied.push(id) } })
    if (race === 'revision') revision++
    if (race === 'source') current = false
    if (race === 'selected') selected = true
    if (race === 'activity') tasks[0] = { ...tasks[0], activity: { ...tasks[0].activity!, version: 3 } }
    release({ run: run('work-one', { status: 'succeeded', version: 2, updatedAt: 30 }) })
    await promise
    expect(applied, race).toEqual([])
  }
})
