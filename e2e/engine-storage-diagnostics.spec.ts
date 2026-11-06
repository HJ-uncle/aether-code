/** Isolated storage IPC payload contracts: real read-only SQLite subprocess,
 * file classification, older runtime fallback, partial output and no content disclosure. */
import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { EngineDiagnosticsCollector } from '../src/main/engine/diagnostics'
import { parseSqliteStorageProbe, readSqliteStorage } from '../src/main/engine/storage-sqlite-diagnostics'
import type { EngineSnapshot } from '../src/shared/ipc'

const execute = promisify(execFile)
const fixtureRoot = resolve(__dirname, '..', '.e2e-tmp')
let fixture = ''
test.beforeEach(() => { mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'storage-detail-')) })
test.afterEach(() => {
  if (dirname(fixture) !== fixtureRoot || !fixture.startsWith(fixtureRoot + '\\') && !fixture.startsWith(fixtureRoot + '/')) throw new Error('Unsafe fixture cleanup')
  rmSync(fixture, { recursive: true, force: true, maxRetries: 4 })
})
function snapshot(database: string): EngineSnapshot {
  return { mode: 'embedded', phase: 'ready', baseUrl: 'http://127.0.0.1:1', port: 1, pid: null, adopted: false,
    entryPath: null, runtimeSource: 'dev-sibling', version: 'test', dataDir: database, error: null, updatedAt: 1 }
}
test('SQLite probe reports physical table/index pages and freelist without modifying database or exposing rows', async () => {
  const database = join(fixture, 'agent.db')
  await execute(process.execPath, ['--input-type=module', '--eval', `
    import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]);
    db.exec("CREATE TABLE conversations(id INTEGER PRIMARY KEY,body TEXT); CREATE INDEX body_lookup ON conversations(body); CREATE TABLE collaboration_history_maintenance(state TEXT,payload_json TEXT)");
    const insert=db.prepare('INSERT INTO conversations(body) VALUES(?)');
    for(let i=0;i<80;i++)insert.run('PRIVATE-CONTENT-'+i+'x'.repeat(8000));
    db.exec("DELETE FROM conversations WHERE id>10; INSERT INTO collaboration_history_maintenance VALUES('pending','PRIVATE-SEED'),('committed','PRIVATE-SEED'),('committed','PRIVATE-SEED'),('invalidated','PRIVATE-SEED')"); db.close();
  `, database], { windowsHide: true })
  const digest = (): string => createHash('sha256').update(readFileSync(database)).digest('hex')
  const before = digest(), files = readdirSync(fixture)
  const value = await readSqliteStorage(snapshot(database))
  expect(value.state, value.reason).toBe('available')
  expect(value.partial, value.partialReasons.join(';')).toBe(false)
  expect(value.pageSize).toBeGreaterThan(0)
  expect(value.freelistPages).toBeGreaterThan(0)
  expect(value.freeBytes).toBe(value.pageSize! * value.freelistPages!)
  expect(value.objects.some(item => item.kind === 'table' && item.name === 'conversations' && item.bytes > 0)).toBe(true)
  expect(value.objects.some(item => item.kind === 'index' && item.name === 'body_lookup' && item.tableName === 'conversations' && item.bytes > 0)).toBe(true)
  expect(value.maintenance).toEqual({ pending: 1, committed: 2, invalidated: 1, other: 0 })
  expect(JSON.stringify(value)).not.toContain('PRIVATE-')
  expect(digest()).toBe(before)
  expect(readdirSync(fixture)).toEqual(files)
})
test('physical files distinguish WAL/SHM, JSONL, backups, markers, blobs and audit archive without counting sessions', async () => {
  const rows: Array<[string, number]> = [
    ['agent.db', 10], ['agent.db-wal', 11], ['agent.db-shm', 12], ['sessions/tenant/a.jsonl', 13],
    ['sessions/tenant/a.jsonl.1.bak', 14], ['sessions/tenant/a.migrated', 15], ['blobs/a.bin', 16],
    ['audit-archive/a.bin', 17], ['change-snapshots/a.bin', 18], ['memory/memory.db', 19], ['history-cold/a.bin', 20],
    ['agent.db.subagent-payloads/tenant/ab/payload.json', 21]
  ]
  for (const [file, size] of rows) { const target = join(fixture, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.alloc(size)) }
  const collector = new EngineDiagnosticsCollector()
  const value = await collector.getStorage(snapshot(join(fixture, 'agent.db')))
  expect(value.totalBytes).toBe(rows.reduce((sum, row) => sum + row[1], 0))
  expect(value.files).toBe(12)
  expect(Object.fromEntries(value.categories.map(row => [row.category, row.bytes]))).toEqual({
    database: 10, 'database-wal': 11, 'database-shm': 12, 'history-jsonl': 13, 'history-backups': 14,
    'history-markers': 15, blobs: 37, 'audit-archive': 17, snapshots: 18, memory: 19, 'history-cold': 20
  })
  expect(value.sqlite?.state).toBe('unavailable')
  expect((await collector.getStorage(snapshot(join(fixture, 'agent.db')))).cached).toBe(true)
  expect((await collector.getStorage(snapshot(join(fixture, 'agent.db')), true)).cached).toBe(false)
})

test('subagent payload classification follows the selected database without absorbing lookalike paths', async () => {
  const rows: Array<[string, number]> = [
    ['custom.sqlite', 10], ['custom.sqlite.subagent-payloads/tenant/ab/payload.jsonl', 21],
    ['agent.db.subagent-payloads/tenant/payload.json', 22], ['custom.sqlite.subagent-payloads-old/payload.json', 23],
    ['nested/custom.sqlite.subagent-payloads/payload.json', 24]
  ]
  for (const [file, size] of rows) { const target = join(fixture, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.alloc(size)) }
  const value = await new EngineDiagnosticsCollector().getStorage(snapshot(join(fixture, 'custom.sqlite')))
  expect(value.totalBytes).toBe(100)
  expect(value.files).toBe(5)
  expect(Object.fromEntries(value.categories.map(row => [row.category, row.bytes]))).toEqual({ database: 10, blobs: 21, other: 69 })
})
test('older runtime and partial filesystem scans keep unavailable distinct from zero', async () => {
  const database = join(fixture, 'agent.db'); writeFileSync(database, Buffer.alloc(10))
  const old = await readSqliteStorage({ ...snapshot(database), runtimeSource: 'imported', entryPath: join(fixture, 'old', 'dist', 'main.js') })
  expect(old.state).toBe('unavailable'); expect(old.pageCount).toBeNull(); expect(old.reason).toBeTruthy()
  const partial = await new EngineDiagnosticsCollector({ storageLimits: { entries: 0 } }).getStorage(snapshot(database))
  expect(partial.partial).toBe(true); expect(partial.partialReasons).toContain('文件条目达到采集上限')
})
test('a truncated child response retains its last complete metadata sample and rejects arbitrary output', () => {
  const sample = { state: 'available', sampledAt: 100, durationMs: 2, partial: true, partialReasons: [], pageSize: 4096, pageCount: 20, freelistPages: 3, freeBytes: 12288, objects: [], maintenance: null }
  expect(parseSqliteStorageProbe(JSON.stringify(sample) + '\n{"state":')).toMatchObject(sample)
  expect(parseSqliteStorageProbe('sensitive stderr is not a diagnostic')).toBeNull()
})
