/** Current OS sampling contract, rate calculation, cooldown and bounded disk scans. No old UI fixture. */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { EngineSnapshot } from '../src/shared/ipc'
import {
  calculateProcessTreeMetrics,
  EngineDiagnosticsCollector,
  calculateProcessRates,
  parseWindowsProcessTree,
  parseWindowsProcessSample,
  type EngineProcessSample
} from '../src/main/engine/diagnostics'

const temporaryRoot = path.resolve('.e2e-tmp')
const fixtures: string[] = []
function fixture(): string {
  mkdirSync(temporaryRoot, { recursive: true })
  const root = mkdtempSync(path.join(temporaryRoot, 'engine-diagnostics-'))
  fixtures.push(root)
  return root
}
function snapshot(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    mode: 'embedded',
    phase: 'ready',
    baseUrl: 'http://127.0.0.1:12323',
    port: 12323,
    pid: 123,
    adopted: false,
    entryPath: null,
    runtimeSource: 'dev-sibling',
    version: '2',
    dataDir: null,
    instanceId: 'test-engine',
    error: null,
    updatedAt: 0,
    ...overrides
  }
}
function sample(overrides: Partial<EngineProcessSample> = {}): EngineProcessSample {
  return {
    pid: 123,
    identity: 'creation-1',
    cpuTimeMs: 10,
    rssBytes: 1000,
    privateBytes: 800,
    readBytes: 100,
    writeBytes: 200,
    ...overrides
  }
}
test.afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    expect(path.relative(temporaryRoot, directory)).not.toMatch(/^\.\.|^[A-Za-z]:/)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CIM parser rejects a different PID and invalid counters instead of inventing zeroes', () => {
  const raw = {
    pid: 123,
    identity: 'creation',
    cpuTicks: '2500000',
    rssBytes: '4096',
    privateBytes: '2048',
    readBytes: '12345',
    writeBytes: '67890'
  }
  expect(parseWindowsProcessSample(raw, 123)).toEqual(
    sample({
      identity: 'creation',
      cpuTimeMs: 250,
      rssBytes: 4096,
      privateBytes: 2048,
      readBytes: 12345,
      writeBytes: 67890
    })
  )
  expect(() => parseWindowsProcessSample(raw, 999)).toThrow('PROCESS_QUERY_INVALID')
  expect(() => parseWindowsProcessSample({ ...raw, rssBytes: 'unknown' }, 123)).toThrow(
    'PROCESS_QUERY_INVALID'
  )
  expect(parseWindowsProcessSample({ ...raw, writeBytes: 'unknown' }, 123).writeBytes).toBeNull()
})

test('CPU and IO rates use elapsed intervals and never cross PID reuse or counter resets', () => {
  const prior = { sample: sample(), observedAt: 1000 }
  const next = sample({ cpuTimeMs: 510, readBytes: 2100, writeBytes: 4200 })
  expect(calculateProcessRates(next, prior, 3000)).toEqual({
    cpu: { percent: 25, intervalMs: 2000, normalization: 'one-logical-core' },
    readBytesPerSecond: 1000,
    writeBytesPerSecond: 2000
  })
  expect(calculateProcessRates(next, undefined, 3000).cpu.percent).toBeNull()
  expect(calculateProcessRates({ ...next, identity: 'different-creation' }, prior, 3000)).toEqual({
    cpu: { percent: null, intervalMs: null, normalization: 'one-logical-core' },
    readBytesPerSecond: null,
    writeBytesPerSecond: null
  })
  expect(
    calculateProcessRates({ ...next, readBytes: 5 }, prior, 3000).readBytesPerSecond
  ).toBeNull()
  expect(calculateProcessRates(next, prior, 1000).cpu.percent).toBeNull()
})

test('process tree parser keeps only descendants, marks malformed input and presents a stable order', () => {
  const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    pid: 123,
    parentPid: null,
    identity: 'creation-123',
    cpuTicks: '1000000',
    rssBytes: '100',
    privateBytes: '50',
    readBytes: '10',
    writeBytes: '20',
    name: 'engine.exe',
    command: 'engine.exe',
    ...overrides
  })
  const parsed = parseWindowsProcessTree(
    [
      record(),
      record({
        pid: 201,
        parentPid: 123,
        identity: 'creation-201',
        name: 'tool.exe',
        command: 'tool.exe'
      }),
      record({
        pid: 202,
        parentPid: 123,
        identity: 'creation-202',
        name: 'browser.exe',
        command: 'browser.exe'
      }),
      // This process is not a descendant and must never appear in the engine panel.
      record({
        pid: 900,
        parentPid: 999,
        identity: 'creation-900',
        name: 'unrelated.exe',
        command: 'unrelated.exe'
      }),
      { pid: 'invalid', parentPid: 123 }
    ],
    123
  )
  expect(parsed.processes.map((entry) => entry.pid)).toEqual([123, 201, 202])
  expect(parsed.partial).toBe(true)

  const first = calculateProcessTreeMetrics(parsed, undefined, 1_000, 1_000, 4)
  expect(first.processes.map((entry) => entry.pid)).toEqual([123, 202, 201])
  expect(first.processes.map((entry) => entry.depth)).toEqual([0, 1, 1])
  expect(first.totals).toMatchObject({
    count: 3,
    memory: { rssBytes: 300, privateBytes: 150 },
    cpu: { percent: null, intervalMs: null }
  })

  const next = parseWindowsProcessTree(
    [
      record({
        pid: 202,
        parentPid: 123,
        identity: 'creation-202',
        cpuTicks: '2000000',
        name: 'browser.exe',
        command: 'browser.exe'
      }),
      record({ pid: 123, cpuTicks: '2000000' }),
      record({
        pid: 201,
        parentPid: 123,
        identity: 'creation-201',
        cpuTicks: '2000000',
        name: 'tool.exe',
        command: 'tool.exe'
      })
    ],
    123
  )
  const second = calculateProcessTreeMetrics(
    next,
    {
      samples: new Map(
        first.processes.map((entry) => [
          entry.pid,
          {
            pid: entry.pid,
            parentPid: entry.parentPid,
            identity: entry.pid === 123 ? 'creation-123' : `creation-${entry.pid}`,
            cpuTimeMs: 100,
            rssBytes: entry.memory.rssBytes ?? 0,
            privateBytes: entry.memory.privateBytes,
            readBytes: entry.io.readBytes,
            writeBytes: entry.io.writeBytes,
            name: entry.name,
            command: entry.command
          }
        ])
      ),
      observedAt: 1_000
    },
    2_000,
    2_000,
    3
  )
  // A different OS enumeration order must not move rows; CPU uses the same
  // creation identity and therefore produces a real second-sample delta.
  expect(second.processes.map((entry) => entry.pid)).toEqual([123, 202, 201])
  expect(second.totals.cpu).toEqual({ percent: 30, intervalMs: 1000 })
  expect(second.totals.io.readBytesPerSecond).toBe(0)
})

test('resource collection coalesces requests and caches for five seconds without erasing the baseline', async () => {
  let now = 1000,
    calls = 0
  const collector = new EngineDiagnosticsCollector({
    now: () => now,
    monotonic: () => now,
    readProcess: async () => {
      calls += 1
      return sample({ cpuTimeMs: calls === 1 ? 100 : 700, readBytes: calls === 1 ? 100 : 12100 })
    }
  })
  const firstRequest = collector.getResources(snapshot())
  expect(collector.getResources(snapshot())).toBe(firstRequest)
  const first = await firstRequest
  expect(first.cpu.percent).toBeNull()
  now += 4999
  expect(await collector.getResources(snapshot())).toMatchObject({
    sampledAt: 1000,
    collection: { cached: true }
  })
  expect(calls).toBe(1)
  now += 1001
  const second = await collector.getResources(snapshot())
  expect(calls).toBe(2)
  expect(second.cpu).toMatchObject({ percent: 10, intervalMs: 6000 })
  expect(second.io.readBytesPerSecond).toBe(2000)
})

test('remote and stopped engines expose no client memory, disk or process readings', async () => {
  let calls = 0
  const collector = new EngineDiagnosticsCollector({
    readProcess: async () => {
      calls++
      return sample()
    }
  })
  for (const current of [snapshot({ mode: 'remote', pid: null }), snapshot({ phase: 'error' })]) {
    const resources = await collector.getResources(current)
    expect(resources.state).toBe('unavailable')
    expect(resources.hostMemory).toEqual({ totalBytes: null, availableBytes: null })
    expect(resources.disk).toEqual({ totalBytes: null, availableBytes: null, path: null })
  }
  expect(calls).toBe(0)
  expect((await collector.getStorage(snapshot({ mode: 'remote' }))).state).toBe('unavailable')
})

test('storage counts physical domains and ignores symlink/junction targets', async () => {
  const base = fixture(),
    root = path.join(base, 'state'),
    outside = path.join(base, 'outside')
  mkdirSync(path.join(root, 'sessions'), { recursive: true })
  mkdirSync(path.join(root, 'memory'))
  mkdirSync(outside)
  writeFileSync(path.join(root, 'agent.db'), Buffer.alloc(10))
  writeFileSync(path.join(root, 'agent.db-wal'), Buffer.alloc(3))
  writeFileSync(path.join(root, 'sessions', 'test.jsonl'), Buffer.alloc(20))
  writeFileSync(path.join(root, 'memory', 'memory.db'), Buffer.alloc(5))
  writeFileSync(path.join(outside, 'must-not-count.bin'), Buffer.alloc(10000))
  symlinkSync(
    outside,
    path.join(root, 'outside-link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const collector = new EngineDiagnosticsCollector()
  const storage = await collector.getStorage(snapshot({ dataDir: path.join(root, 'agent.db') }))
  expect(storage).toMatchObject({
    state: 'available',
    path: root,
    totalBytes: 38,
    files: 4,
    partial: false
  })
  expect(storage.categories).toEqual([
    { category: 'conversations', bytes: 20, files: 1 },
    { category: 'database', bytes: 13, files: 2 },
    { category: 'memory', bytes: 5, files: 1 }
  ])
  const redirected = path.join(base, 'redirected-state')
  symlinkSync(root, redirected, process.platform === 'win32' ? 'junction' : 'dir')
  expect(
    (await collector.getStorage(snapshot({ dataDir: path.join(redirected, 'agent.db') }))).state
  ).toBe('unavailable')
})

test('storage refresh obeys a sixty-second cooldown and never infers a directory from a missing database', async () => {
  const root = fixture(),
    database = path.join(root, 'agent.db')
  writeFileSync(database, Buffer.alloc(10))
  let now = 1000
  const collector = new EngineDiagnosticsCollector({ now: () => now })
  const first = collector.getStorage(snapshot({ dataDir: database }))
  expect(collector.getStorage(snapshot({ dataDir: database }))).toBe(first)
  expect((await first).totalBytes).toBe(10)
  writeFileSync(path.join(root, 'new.bin'), Buffer.alloc(20))
  now += 59999
  expect(await collector.getStorage(snapshot({ dataDir: database }), true)).toMatchObject({
    totalBytes: 10,
    cached: true,
    scannedAt: 1000
  })
  now += 1
  expect(await collector.getStorage(snapshot({ dataDir: database }), true)).toMatchObject({
    totalBytes: 30,
    cached: false,
    scannedAt: 61000
  })
  expect(
    (await collector.getStorage(snapshot({ dataDir: path.join(root, 'missing.db') }))).state
  ).toBe('unavailable')
  expect((await collector.getStorage(snapshot({ dataDir: root }))).state).toBe('unavailable')
})

test('storage entry and time budgets produce an explicit partial result', async () => {
  const root = fixture(),
    database = path.join(root, 'agent.db')
  writeFileSync(database, Buffer.alloc(10))
  for (let index = 0; index < 20; index++)
    writeFileSync(path.join(root, `file-${index}.bin`), Buffer.alloc(10))
  const byEntry = new EngineDiagnosticsCollector({ storageLimits: { entries: 2 } })
  expect(await byEntry.getStorage(snapshot({ dataDir: database }))).toMatchObject({
    state: 'available',
    partial: true,
    files: 2,
    totalBytes: 20
  })
  const byTime = new EngineDiagnosticsCollector({ storageLimits: { durationMs: 0 } })
  expect(await byTime.getStorage(snapshot({ dataDir: database }))).toMatchObject({
    state: 'available',
    partial: true,
    files: 0,
    totalBytes: 0
  })
})

test('a failed process measurement leaves an independent storage measurement usable', async () => {
  const root = fixture(),
    database = path.join(root, 'agent.db')
  writeFileSync(database, Buffer.alloc(7))
  const collector = new EngineDiagnosticsCollector({
    readProcess: async () => {
      throw new Error('private subprocess diagnostic')
    }
  })
  const current = snapshot({ dataDir: database })
  const [resources, storage] = await Promise.all([
    collector.getResources(current),
    collector.getStorage(current)
  ])
  expect(resources.state).toBe('unavailable')
  expect(JSON.stringify(resources)).not.toContain('private subprocess diagnostic')
  expect(storage).toMatchObject({ state: 'available', totalBytes: 7, files: 1 })
})

test('Windows reads actual single-process metrics through CIM or a restricted-policy fallback', async () => {
  test.skip(process.platform !== 'win32', 'CIM is the Windows resource sampler')
  const root = fixture(),
    database = path.join(root, 'agent.db')
  writeFileSync(database, Buffer.alloc(16))
  const current = snapshot({ pid: process.pid, dataDir: database })
  const resources = await new EngineDiagnosticsCollector().getResources(current)
  // Hardened Windows sandboxes may deny Win32_Process even for the current
  // process. The contract must report that limitation while retaining host and
  // disk readings; a permitted host must expose the actual counters below.
  if (resources.state === 'unavailable') {
    expect(resources.reason).toContain('无法读取引擎进程资源')
    expect(resources.hostMemory.totalBytes).toBeGreaterThan(0)
    expect(resources.disk.totalBytes).toBeGreaterThan(0)
    return
  }
  expect(resources.state).toBe('available')
  expect(resources.pid).toBe(process.pid)
  expect(resources.memory.rssBytes).toBeGreaterThan(0)
  expect(resources.memory.privateBytes).toBeGreaterThan(0)
  // Get-Process fallback keeps CPU/RSS/private when CIM is denied; transfer
  // counters remain explicitly unavailable rather than being reported as zero.
  if (resources.io.readBytes !== null) expect(resources.io.readBytes).toBeGreaterThanOrEqual(0)
  expect(resources.hostMemory.totalBytes).toBeGreaterThan(0)
  expect(resources.disk.totalBytes).toBeGreaterThan(0)
  expect(resources.disk.availableBytes).toBeLessThanOrEqual(resources.disk.totalBytes!)
})
