/** Engine-owned toolkit discovery and successful, source-isolated resource invalidation. */
import { expect, test } from '@playwright/test'
import { WORK_TOOLKITS, parseSessionToolkits, parseWorkToolkits } from '../src/shared/toolkits'
import { resourceCatalogueChange, notifyResourceCatalogueChanged, subscribeResourceCatalogueChanges } from '../src/renderer/src/core/engine/resource-catalogue'
import { getEngineSource, publishEngineSource } from '../src/renderer/src/core/engine/source'
import { remoteRequestError } from '../src/main/engine/protocol'

test('remote transport admits read-only discovery and session selectors without opening mutation routes', () => {
  for (const path of ['/toolkits', '/toolkits?sessionId=work-session&agentId=ignored', '/sessions/work-session/toolkits']) {
    expect(remoteRequestError('remote', 'GET', path)).toBeNull()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(remoteRequestError('remote', method, path)).not.toBeNull()
  }
  for (const path of ['/toolkits/private', '/sessions/work-session/toolkits/anything', '/sessions/toolkits', '/sessions/../toolkits']) {
    expect(remoteRequestError('remote', 'GET', path)).not.toBeNull()
  }
})

test('only valid known packages declared by the connected engine are visible', () => {
  for (const response of [null, {}, [], { toolkits: 'all' }, { toolkits: [] }]) expect(parseWorkToolkits(response)).toEqual([])
  const rows = WORK_TOOLKITS.map(toolkit => ({ ...toolkit, available: true, toolNames: [`${toolkit.id}_list`] }))
  rows[1] = { ...rows[1], available: false }
  const remote = parseWorkToolkits({ toolkits: [
    { ...rows[0], name: 'Untrusted override' }, { ...rows[1], reason: '此 Agent 无技能管理权限' }, rows[0],
    { id: 'unknown-package', available: true, toolNames: [] }, { ...rows[2], available: 'true' },
    { ...rows[3], toolNames: [42] }
  ] })
  expect(remote.map(item => item.id)).toEqual(['agent-management', 'skill-management'])
  expect(remote[0].name).toBe('Agent 管理')
  expect(remote[1]).toMatchObject({ available: false, reason: '此 Agent 无技能管理权限' })
  expect(parseWorkToolkits({ toolkits: rows }).map(item => item.id)).toEqual(WORK_TOOLKITS.map(item => item.id))
})

test('missing inherited selections cannot become an explicit empty selection', () => {
  for (const raw of [undefined, null, {}, { toolkits: null }, { toolkits: [''] }, { toolkits: [7] }]) expect(() => parseSessionToolkits(raw)).toThrow()
  expect(parseSessionToolkits({ toolkits: [] })).toEqual([])
  expect(parseSessionToolkits({ toolkits: ['skill-management', 'automation', 'skill-management'] })).toEqual(['skill-management', 'automation'])
})

test('resource changes require a successful management tool and matching structured receipt', () => {
  const receipt = (kind: string, name: string, action = 'create') => ({ name, success: true, metadata: { resourceChange: { kind, action, id: 'resource-1' } } })
  for (const [kind, prefix] of [['skill', 'skill'], ['knowledge', 'knowledge'], ['automation', 'cron']]) {
    for (const action of ['create', 'update', 'delete', 'set_enabled', 'import']) {
      const result = receipt(kind, `${prefix}_${action}`, action)
      expect(resourceCatalogueChange(result)).toEqual({ kind, action, id: 'resource-1' })
      expect(resourceCatalogueChange({ ...result, success: false })).toBeNull()
      expect(resourceCatalogueChange({ ...result, error: 'denied' })).toBeNull()
      expect(resourceCatalogueChange({ ...result, name: 'unrelated_extension' })).toBeNull()
    }
  }
  for (const result of [receipt('unknown', 'unknown_create'), receipt('automation', 'skill_create'), receipt('skill', 'skill_list', 'list'),
    { name: 'skill_create', success: true, output: 'resourceChange:skill/create' },
    { ...receipt('skill', 'skill_create'), metadata: { resourceChange: { kind: 'skill', action: 'create', id: '' } } }]) expect(resourceCatalogueChange(result)).toBeNull()
})

test('resource notifications stay in their captured engine generation and kind', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  const received: string[] = []
  const first = getEngineSource()
  const unsubscribe = subscribeResourceCatalogueChanges(['skill'], change => received.push(change.id))
  const change = { kind: 'skill' as const, action: 'update', id: 'valid' }
  try {
    notifyResourceCatalogueChanged(change, first)
    notifyResourceCatalogueChanged({ ...change, kind: 'automation', id: 'wrong-kind' }, first)
    notifyResourceCatalogueChanged({ ...change, id: 'wrong-source' }, first + 1)
    expect(received).toEqual(['valid'])
    publishEngineSource({ mode: 'remote', phase: 'ready', baseUrl: 'http://fixture.invalid', instanceId: 'new-source', accountId: 'test' })
    notifyResourceCatalogueChanged({ ...change, id: 'late-old-source' }, first)
    notifyResourceCatalogueChanged({ ...change, id: 'new-source-old-view' })
    expect(received).toEqual(['valid'])
    const newUnsubscribe = subscribeResourceCatalogueChanges(['skill'], next => received.push(next.id))
    notifyResourceCatalogueChanged({ ...change, id: 'new-source-view' })
    newUnsubscribe()
    expect(received).toEqual(['valid', 'new-source-view'])
  } finally {
    unsubscribe()
    publishEngineSource({ mode: 'embedded', phase: 'idle', baseUrl: '' })
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
