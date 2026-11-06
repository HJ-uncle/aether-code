/** Work review contracts: exact session ownership, pending-only batch scope,
 * turn-local IDs including kept records, and invalidated confirmation identity. */
import { expect, test } from '@playwright/test'
import type { EngineFileChange } from '../src/shared/ipc'
import { workChangeReviewIdentity, workChangeReviewTargets } from '../src/renderer/src/contrib/work/work-change-review'
import { changeIdsOf } from '../src/renderer/src/core/engine/change-actions'

const row = (id: string, patch: Partial<EngineFileChange> = {}): EngineFileChange => ({
  id, sessionId: 'work-task', path: `D:/work/${id}.txt`, kind: 'write', oldContent: 'old', newContent: 'new',
  status: 'pending', truncated: false, createdAt: 1, ...patch
})

test('批量保留与撤回只选择本会话待确认记录，净变化包含完整操作链', () => {
  const changes = [row('pending', { changeIds: ['older', 'pending'] }), row('kept', { status: 'kept' }),
    row('reverted', { status: 'reverted' }), row('other', { sessionId: 'other' })]
  for (const action of ['keep', 'revert'] as const) {
    const targets = workChangeReviewTargets('work-task', changes, action, 'batch')
    expect(targets.map(item => item.id)).toEqual(['pending'])
    expect(changeIdsOf(targets)).toEqual(['older', 'pending'])
  }
  expect(workChangeReviewTargets('', changes, 'keep', 'batch')).toEqual([])
})

test('单项可明确撤回已保留改动，但不会再次保留或重复撤回已撤回记录', () => {
  const kept = row('kept', { status: 'kept' }), reverted = row('reverted', { status: 'reverted' })
  expect(workChangeReviewTargets('work-task', [kept, reverted], 'revert', 'single')).toEqual([kept])
  expect(workChangeReviewTargets('work-task', [kept, reverted], 'keep', 'single')).toEqual([])
  expect(workChangeReviewTargets('work-task', [row('legacy', { sessionId: undefined })], 'keep', 'single')).toHaveLength(1)
})

test('本轮撤回包含已保留记录，但拒绝外会话、无主和已撤回记录，也不提供保留操作', () => {
  const changes = [row('pending'), row('kept', { status: 'kept' }), row('reverted', { status: 'reverted' }),
    row('foreign', { sessionId: 'other' }), row('legacy', { sessionId: undefined })]
  const targets = workChangeReviewTargets('work-task', changes, 'revert', 'turn')
  expect(changeIdsOf(targets)).toEqual(['pending', 'kept'])
  expect(targets.map(item => item.status)).toEqual(['pending', 'kept'])
  expect(workChangeReviewTargets('work-task', changes, 'keep', 'turn')).toEqual([])
  expect(workChangeReviewTargets('', changes, 'revert', 'turn')).toEqual([])
})

test('本轮撤回仅发送原始记录 ID，不展开混入其他轮次的净变化链且不修改输入', () => {
  const changes = [row('current-write', { turnId: 'turn-current', changeIds: ['previous-turn-write', 'current-write'] }),
    row('current-kept', { turnId: 'turn-current', status: 'kept', changeIds: ['foreign-write', 'current-kept'] })]
  const before = structuredClone(changes)
  const targets = workChangeReviewTargets('work-task', changes, 'revert', 'turn')
  expect(changeIdsOf(targets)).toEqual(['current-write', 'current-kept'])
  expect(targets.map(item => item.changeIds)).toEqual([['current-write'], ['current-kept']])
  expect(changes).toEqual(before)
  expect(targets[0]).not.toBe(changes[0])
})

test('本轮同文件多次写入全部保留为精确 ID，重复回执不产生重复撤回', () => {
  const first = row('first-write', { path: 'D:/work/game.html', seq: 1 })
  const second = row('second-write', { path: first.path, seq: 2, status: 'kept' })
  const targets = workChangeReviewTargets('work-task', [first, second, first], 'revert', 'turn')
  expect(changeIdsOf(targets)).toEqual(['first-write', 'second-write'])
  expect(targets.filter(item => item.id === 'second-write')).toHaveLength(1)
})

test('本轮确认只绑定当时的原始记录，增加或删除记录、改变状态和磁盘版本都会使确认过期', () => {
  const original = row('current', { seq: 1, turnId: 'turn-current', oldHash: 'before', newHash: 'after' })
  const identity = (changes: EngineFileChange[]): string =>
    workChangeReviewIdentity(workChangeReviewTargets('work-task', changes, 'revert', 'turn'))
  const initial = identity([original])
  for (const patch of [
    { id: 'replacement' }, { sessionId: 'other' }, { status: 'kept' as const }, { status: 'reverted' as const },
    { path: 'D:/work/other.html' }, { oldHash: 'different-before' }, { newHash: 'later' }, { seq: 2 }
  ]) expect(identity([{ ...original, ...patch }])).not.toBe(initial)
  expect(identity([])).not.toBe(initial)
  expect(identity([original, row('late-receipt')])).not.toBe(initial)
  expect(identity([original, row('second')])).toBe(identity([row('second'), original]))
})

test('确认期间补齐并发编辑风险或改变归属证据，必须重新展示确认范围与提示', () => {
  const original = row('current', { turnId: 'turn-current', runId: 'run-current', toolCallId: 'tool-current' })
  const initial = workChangeReviewIdentity([original])
  for (const patch of [
    { requiresExplicitRevert: true }, { turnId: 'other-turn' }, { runId: 'other-run' }, { toolCallId: 'other-tool' }
  ]) expect(workChangeReviewIdentity([{ ...original, ...patch }])).not.toBe(initial)
})

test('确认期间更换目标身份、状态、版本、路径或净变化链都会使原确认过期', () => {
  const original = row('first', { seq: 1, oldHash: 'old-hash', newHash: 'new-hash', changeIds: ['first'] })
  const identity = workChangeReviewIdentity([original])
  for (const patch of [
    { id: 'second' }, { status: 'kept' as const }, { sessionId: 'other' }, { path: 'D:/elsewhere.txt' },
    { newHash: 'later-hash' }, { seq: 2 }, { changeIds: ['first', 'second'] }
  ]) expect(workChangeReviewIdentity([{ ...original, ...patch }])).not.toBe(identity)
  expect(workChangeReviewIdentity([original, row('second')])).toBe(workChangeReviewIdentity([row('second'), original]))
})
