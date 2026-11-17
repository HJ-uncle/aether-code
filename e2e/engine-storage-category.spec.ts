/** Isolated disk scan: command bodies are visible separately from SQLite and shared blobs. */
import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EngineDiagnosticsCollector } from '../src/main/engine/diagnostics'
import { storageCategoryLabel } from '../src/renderer/src/features/monitoring/engine-resource-presentation'
import type { EngineSnapshot } from '../src/shared/ipc'

test('command sidecar is counted as disk logs and explicit refresh replaces the cached sample', async () => {
  const root = path.resolve('.e2e-tmp/command-storage/diagnostics')
  await mkdir(root, { recursive: true })
  const fixture = await mkdtemp(path.join(root, 'scan-'))
  const database = path.join(fixture, 'agent.db')
  await writeFile(database, Buffer.alloc(100))
  const log = path.join(fixture, 'agent.db.command-output/tenant/session/job.log')
  await mkdir(path.dirname(log), { recursive: true })
  await writeFile(log, Buffer.alloc(65536))
  const snapshot: EngineSnapshot = { mode: 'embedded', phase: 'ready', baseUrl: '', port: null, pid: null,
    adopted: false, entryPath: null, runtimeSource: null, version: null, dataDir: database, error: null, updatedAt: 1 }
  let probes = 0
  const collector = new EngineDiagnosticsCollector({ readSqlite: async () => {
    probes++
    return { state: 'unavailable', reason: 'isolated scan fixture', sampledAt: null, durationMs: 0, partial: false,
      partialReasons: [], pageSize: null, pageCount: null, freelistPages: null, freeBytes: null, objects: [], maintenance: null }
  } })
  const first = await collector.getStorage(snapshot)
  expect(first.categories).toContainEqual({ category: 'command-logs', files: 1, bytes: 65536 })
  expect(first.totalBytes).toBe(65636)
  expect(storageCategoryLabel('command-logs')).toBe('命令日志（磁盘）')
  await writeFile(log, Buffer.alloc(131072))
  const cached = await collector.getStorage(snapshot)
  expect(cached.cached).toBe(true)
  expect(cached.totalBytes).toBe(65636)
  expect(probes).toBe(1)
  const refreshed = await collector.getStorage(snapshot, true)
  expect(refreshed.cached).toBe(false)
  expect(refreshed.categories).toContainEqual({ category: 'command-logs', files: 1, bytes: 131072 })
  expect(probes).toBe(2)
})
