import type { EngineSnapshot } from '@shared/ipc'
import type { EngineDiagnostics, EngineHealthDiagnostics, EngineStorageSnapshot } from '@shared/engine-diagnostics'

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

export function usableResourceNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Unsupported counters stay distinct from a genuine idle sample. */
export function formatResourceBytes(value: number | null | undefined): string {
  if (!usableResourceNumber(value)) return '不可用'
  const unit =
    value === 0
      ? 0
      : Math.max(0, Math.min(BINARY_UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024))))
  const amount = value / 1024 ** unit
  const digits = unit === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2
  return `${Number(amount.toFixed(digits))} ${BINARY_UNITS[unit]}`
}

export function formatResourceRate(value: number | null | undefined): string {
  return usableResourceNumber(value) ? `${formatResourceBytes(value)}/s` : '不可用'
}

export function formatResourcePercent(value: number | null | undefined): string {
  return usableResourceNumber(value) ? `${value.toFixed(1)}%` : '不可用'
}

export function resourceFraction(
  used: number | null | undefined,
  total: number | null | undefined
): number | null {
  if (!usableResourceNumber(used) || !usableResourceNumber(total) || total === 0) return null
  return Math.min(100, Math.max(0, (used / total) * 100))
}

export function formatResourceTimestamp(value: number | null | undefined): string {
  if (!usableResourceNumber(value) || value === 0) return '尚未采样'
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}

export function resourceSampleIsStale(
  sampledAt: number | null | undefined,
  now: number,
  limitMs = 20_000
): boolean {
  return (
    !usableResourceNumber(sampledAt) ||
    sampledAt === 0 ||
    !usableResourceNumber(now) ||
    now - sampledAt > limitMs
  )
}

export function engineDiagnosticsIdentity(
  snapshot: Pick<
    EngineSnapshot,
    'mode' | 'baseUrl' | 'instanceId' | 'accountId' | 'pid' | 'dataDir'
  >
): string {
  return JSON.stringify([
    snapshot.mode,
    snapshot.baseUrl,
    snapshot.instanceId ?? null,
    snapshot.accountId ?? null,
    snapshot.pid,
    snapshot.dataDir ?? null
  ])
}

/** Heartbeat freshness uses the last successful identity-checked probe, never
 * an unrelated snapshot update or the time at which the monitor was opened. */
export function healthProbeFreshness(
  health: EngineHealthDiagnostics | null | undefined,
  now: number
): { state: 'fresh' | 'stale' | 'unknown'; label: string; ageMs: number | null } {
  if (!health || !usableResourceNumber(health.lastSuccessAt) || health.lastSuccessAt === 0 ||
    !usableResourceNumber(now)) return { state: 'unknown', label: '尚无成功检查', ageMs: null }
  const ageMs = Math.max(0, now - health.lastSuccessAt)
  const budget = usableResourceNumber(health.checkIntervalMs) && usableResourceNumber(health.failureThreshold)
    ? health.checkIntervalMs * health.failureThreshold : 0
  const stale = ageMs > Math.max(20_000, budget)
  const seconds = Math.floor(ageMs / 1000)
  const age = seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`
  return { state: stale ? 'stale' : 'fresh', label: stale ? `${age} · 已过期` : age, ageMs }
}

export function presentResourceHealth(
  snapshot: Pick<EngineSnapshot, 'phase'> & Partial<Pick<EngineSnapshot, 'mode'>>,
  diagnostics:
    | (Pick<EngineDiagnostics, 'health'> & {
        resources?: Pick<EngineDiagnostics['resources'], 'state'>
      })
    | null,
  now: number,
  failed: boolean
): { label: string; state: 'ok' | 'warning' | 'error' | 'unknown' } {
  if (snapshot.phase === 'error') return { label: '连接异常', state: 'error' }
  if (snapshot.phase !== 'ready')
    return { label: snapshot.phase === 'starting' ? '正在启动' : '引擎未就绪', state: 'unknown' }
  if (!diagnostics)
    return { label: failed ? '采样失败' : '正在采样', state: failed ? 'warning' : 'unknown' }
  const health = diagnostics.health
  if (health.consecutiveFailures >= health.failureThreshold && health.failureThreshold > 0)
    return { label: '健康检查失败', state: 'error' }
  if (health.consecutiveFailures > 0) return { label: '健康检查异常', state: 'warning' }
  if (failed || healthProbeFreshness(health, now).state !== 'fresh')
    return { label: '健康数据过期', state: 'warning' }
  // A remote engine cannot expose this machine's OS process counters. That
  // boundary does not imply a failed connection heartbeat.
  if (diagnostics.resources?.state === 'unavailable' && snapshot.mode !== 'remote')
    return { label: '资源遥测不可用', state: 'warning' }
  return { label: '响应正常', state: 'ok' }
}

const STORAGE_LABELS: Readonly<Record<string, string>> = {
  database: '数据库',
  databases: '数据库',
  sqlite: '数据库',
  logs: '日志',
  log: '日志',
  history: '会话历史',
  sessions: '会话历史',
  conversations: '会话历史',
  artifacts: '产物与附件',
  attachments: '附件',
  uploads: '上传附件',
  workspaces: '任务工作区',
  workspace: '任务工作区',
  cache: '缓存',
  caches: '缓存',
  runtime: '引擎运行时',
  runtimes: '引擎运行时',
  memory: '长期记忆',
  config: '配置',
  other: '其他文件',
  unknown: '未分类文件'
}

export function storageCategoryLabel(value: string): string {
  return STORAGE_LABELS[value.toLowerCase()] || value
}

/** The bar uses physical bytes only; mixed SQLite records are never split by guesswork. */
export function storageCategorySegments(
  storage: EngineStorageSnapshot
): Array<{ category: string; bytes: number; files: number; percent: number }> {
  const rows = storage.categories.filter(
    (row) =>
      typeof row.category === 'string' &&
      usableResourceNumber(row.bytes) &&
      usableResourceNumber(row.files)
  )
  const sum = rows.reduce((total, row) => total + row.bytes, 0)
  const denominator = Math.max(
    usableResourceNumber(storage.totalBytes) ? storage.totalBytes : 0,
    sum
  )
  return rows.map((row) => ({
    ...row,
    percent: denominator > 0 ? (row.bytes / denominator) * 100 : 0
  }))
}
