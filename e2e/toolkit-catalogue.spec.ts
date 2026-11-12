/** Engine-owned toolkit discovery and successful, source-isolated resource invalidation. */
import { expect, test } from '@playwright/test'
import { WORK_TOOLKITS, MCP_MANAGEMENT_TOOLKIT, isToolkitId, isToolkitNameQuery, toolkitName, parseSessionToolkits, parseWorkToolkits } from '../src/shared/toolkits'
import { resourceCatalogueChange, notifyResourceCatalogueChanged, subscribeResourceCatalogueChanges } from '../src/renderer/src/core/engine/resource-catalogue'
import { getEngineSource, publishEngineSource } from '../src/renderer/src/core/engine/source'
import { remoteRequestError } from '../src/main/engine/protocol'
import { agentToolCategory } from '../src/renderer/src/contrib/work/work-agent-tool-groups'
import { toolDisplayName, mcpToolDisplayName } from '../src/renderer/src/core/engine/tool-labels'

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

test('MCP management is engine-advertised alongside plugin management and versioned plugins', () => {
  const mcp = { id: MCP_MANAGEMENT_TOOLKIT, name: 'MCP 管理', description: '配置和测试 MCP 服务', available: false,
    reason: '当前 Agent 没有 MCP 配置权限', toolNames: ['mcp_server_list', 'mcp_server_get', 'mcp_server_create', 'mcp_server_update', 'mcp_server_set_enabled', 'mcp_server_delete', 'mcp_server_test'] }
  const plugin = { id: 'plugin-document-reader--r3', name: '文档插件', description: '读取文档', available: true, toolNames: ['plugin_document_reader_read'] }
  expect(isToolkitId(MCP_MANAGEMENT_TOOLKIT)).toBe(true)
  expect(toolkitName(MCP_MANAGEMENT_TOOLKIT)).toBe('MCP 管理')
  const pluginManager = { ...WORK_TOOLKITS.find(item => item.id === 'plugin-management')!, available: true, toolNames: ['plugin_list'] }
  expect(parseWorkToolkits({ toolkits: [pluginManager, mcp, plugin] })).toEqual([pluginManager, mcp, plugin])
  expect(parseWorkToolkits({ toolkits: [pluginManager, plugin] }).some(item => item.id === MCP_MANAGEMENT_TOOLKIT)).toBe(false)
})

test('known toolkit labels keep their embedded spaces without trapping ordinary prose', () => {
  for (const query of ['MCP ', 'MCP 管', 'MCP 管理', 'mcp\u00a0管理', 'MCP\u3000管理', 'Agent 管理']) expect(isToolkitNameQuery(query), query).toBe(true)
  for (const query of ['MCP 管理完成', 'MCP 管理 ', '普通 文字', 'MCP\n管理', 'MCP @管理']) expect(isToolkitNameQuery(query), query).toBe(false)
})

test('only exact successful MCP configuration mutations refresh the catalogue', () => {
  const receipt = (name: string, action = 'update') => ({ name, success: true, metadata: { resourceChange: { kind: 'mcp', action, id: 'docs-service' } } })
  for (const action of ['create', 'update', 'set_enabled', 'delete']) {
    const result = receipt(`mcp_server_${action}`, action)
    expect(resourceCatalogueChange(result)).toEqual({ kind: 'mcp', action, id: 'docs-service' })
    expect(resourceCatalogueChange({ ...result, success: false })).toBeNull()
    expect(resourceCatalogueChange({ ...result, error: 'denied' })).toBeNull()
    expect(resourceCatalogueChange({ ...result, metadata: { resourceChange: { kind: 'mcp', action, id: '' } } })).toBeNull()
  }
  for (const name of ['mcp_server_list', 'mcp_server_get', 'mcp_server_test', 'mcp_server_search', 'mcp_server_update_extra', 'mcp_docs_update', 'mcp_server_call_tool', 'plugin_mcp_server_update']) {
    expect(resourceCatalogueChange(receipt(name)), name).toBeNull()
  }
  expect(resourceCatalogueChange(receipt('mcp_server_create', 'delete'))).toBeNull()
  expect(resourceCatalogueChange({ name: 'mcp_server_update', success: true, output: 'metadata.resourceChange' })).toBeNull()
})

test('MCP management tools have clear labels and remain distinct from external MCP tools', () => {
  for (const operation of ['list', 'get', 'create', 'update', 'set_enabled', 'delete', 'test']) {
    const id = `mcp_server_${operation}`
    expect(agentToolCategory({ id, source: 'builtin' })).toBe('mcp-management')
    expect(agentToolCategory({ id })).toBe('mcp-management')
    expect(agentToolCategory({ id, source: 'mcp' })).toBe('mcp')
    expect(toolDisplayName(id)).toContain('MCP')
  }
  expect(agentToolCategory({ id: 'mcp_docs_get', source: 'mcp' })).toBe('mcp')
  expect(agentToolCategory({ id: 'mcp_server_custom', source: 'builtin' })).toBe('mcp')
  expect(mcpToolDisplayName('server', 'mcp_server_update')).toBe('update')
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

test('MCP catalogue notifications do not cross engine sources or invalidate unrelated resources', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  const received: string[] = [], first = getEngineSource()
  const unsubscribe = subscribeResourceCatalogueChanges(['mcp'], change => received.push(change.id))
  const other = subscribeResourceCatalogueChanges(['plugin', 'skill'], change => received.push(`other:${change.id}`))
  const change = { kind: 'mcp' as const, action: 'update', id: 'mcp-current' }
  try {
    notifyResourceCatalogueChanged(change, first)
    notifyResourceCatalogueChanged({ ...change, id: 'mcp-stale' }, first + 1)
    expect(received).toEqual(['mcp-current'])
    publishEngineSource({ mode: 'remote', phase: 'ready', baseUrl: 'http://mcp-fixture.invalid', instanceId: 'replacement' })
    notifyResourceCatalogueChanged({ ...change, id: 'old-source' }, first)
    notifyResourceCatalogueChanged({ ...change, id: 'new-source-old-view' })
    expect(received).toEqual(['mcp-current'])
  } finally {
    unsubscribe(); other(); publishEngineSource({ mode: 'embedded', phase: 'idle', baseUrl: '' })
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
