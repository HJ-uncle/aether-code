/** Pure performance/data-safety contracts: isolated draft notifications, bounded
 * autosave, v1 recovery and bounded status polling. No Electron needed. */
import { expect, test } from '@playwright/test'
import {
  createDraftPersistenceScheduler,
  type DraftPersistenceClock
} from '../src/renderer/src/contrib/work/work-draft-persistence'
import {
  pollWorkTaskStatuses,
  workTaskStatusFromRun,
  type WorkStatusTask,
  type WorkRunStatus
} from '../src/renderer/src/contrib/work/work-status-poller'
import {
  flushWorkDrafts,
  getWorkDraft,
  getWorkState,
  normalizeWorkState,
  onWorkDraftChanged,
  onWorkStateChanged,
  updateWorkDraft,
  updateWorkState,
  workStorageKey
} from '../src/renderer/src/contrib/work/work-state'
let fixtureSequence = 0

function fakeClock(): DraftPersistenceClock & { advance: (duration: number) => void } {
  let now = 0
  const jobs = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>()
  return {
    setTimeout(callback, delay) {
      const handle = setTimeout(() => {}, 0)
      clearTimeout(handle)
      jobs.set(handle, { at: now + delay, callback })
      return handle
    },
    clearTimeout: (handle) => {
      jobs.delete(handle)
    },
    advance(duration) {
      const target = now + duration
      while (true) {
        const entry = [...jobs].sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry || entry[1].at > target) break
        now = entry[1].at
        jobs.delete(entry[0])
        entry[1].callback()
      }
      now = target
    }
  }
}

test('Work 草稿暂停 300ms 保存，连续输入不超过 2s，flush/cancel 不留旧写入', () => {
  const clock = fakeClock()
  let writes = 0
  const save = createDraftPersistenceScheduler(() => {
    writes += 1
  }, clock)
  save.schedule()
  clock.advance(200)
  save.schedule()
  clock.advance(299)
  expect(writes).toBe(0)
  clock.advance(1)
  expect(writes).toBe(1)
  for (let index = 0; index < 20; index++) {
    save.schedule()
    clock.advance(100)
  }
  expect(writes).toBe(2)
  save.schedule()
  save.flush()
  save.flush()
  clock.advance(3000)
  expect(writes).toBe(3)
  save.schedule()
  save.cancel()
  clock.advance(3000)
  expect(writes).toBe(3)
})

test('Work 每字只通知当前草稿，发送前 flush 保留 v1 格式且不会覆盖新的输入', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  // Other pure bridge specs install a partial window. Own complete lifecycle
  // adapters here so this contract has the same behavior in a combined run.
  const lifecycleWindow = new EventTarget()
  const lifecycleDocument = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: lifecycleWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: lifecycleDocument })
  const data = new Map<string, string>()
  const writes: string[] = []
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push(key)
        data.set(key, value)
      }
    }
  })
  const source = `draft-contract-${++fixtureSequence}`
  let stateChanges = 0,
    otherSourceChanges = 0,
    draftChanges = 0,
    otherDraftChanges = 0
  const dispose = [
    onWorkStateChanged(source, () => {
      stateChanges += 1
    }),
    onWorkStateChanged('another-source', () => {
      otherSourceChanges += 1
    }),
    onWorkDraftChanged(source, 'work-existing', () => {
      draftChanges += 1
    }),
    onWorkDraftChanged(source, null, () => {
      otherDraftChanges += 1
    })
  ]
  data.set(
    workStorageKey(source),
    JSON.stringify(
      normalizeWorkState({
        tasks: [{ id: 'work-existing', title: '已有任务', createdAt: 1, draft: '旧版草稿' }],
        activeTaskId: 'work-existing'
      })
    )
  )
  try {
    expect(getWorkDraft(source, 'work-existing').text).toBe('旧版草稿')
    updateWorkDraft(source, 'work-existing', '新', [])
    updateWorkDraft(source, 'work-existing', '新草稿', [])
    updateWorkDraft(source, 'work-existing', '新草稿', [])
    expect(draftChanges).toBe(2)
    expect([writes.length, stateChanges, otherSourceChanges, otherDraftChanges]).toEqual([
      0, 0, 0, 0
    ])
    expect(getWorkState(source).tasks[0].draft).toBe('旧版草稿')
    flushWorkDrafts(source)
    expect([writes.length, stateChanges]).toEqual([1, 1])
    expect(JSON.parse(data.get(workStorageKey(source))!).tasks[0].draft).toBe('新草稿')
    const persisted = getWorkState(source)
    updateWorkState(source, (previous) => ({
      ...previous,
      tasks: previous.tasks.map((task) => ({ ...task }))
    }))
    expect(getWorkState(source)).toBe(persisted)
    expect(writes).toHaveLength(1)
    updateWorkDraft(source, 'work-existing', '发送期间的新补充', [])
    updateWorkState(source, (previous) => ({
      ...previous,
      tasks: previous.tasks.map((task) => ({ ...task, status: 'running' }))
    }))
    expect(getWorkDraft(source, 'work-existing').text).toBe('发送期间的新补充')
    expect(getWorkState(source).tasks[0].draft).toBe('发送期间的新补充')
    flushWorkDrafts(source)
    expect(writes).toHaveLength(2)
    updateWorkDraft(source, 'work-existing', '马上发送', [])
    updateWorkState(source, (previous) => ({
      ...previous,
      tasks: previous.tasks.map((task) => ({ ...task, draft: '', mentions: [] }))
    }))
    flushWorkDrafts(source)
    expect(getWorkDraft(source, 'work-existing').text).toBe('')
    expect(JSON.parse(data.get(workStorageKey(source))!).tasks[0].draft).toBe('')
    expect(otherSourceChanges).toBe(0)
    updateWorkDraft(source, 'work-existing', '退出前最后几个字符', [])
    lifecycleWindow.dispatchEvent(new Event('beforeunload'))
    expect(JSON.parse(data.get(workStorageKey(source))!).tasks[0].draft).toBe('退出前最后几个字符')
  } finally {
    flushWorkDrafts(source)
    dispose.forEach((off) => off())
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

function running(id: string): WorkStatusTask {
  return { id, status: 'running', updatedAt: 1 }
}

test('Work 状态探测最多并发 2 个，选中 SSE 会话不探测，相同状态不产生写入', async () => {
  const tasks = [running('selected'), running('first'), running('second'), running('third')]
  const releases = new Map<string, (value: WorkRunStatus) => void>()
  const requested: string[] = [],
    applied: string[] = []
  let inflight = 0,
    maximum = 0
  const polling = pollWorkTaskStatuses({
    tasks: () => tasks,
    revision: () => 0,
    shouldPoll: (task) => task.id !== 'selected',
    isCurrent: () => true,
    request: (id) => {
      requested.push(id)
      maximum = Math.max(maximum, ++inflight)
      return new Promise((resolve) =>
        releases.set(id, (value) => {
          inflight -= 1
          resolve(value)
        })
      )
    },
    apply: (id, status) => {
      applied.push(`${id}:${status}`)
    }
  })
  expect(requested).toEqual(['first', 'second'])
  releases.get('first')!({ run: { status: 'succeeded' } })
  await Promise.resolve()
  expect(requested).toEqual(['first', 'second', 'third'])
  releases.get('second')!({ run: { status: 'waiting' } })
  releases.get('third')!({ run: { status: 'running' } })
  await polling
  expect(maximum).toBe(2)
  expect(applied).toEqual(['first:done', 'second:waiting'])
})

test('Work 迟到探测不能覆盖停止/继续动作、SSE 更新或已切换引擎', async () => {
  for (const race of ['action', 'sse', 'source', 'selected'] as const) {
    let revision = 0,
      current = true,
      selected = false
    const tasks = [running('work-race')]
    let complete: (value: WorkRunStatus) => void = () => {
      throw new Error('request not started')
    }
    const applied: string[] = []
    const polling = pollWorkTaskStatuses({
      tasks: () => tasks,
      revision: () => revision,
      shouldPoll: () => !selected,
      isCurrent: () => current,
      request: () =>
        new Promise((resolve) => {
          complete = resolve
        }),
      apply: (id, status) => {
        applied.push(`${id}:${status}`)
      }
    })
    if (race === 'action') revision += 1
    if (race === 'sse') tasks[0] = { ...tasks[0], updatedAt: 2 }
    if (race === 'source') current = false
    if (race === 'selected') selected = true
    complete({ run: { status: 'succeeded' } })
    await polling
    expect(applied, race).toEqual([])
  }
  expect(workTaskStatusFromRun({ running: false, finished: true }, 'waiting')).toBe('waiting')
  expect(workTaskStatusFromRun({ run: { status: 'interrupted' } }, 'running')).toBe('interrupted')
})
