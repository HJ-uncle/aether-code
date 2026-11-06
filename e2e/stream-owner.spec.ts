/** Pure transport ownership: Git invalidations cannot cross sessions/sources. */
import { expect, test } from '@playwright/test'
import { getStreamOwner, registerStreamOwner } from '../src/renderer/src/core/engine/stream-owner'

test('流所有权按引擎代际隔离并有界淘汰，重新登记保留最近流', () => {
  registerStreamOwner('first', { source: 10, sessionId: 'task-a', profile: 'general' })
  expect(getStreamOwner('first', 10)?.sessionId).toBe('task-a')
  expect(getStreamOwner('first', 11)).toBeUndefined()
  registerStreamOwner('next', { source: 11, sessionId: 'task-b', profile: 'code' })
  expect(getStreamOwner('first', 10)).toBeUndefined()
  for (let index = 0; index < 128; index++)
    registerStreamOwner(`stream-${index}`, { source: 11, sessionId: `task-${index}`, profile: 'general' })
  expect(getStreamOwner('next', 11)).toBeUndefined()
  registerStreamOwner('stream-0', { source: 11, sessionId: 'updated', profile: 'general' })
  registerStreamOwner('last', { source: 11, sessionId: 'task-last', profile: 'code' })
  expect(getStreamOwner('stream-0', 11)?.sessionId).toBe('updated')
  expect(getStreamOwner('stream-1', 11)).toBeUndefined()
})
