/** P1 probe contracts built from the current implementation: real heartbeat
 * freshness, remote telemetry boundaries, and late account/transport fencing. */
import { expect, test } from '@playwright/test'
import { isHealthProbeCurrent } from '../src/main/engine/health-probe'
import { healthProbeFreshness, presentResourceHealth } from '../src/renderer/src/contrib/work/engine-resource-presentation'
import type { EngineHealthDiagnostics } from '../src/shared/engine-diagnostics'

const health: EngineHealthDiagnostics = {
  source: 'desktop-http-probe', lastSuccessAt: 50_000, lastCheckedAt: 50_000,
  lastLatencyMs: 12, consecutiveFailures: 0, checkIntervalMs: 5_000,
  failureThreshold: 3, timeoutMs: 3_000, checking: false, activeStreams: 0
}

test('心跳新鲜度仅由已确认成功的连接检查决定', () => {
  expect(healthProbeFreshness(health, 55_100)).toEqual({ state: 'fresh', label: '5 秒前', ageMs: 5_100 })
  expect(healthProbeFreshness(health, 70_000).state).toBe('fresh')
  expect(healthProbeFreshness({ ...health, lastCheckedAt: 71_000 }, 71_000)).toEqual({ state: 'stale', label: '21 秒前 · 已过期', ageMs: 21_000 })
  expect(healthProbeFreshness({ ...health, lastSuccessAt: null }, 71_000).state).toBe('unknown')
  expect(healthProbeFreshness(health, 49_000).ageMs).toBe(0)
})

test('远端 OS 计数不可用与连接健康分别呈现', () => {
  const diagnostics = { health, resources: { state: 'unavailable' as const } }
  expect(presentResourceHealth({ phase: 'ready', mode: 'remote' }, diagnostics, 55_000, false)).toEqual({ state: 'ok', label: '响应正常' })
  expect(presentResourceHealth({ phase: 'ready', mode: 'embedded' }, diagnostics, 55_000, false)).toEqual({ state: 'warning', label: '资源遥测不可用' })
  expect(presentResourceHealth({ phase: 'ready', mode: 'remote' }, diagnostics, 75_000, false)).toEqual({ state: 'warning', label: '健康数据过期' })
  expect(presentResourceHealth({ phase: 'ready', mode: 'remote' }, { ...diagnostics, health: { ...health, consecutiveFailures: 3 } }, 55_000, false).state).toBe('error')
})

test('同一代引擎切换账号或 transport 后拒绝旧健康检查的结果', () => {
  const snapshot = { phase: 'ready' as const, mode: 'remote' as const, baseUrl: 'http://127.0.0.1:12323', instanceId: 'one', accountId: 'alice' }
  const transport = new AbortController()
  const lease = { generation: 7, transport, snapshot }
  expect(isHealthProbeCurrent(lease, 7, transport, snapshot)).toBe(true)
  expect(isHealthProbeCurrent(lease, 7, new AbortController(), snapshot)).toBe(false)
  expect(isHealthProbeCurrent(lease, 7, transport, { ...snapshot, accountId: 'bob' })).toBe(false)
  expect(isHealthProbeCurrent(lease, 7, transport, { ...snapshot, instanceId: 'two' })).toBe(false)
  expect(isHealthProbeCurrent(lease, 7, transport, { ...snapshot, baseUrl: 'http://127.0.0.1:12401' })).toBe(false)
  expect(isHealthProbeCurrent(lease, 8, transport, snapshot)).toBe(false)
  expect(isHealthProbeCurrent(lease, 7, transport, { ...snapshot, phase: 'starting' })).toBe(false)
  transport.abort()
  expect(isHealthProbeCurrent(lease, 7, transport, snapshot)).toBe(false)
})
