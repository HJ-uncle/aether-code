import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import type { EngineSnapshot } from '../../shared/ipc'
import type { EngineSqliteStorageSnapshot } from '../../shared/engine-diagnostics'

/** An isolated read-only connection must never import engine startup code: that
 * would run migrations and recovery against the database being inspected. */
export const SQLITE_STORAGE_PROBE = String.raw`
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const state = { state: 'available', sampledAt: Date.now(), durationMs: 0, partial: true,
  partialReasons: [], pageSize: null, pageCount: null, freelistPages: null, freeBytes: null,
  objects: [], maintenance: null };
const started = Date.now(); let db;
const emit = () => { state.durationMs = Date.now() - started; output(state); };
try {
  const { lstatSync, openSync, readSync, closeSync } = await import('node:fs');
  const file = process.argv[1], info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 100) throw new Error('path');
  const descriptor = openSync(file, 'r'), header = Buffer.alloc(16);
  try { if (readSync(descriptor, header, 0, 16, 0) !== 16 || header.toString('binary') !== 'SQLite format 3\0') throw new Error('header'); }
  finally { closeSync(descriptor); }
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: false });
  db.exec('BEGIN');
  const scalar = (sql) => Number(Object.values(db.prepare(sql).get())[0]);
  state.pageSize = scalar('PRAGMA page_size');
  state.pageCount = scalar('PRAGMA page_count');
  state.freelistPages = scalar('PRAGMA freelist_count');
  state.freeBytes = state.pageSize * state.freelistPages;
  emit();
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='collaboration_history_maintenance'").get();
    if (exists) {
      const counts = { pending: 0, committed: 0, invalidated: 0, other: 0 };
      for (const row of db.prepare('SELECT state, count(*) AS count FROM collaboration_history_maintenance GROUP BY state').all()) {
        const key = ['pending','committed','invalidated'].includes(row.state) ? row.state : 'other';
        counts[key] += Number(row.count);
      }
      state.maintenance = counts;
    } else state.partialReasons.push('当前数据库没有历史维护收据表');
  } catch { state.partialReasons.push('历史维护收据统计不可用'); }
  emit();
  try {
    state.objects = db.prepare("SELECT d.name, COALESCE(s.type,'table') AS kind, COALESCE(s.tbl_name,d.name) AS tableName, SUM(d.pgsize) AS bytes, SUM(d.payload) AS payloadBytes, SUM(d.unused) AS unusedBytes FROM dbstat d LEFT JOIN sqlite_schema s ON s.name=d.name WHERE s.type IN ('table','index') OR s.type IS NULL GROUP BY d.name ORDER BY bytes DESC, d.name LIMIT 12").all();
  } catch { state.partialReasons.push('当前 SQLite 运行时不支持表和索引页统计'); }
  state.partial = state.partialReasons.length > 0;
  db.exec('ROLLBACK'); db.close(); db = undefined; emit();
} catch {
  if (state.pageSize === null) { state.state = 'unavailable'; state.reason = '当前运行时无法以只读方式读取 SQLite 明细'; }
  else state.partialReasons.push('SQLite 采集未完成');
  state.partial = true; emit();
} finally { if (db) try { db.close(); } catch {} }
`

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const empty = (reason: string): EngineSqliteStorageSnapshot => ({
  state: 'unavailable', reason, sampledAt: null, durationMs: 0, partial: true, partialReasons: [],
  pageSize: null, pageCount: null, freelistPages: null, freeBytes: null, objects: [], maintenance: null
})

/** Accept only bounded metadata. No schema SQL, row bodies, errors or process
 * stderr cross IPC, including when an older Node cannot load node:sqlite. */
export function parseSqliteStorageProbe(stdout: string): EngineSqliteStorageSnapshot | null {
  let last: EngineSqliteStorageSnapshot | null = null
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object') continue
      const row = value as Record<string, unknown>
      if (row.state !== 'available' && row.state !== 'unavailable') continue
      if (!count(row.sampledAt) || !count(row.durationMs) || !Array.isArray(row.objects) || row.objects.length > 12) continue
      const result = empty('当前运行时无法以只读方式读取 SQLite 明细')
      result.state = row.state
      result.sampledAt = row.sampledAt
      result.durationMs = row.durationMs
      result.partial = row.partial !== false
      result.partialReasons = Array.isArray(row.partialReasons) ? row.partialReasons.filter((item): item is string => typeof item === 'string' && item.length <= 100).slice(0, 8) : []
      for (const key of ['pageSize', 'pageCount', 'freelistPages', 'freeBytes'] as const) result[key] = count(row[key]) ? row[key] : null
      for (const item of row.objects) {
        if (!item || typeof item !== 'object') continue
        const object = item as Record<string, unknown>
        if (typeof object.name !== 'string' || object.name.length > 256 || typeof object.tableName !== 'string' || object.tableName.length > 256 ||
          !['table', 'index'].includes(String(object.kind)) || !count(object.bytes) || !count(object.payloadBytes) || !count(object.unusedBytes)) continue
        result.objects.push({ name: object.name, tableName: object.tableName, kind: object.kind === 'index' ? 'index' : 'table', bytes: object.bytes, payloadBytes: object.payloadBytes, unusedBytes: object.unusedBytes })
      }
      if (row.maintenance && typeof row.maintenance === 'object') {
        const maintenance = row.maintenance as Record<string, unknown>
        if (count(maintenance.pending) && count(maintenance.committed) && count(maintenance.invalidated) && count(maintenance.other))
          result.maintenance = { pending: maintenance.pending, committed: maintenance.committed, invalidated: maintenance.invalidated, other: maintenance.other }
      }
      if (result.state === 'available') delete result.reason
      last = result
    } catch { /* A killed collector may leave an incomplete final line. */ }
  }
  return last
}

export async function readSqliteStorage(snapshot: EngineSnapshot): Promise<EngineSqliteStorageSnapshot> {
  if (snapshot.mode !== 'embedded' || !snapshot.dataDir || !isAbsolute(snapshot.dataDir)) return empty('仅支持本地引擎的已确认数据库')
  const executable = (snapshot.runtimeSource === 'bundled' || snapshot.runtimeSource === 'imported') && snapshot.entryPath
    ? join(dirname(dirname(snapshot.entryPath)), 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' }
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']) if (process.env[key]) env[key] = process.env[key]
  return new Promise(resolve => {
    execFile(executable, ['--input-type=module', '--eval', SQLITE_STORAGE_PROBE, snapshot.dataDir!], {
      env, windowsHide: true, timeout: 2500, maxBuffer: 128 * 1024, encoding: 'utf8'
    }, (error, stdout) => {
      const result = parseSqliteStorageProbe(stdout) ?? empty('当前运行时不支持 SQLite 只读诊断，或数据库暂时不可读')
      if (error) {
        result.partial = true
        result.partialReasons.push(error.killed ? 'SQLite 采集达到时间预算，保留已完成统计' : 'SQLite 诊断进程未完成，保留已完成统计')
      }
      resolve(result)
    })
  })
}
