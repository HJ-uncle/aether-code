/** Pure process-tree contract tests: descendants, PID reuse and stable rows. */
import { expect, test } from '@playwright/test'
import {
  calculateProcessTreeMetrics,
  EngineDiagnosticsCollector,
  parseWindowsProcessTree,
  type EngineProcessTreeEntry
} from '../src/main/engine/diagnostics'
import type { EngineSnapshot } from '../src/shared/ipc'

function rawProcess(
  pid: number,
  parentPid: number,
  name: string,
  cpuTicks: number,
  identity = `2026-10-15T00:00:00.000Z`
): Record<string, unknown> {
  return {
    pid,
    parentPid,
    identity,
    cpuTicks: String(cpuTicks),
    rssBytes: '1000',
    privateBytes: '800',
    readBytes: '100',
    writeBytes: '200',
    name,
    command: `C:\\runtime\\${name}`
  }
}

function snapshot(): EngineSnapshot {
  return {
    mode: 'embedded',
    phase: 'ready',
    baseUrl: 'http://127.0.0.1:12323',
    port: 12323,
    pid: 10,
    adopted: false,
    entryPath: null,
    runtimeSource: 'dev-sibling',
    version: '2',
    dataDir: null,
    instanceId: 'tree-test',
    error: null,
    updatedAt: 0
  }
}

function entry(overrides: Partial<EngineProcessTreeEntry> = {}): EngineProcessTreeEntry {
  return {
    pid: 10,
    parentPid: null,
    identity: '2026-10-15T00:00:00.000Z',
    cpuTimeMs: 10,
    rssBytes: 1000,
    privateBytes: 800,
    readBytes: 100,
    writeBytes: 200,
    name: 'engine.exe',
    command: 'C:\\runtime\\engine.exe',
    ...overrides
  }
}

test('process tree parser keeps only descendants and marks malformed rows partial', () => {
  const tree = parseWindowsProcessTree(
    [
      rawProcess(30, 999, 'unrelated.exe', 10),
      rawProcess(10, 1, 'engine.exe', 10),
      rawProcess(12, 10, 'worker.exe', 20),
      { ...rawProcess(13, 10, 'broken.exe', 30), rssBytes: 'unknown' },
      rawProcess(14, 12, 'tool.exe', 40)
    ],
    10
  )
  expect(tree.partial).toBe(true)
  expect(tree.processes.map((process) => process.pid)).toEqual([10, 12, 14])
  expect(() => parseWindowsProcessTree([rawProcess(12, 1, 'other.exe', 10)], 10)).toThrow(
    'PROCESS_QUERY_INVALID'
  )
  const rootAfterBound = parseWindowsProcessTree(
    [
      ...Array.from({ length: 256 }, (_, index) => rawProcess(1_000 + index, 999, 'noise.exe', 1)),
      rawProcess(10, 1, 'engine.exe', 10)
    ],
    10
  )
  expect(rootAfterBound.processes.map((process) => process.pid)).toEqual([10])
  expect(rootAfterBound.partial).toBe(true)
})

test('process tree metrics aggregate memory and use identity-aware deltas', () => {
  const first = {
    rootPid: 10,
    partial: false,
    processes: [
      entry(),
      entry({ pid: 12, parentPid: 10, name: 'worker.exe', cpuTimeMs: 20 }),
      entry({ pid: 14, parentPid: 12, name: 'tool.exe', cpuTimeMs: 30 })
    ]
  }
  const second = {
    ...first,
    processes: first.processes.map((process) => ({
      ...process,
      cpuTimeMs: process.cpuTimeMs + 100,
      rssBytes: process.rssBytes + 1
    }))
  }
  const firstSnapshot = calculateProcessTreeMetrics(first, undefined, 1000, 1000, 2)
  const baseline = {
    samples: new Map(first.processes.map((process) => [process.pid, process])),
    observedAt: 1000
  }
  const secondSnapshot = calculateProcessTreeMetrics(second, baseline, 3000, 3000, 3)
  expect(firstSnapshot.totals.memory.rssBytes).toBe(3000)
  expect(secondSnapshot.totals.cpu.percent).toBe(15)
  expect(secondSnapshot.processes.map((process) => process.pid)).toEqual([10, 12, 14])
  expect(secondSnapshot.processes.map((process) => process.depth)).toEqual([0, 1, 2])
  const reused = calculateProcessTreeMetrics(
    { ...second, processes: [entry({ identity: 'new-identity', cpuTimeMs: 999 })] },
    baseline,
    3000,
    3000,
    3
  )
  expect(reused.totals.cpu.percent).toBeNull()
})

test('collector coalesces process-tree probes with resource sampling', async () => {
  let calls = 0
  const sample = entry({ identity: 'engine' })
  const collector = new EngineDiagnosticsCollector({
    now: () => 1000,
    monotonic: () => 1000,
    readProcess: async () => ({
      pid: 10,
      identity: 'engine',
      cpuTimeMs: 10,
      rssBytes: 1000,
      privateBytes: 800,
      readBytes: null,
      writeBytes: null
    }),
    readProcessTree: async () => {
      calls += 1
      return { rootPid: 10, partial: false, processes: [sample] }
    }
  })
  const first = await collector.getResources(snapshot())
  expect(first.processTree.state).toBe('available')
  expect(first.processTree.processes).toHaveLength(1)
  expect(await collector.getResources(snapshot())).toMatchObject({
    processTree: { collection: { cached: true } }
  })
  expect(calls).toBe(1)
})

test('process-tree probes keep their fifteen-second cooldown when resources refresh faster', async () => {
  let now = 1_000
  let treeCalls = 0
  const sample = entry({ identity: 'engine' })
  const collector = new EngineDiagnosticsCollector({
    now: () => now,
    monotonic: () => now,
    readProcess: async () => ({
      pid: 10,
      identity: 'engine',
      cpuTimeMs: now / 10,
      rssBytes: 1000,
      privateBytes: 800,
      readBytes: null,
      writeBytes: null
    }),
    readProcessTree: async () => {
      treeCalls += 1
      return { rootPid: 10, partial: false, processes: [sample] }
    }
  })
  await collector.getResources(snapshot())
  expect(treeCalls).toBe(1)

  // The primary resource sample can refresh after five seconds, but the more
  // expensive process-tree walk remains cached until its own budget expires.
  now += 5_001
  const refreshed = await collector.getResources(snapshot())
  expect(treeCalls).toBe(1)
  expect(refreshed.processTree.collection.cached).toBe(true)

  now += 10_000
  const walked = await collector.getResources(snapshot())
  expect(treeCalls).toBe(2)
  expect(walked.processTree.collection.cached).toBe(false)
})
