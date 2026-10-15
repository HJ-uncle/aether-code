/** Pure presentation contracts: unavailable resource counters, binary units,
 * rate/percentage semantics and freshness; no Electron or OS resource mocks. */
import { expect, test } from '@playwright/test'
import {
  formatResourceBytes,
  formatResourcePercent,
  formatResourceRate,
  engineDiagnosticsIdentity,
  presentResourceHealth,
  resourceFraction,
  resourceSampleIsStale,
  storageCategoryLabel,
  storageCategorySegments,
  usableResourceNumber
} from '../src/renderer/src/contrib/work/engine-resource-presentation'
import type { EngineDiagnostics, EngineStorageSnapshot } from '../src/shared/engine-diagnostics'

test('不可用计数器与真实零消耗分开显示', () => {
  for (const invalid of [undefined, null, -1, NaN, Infinity]) {
    expect(formatResourceBytes(invalid)).toBe('不可用')
    expect(formatResourceRate(invalid)).toBe('不可用')
    expect(formatResourcePercent(invalid)).toBe('不可用')
  }
  expect(formatResourceBytes(0)).toBe('0 B')
  expect(formatResourceRate(0)).toBe('0 B/s')
  expect(formatResourcePercent(0)).toBe('0.0%')
  expect(usableResourceNumber('100')).toBe(false)
})

test('内存与 IO 单位使用二进制容量且不会因四舍五入丢失小样本', () => {
  expect(formatResourceBytes(1)).toBe('1 B')
  expect(formatResourceBytes(0.5)).toBe('1 B')
  expect(formatResourceBytes(1536)).toBe('1.5 KiB')
  expect(formatResourceBytes(256 * 1024 ** 2)).toBe('256 MiB')
  expect(formatResourceBytes(5.25 * 1024 ** 3)).toBe('5.25 GiB')
  expect(formatResourceRate(2 * 1024 ** 2)).toBe('2 MiB/s')
})

test('总量缺失不产生比例，容量条仅作可视范围限制', () => {
  expect(resourceFraction(null, 100)).toBeNull()
  expect(resourceFraction(50, 0)).toBeNull()
  expect(resourceFraction(50, 100)).toBe(50)
  expect(resourceFraction(200, 100)).toBe(100)
  // A single-core-normalized process counter may legitimately exceed 100%.
  expect(formatResourcePercent(220.75)).toBe('220.8%')
})

test('超过四个采样周期标为过期，缺样本不能显示健康', () => {
  expect(resourceSampleIsStale(undefined, 100_000)).toBe(true)
  expect(resourceSampleIsStale(80_000, 100_000)).toBe(false)
  expect(resourceSampleIsStale(79_999, 100_000)).toBe(true)
  expect(resourceSampleIsStale(100_001, 100_000)).toBe(false)
})

test('健康指示根据真实探针的新鲜度与连续失败判定', () => {
  const health: EngineDiagnostics['health'] = {
    lastSuccessAt: 90_000,
    lastCheckedAt: 90_000,
    lastLatencyMs: 5,
    consecutiveFailures: 0,
    checkIntervalMs: 5000,
    failureThreshold: 3,
    activeStreams: 0
  }
  const diagnostics = { health }
  expect(presentResourceHealth({ phase: 'ready' }, diagnostics, 100_000, false)).toEqual({
    label: '响应正常',
    state: 'ok'
  })
  expect(presentResourceHealth({ phase: 'ready' }, diagnostics, 111_000, false).state).toBe(
    'warning'
  )
  expect(presentResourceHealth({ phase: 'ready' }, diagnostics, 100_000, true).state).toBe(
    'warning'
  )
  expect(
    presentResourceHealth(
      { phase: 'ready' },
      { ...diagnostics, health: { ...health, consecutiveFailures: 1 } },
      100_000,
      false
    ).label
  ).toBe('健康检查异常')
  expect(
    presentResourceHealth(
      { phase: 'ready' },
      { ...diagnostics, health: { ...health, consecutiveFailures: 3 } },
      100_000,
      false
    ).state
  ).toBe('error')
  expect(
    presentResourceHealth(
      { phase: 'ready' },
      { ...diagnostics, resources: { state: 'unavailable' } },
      100_000,
      false
    ).label
  ).toBe('资源遥测不可用')
  expect(presentResourceHealth({ phase: 'ready' }, null, 100_000, false).state).toBe('unknown')
  expect(presentResourceHealth({ phase: 'error' }, diagnostics, 100_000, false).state).toBe('error')
})

test('连接与进程身份变化得到不同诊断key', () => {
  const snapshot = {
    mode: 'embedded' as const,
    baseUrl: 'http://127.0.0.1:12323',
    instanceId: 'one',
    accountId: null,
    pid: 500,
    dataDir: null
  }
  expect(JSON.parse(engineDiagnosticsIdentity(snapshot))).toEqual([
    'embedded',
    snapshot.baseUrl,
    'one',
    null,
    500,
    null
  ])
  for (const update of [
    { instanceId: 'two' },
    { accountId: 'alice' },
    { pid: 600 },
    { mode: 'remote' as const },
    { baseUrl: 'http://other:12323' }
  ]) {
    expect(engineDiagnosticsIdentity({ ...snapshot, ...update })).not.toBe(
      engineDiagnosticsIdentity(snapshot)
    )
  }
})

test('存储条只使用实际容量，非法计数不参与也不伪拆会话', () => {
  const storage = {
    totalBytes: 100,
    categories: [
      { category: 'database', bytes: 75, files: 1 },
      { category: 'logs', bytes: 25, files: 2 },
      { category: 'bad', bytes: NaN, files: 1 }
    ]
  } as EngineStorageSnapshot
  expect(storageCategorySegments(storage)).toEqual([
    { category: 'database', bytes: 75, files: 1, percent: 75 },
    { category: 'logs', bytes: 25, files: 2, percent: 25 }
  ])
  expect(storageCategoryLabel('database')).toBe('数据库')
  expect(storageCategoryLabel('new-kind')).toBe('new-kind')
  const growing = {
    ...storage,
    categories: [
      { category: 'database', bytes: 100, files: 1 },
      { category: 'logs', bytes: 100, files: 2 }
    ]
  }
  expect(storageCategorySegments(growing).map((row) => row.percent)).toEqual([50, 50])
  expect(
    storageCategorySegments({
      ...storage,
      totalBytes: 0,
      categories: [{ category: 'logs', bytes: 0, files: 0 }]
    })[0].percent
  ).toBe(0)
})
