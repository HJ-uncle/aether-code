import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { EngineSnapshot } from '@shared/ipc'
import type { EngineDiagnostics } from '@shared/engine-diagnostics'
import { Icon } from '@renderer/workbench/icons'
import { getWorkbenchVisible, onWorkbenchVisibility } from '@renderer/core/platform/workbench-visibility'
import { EngineRuntimeHealth } from './EngineRuntimeHealth'
import {
  engineDiagnosticsIdentity,
  formatResourceBytes,
  formatResourcePercent,
  formatResourceRate,
  formatResourceTimestamp,
  healthProbeFreshness,
  presentResourceHealth,
  resourceFraction,
  resourceSampleIsStale,
  storageCategoryLabel,
  storageCategorySegments,
  usableResourceNumber
} from './engine-resource-presentation'
import './engine-resource-health.css'

const SAMPLE_INTERVAL_MS = 5_000
const STORAGE_REFRESH_MS = 60_000
const PROCESS_ROWS_LIMIT = 24

function processName(command: string, fallback: string): string {
  const normalized = command.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) || fallback
}

function formatProcessAge(ageMs: number | null): string {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return '—'
  const seconds = Math.floor(ageMs / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

function Metric({
  label,
  value,
  hint,
  detail
}: {
  label: string
  value: string
  hint: string
  detail?: string
}): JSX.Element {
  return (
    <article className="engine-resource__metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
      {detail ? <small>{detail}</small> : null}
    </article>
  )
}

/** Resource collection is main-process-owned. The renderer keeps one snapshot,
 * and an inactive/hidden page never creates process probes or directory scans. */
export function EngineResourceHealth({ snapshot }: { snapshot: EngineSnapshot }): JSX.Element {
  const identity = engineDiagnosticsIdentity(snapshot)
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostics | null>(null)
  const [error, setError] = useState<{ identity: string; message: string } | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [refreshingStorage, setRefreshingStorage] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [lastStorageRefresh, setLastStorageRefresh] = useState(0)
  const collect = useRef<(refreshStorage?: boolean) => Promise<void>>(async () => {})

  useEffect(() => {
    let alive = true
    let pending = false
    let timer: number | undefined
    const resetTimer = window.setTimeout(() => {
      if (!alive) return
      setDiagnostics(null)
      setError(null)
      setLastStorageRefresh(0)
      setCollecting(false)
      setRefreshingStorage(false)
    }, 0)
    // Remote diagnostics reuse the existing host heartbeat and return explicit
    // unavailable OS resources; they never inspect a local stand-in process.
    if (snapshot.phase !== 'ready') {
      collect.current = async () => {}
      return () => {
        alive = false
        window.clearTimeout(timer)
        window.clearTimeout(resetTimer)
      }
    }
    const schedule = (): void => {
      window.clearTimeout(timer)
      if (alive && getWorkbenchVisible())
        timer = window.setTimeout(() => void read(), SAMPLE_INTERVAL_MS)
    }
    const read = async (refreshStorage = false): Promise<void> => {
      if (!alive || !getWorkbenchVisible() || pending) return
      pending = true
      setCollecting(true)
      if (refreshStorage) setRefreshingStorage(true)
      try {
        const result = await window.aether.engine.diagnostics({ refreshStorage })
        if (!alive || !getWorkbenchVisible() || result.identity !== identity) return
        setDiagnostics(result)
        setError(null)
        // The initial diagnostics call also performs the first storage scan.
        // Mirror its timestamp so the button cannot immediately trigger a
        // redundant directory walk; the backend applies the same cooldown.
        if (typeof result.storage.scannedAt === 'number' && result.storage.scannedAt > 0) {
          setLastStorageRefresh((previous) => previous || result.storage.scannedAt || 0)
        }
        if (refreshStorage) setLastStorageRefresh(Date.now())
        setNow(Date.now())
      } catch (cause) {
        if (alive && getWorkbenchVisible()) {
          setError({
            identity,
            message: cause instanceof Error ? cause.message : '无法读取引擎资源，请重试。'
          })
          setNow(Date.now())
        }
      } finally {
        pending = false
        if (alive) {
          setCollecting(false)
          setRefreshingStorage(false)
          schedule()
        }
      }
    }
    collect.current = read
    const onVisibility = (): void => {
      window.clearTimeout(timer)
      if (getWorkbenchVisible()) void read()
    }
    const offVisibility = onWorkbenchVisibility(onVisibility)
    window.setTimeout(() => void read(), 0)
    return () => {
      alive = false
      window.clearTimeout(timer)
      window.clearTimeout(resetTimer)
      offVisibility()
      if (collect.current === read) collect.current = async () => {}
    }
  }, [identity, snapshot.mode, snapshot.phase])

  const currentDiagnostics = diagnostics?.identity === identity ? diagnostics : null
  const currentError = error?.identity === identity ? error.message : ''
  const resources = currentDiagnostics?.resources
  const storage = currentDiagnostics?.storage
  const health = currentDiagnostics?.health
  const heartbeat = healthProbeFreshness(health, now)
  const processAvailable = resources?.state === 'available'
  const stale = Boolean(processAvailable && resourceSampleIsStale(resources.sampledAt, now))
  const status = presentResourceHealth(snapshot, currentDiagnostics, now, Boolean(currentError))
  const diskUsed =
    resources &&
    usableResourceNumber(resources.disk.totalBytes) &&
    usableResourceNumber(resources.disk.availableBytes)
      ? Math.max(0, resources.disk.totalBytes - resources.disk.availableBytes)
      : null
  const diskPercent = resourceFraction(diskUsed, resources?.disk.totalBytes)
  const hostMemoryUsed =
    resources &&
    usableResourceNumber(resources.hostMemory.totalBytes) &&
    usableResourceNumber(resources.hostMemory.availableBytes)
      ? Math.max(0, resources.hostMemory.totalBytes - resources.hostMemory.availableBytes)
      : null
  const hostMemoryPercent = resourceFraction(hostMemoryUsed, resources?.hostMemory.totalBytes)
  const segments = useMemo(() => (storage ? storageCategorySegments(storage) : []), [storage])
  const processTree = resources?.processTree
  const processRows = processTree?.processes ?? []
  const visibleProcessRows = processRows.slice(0, PROCESS_ROWS_LIMIT)
  const storageCooldown = Math.max(
    0,
    Math.ceil((lastStorageRefresh + STORAGE_REFRESH_MS - now) / 1000)
  )
  const warming = processAvailable ? '建立采样基线' : '不可用'
  const readRateValue =
    !processAvailable || !usableResourceNumber(resources?.io.readBytes)
      ? '不可用'
      : resources.io.readBytesPerSecond == null
        ? warming
        : formatResourceRate(resources.io.readBytesPerSecond)
  const writeRateValue =
    !processAvailable || !usableResourceNumber(resources?.io.writeBytes)
      ? '不可用'
      : resources.io.writeBytesPerSecond == null
        ? warming
        : formatResourceRate(resources.io.writeBytesPerSecond)

  return (
    <section className="engine-resource" aria-label="引擎资源与健康监控">
      <header className="engine-resource__heading">
        <div>
          <h2>资源与健康</h2>
          <p>{snapshot.mode === 'remote' ? '远端连接心跳 · 每 5 秒同步' : 'CPU、内存与进程 I/O · 每 5 秒采样'}</p>
        </div>
        <span className="engine-resource__health" data-state={status.state}>
          <span aria-hidden="true" />
          {status.label}
        </span>
      </header>
      <div className="engine-resource__metrics" aria-label="引擎进程资源">
        <Metric
          label="CPU"
          value={
            processAvailable
              ? resources.cpu.percent == null
                ? warming
                : formatResourcePercent(resources.cpu.percent)
              : '不可用'
          }
          hint="单逻辑核 = 100%"
          detail={
            processAvailable
              ? `PID ${resources.pid ?? '—'} · ${stale ? '样本已过期' : '引擎主进程'}`
              : '引擎主进程'
          }
        />
        <Metric
          label="内存 · 工作集 RSS"
          value={formatResourceBytes(processAvailable ? resources.memory.rssBytes : null)}
          hint={`私有内存 ${formatResourceBytes(processAvailable ? resources.memory.privateBytes : null)}`}
        />
        <Metric
          label="进程读取 I/O"
          value={readRateValue}
          hint={`累计 ${formatResourceBytes(processAvailable ? resources.io.readBytes : null)}`}
        />
        <Metric
          label="进程写入 I/O"
          value={writeRateValue}
          hint={`累计 ${formatResourceBytes(processAvailable ? resources.io.writeBytes : null)}`}
        />
      </div>
      <section className="engine-resource__processes" aria-label="引擎进程树">
        <header className="engine-resource__processes-heading">
          <div>
            <h3>进程</h3>
            <p>引擎主进程及其真实后代 · 每 15 秒更新，最多显示 {PROCESS_ROWS_LIMIT} 项</p>
          </div>
          <span className="engine-resource__process-count">
            {processTree?.state === 'available' ? `${processTree.totals.count} 个进程` : '不可用'}
          </span>
        </header>
        {processTree?.state !== 'available' ? (
          <p className="engine-resource__storage-note">
            {processTree?.reason || (collecting ? '正在读取进程…' : '尚无进程样本。')}
          </p>
        ) : (
          <>
            <div className="engine-resource__process-summary" aria-label="进程树合计">
              <div>
                <span>合计 CPU</span>
                <strong>{formatResourcePercent(processTree.totals.cpu.percent)}</strong>
              </div>
              <div>
                <span>合计 RSS</span>
                <strong>{formatResourceBytes(processTree.totals.memory.rssBytes)}</strong>
              </div>
              <div>
                <span>合计读取</span>
                <strong>{formatResourceRate(processTree.totals.io.readBytesPerSecond)}</strong>
              </div>
              <div>
                <span>合计写入</span>
                <strong>{formatResourceRate(processTree.totals.io.writeBytesPerSecond)}</strong>
              </div>
            </div>
            <div className="engine-resource__process-table-wrap">
              <table className="engine-resource__process-table">
                <caption className="sr-only">引擎进程资源明细</caption>
                <thead>
                  <tr>
                    <th scope="col">进程</th>
                    <th scope="col">CPU</th>
                    <th scope="col">RSS</th>
                    <th scope="col">PID</th>
                    <th scope="col">运行时长</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProcessRows.map((process) => (
                    <tr key={`${process.pid}:${process.kind}`}>
                      <th scope="row">
                        <span
                          className="engine-resource__process-name"
                          style={{ paddingInlineStart: `${Math.min(process.depth, 6) * 12}px` }}
                        >
                          <span
                            className="engine-resource__process-mark"
                            data-kind={process.kind}
                            aria-hidden="true"
                          />
                          <span title={process.command}>
                            {processName(process.command, process.name)}
                          </span>
                        </span>
                      </th>
                      <td>{formatResourcePercent(process.cpu.percent)}</td>
                      <td>{formatResourceBytes(process.memory.rssBytes)}</td>
                      <td>{process.pid}</td>
                      <td>{formatProcessAge(process.ageMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {processTree.partial || processRows.length > visibleProcessRows.length ? (
              <p className="engine-resource__storage-note">
                进程树受系统权限或数量预算限制，当前仅展示可确认的部分。
              </p>
            ) : null}
          </>
        )}
      </section>
      {resources?.reason ? (
        <p className="engine-resource__message">
          <Icon name="info" size={14} />
          {resources.reason}
        </p>
      ) : null}
      {currentError ? (
        <p className="engine-resource__message engine-resource__message--error" role="alert">
          <Icon name="warning" size={14} />
          <span>{currentError}</span>
          <button
            type="button"
            className="btn btn--sm"
            disabled={collecting}
            onClick={() => void collect.current()}
          >
            重试
          </button>
        </p>
      ) : null}
      <div className="engine-resource__health-facts" aria-label="健康检查采样">
        <div>
          <span>最近成功检查</span>
          <strong>{formatResourceTimestamp(health?.lastSuccessAt)}</strong>
        </div>
        <div>
          <span>最近心跳检查</span>
          <strong>{formatResourceTimestamp(health?.lastCheckedAt)}</strong>
        </div>
        <div>
          <span>心跳新鲜度</span>
          <strong data-freshness={heartbeat.state}>{heartbeat.label}</strong>
        </div>
        <div>
          <span>健康检查延迟</span>
          <strong>
            {usableResourceNumber(health?.lastLatencyMs)
              ? `${Math.round(health.lastLatencyMs)} ms`
              : '不可用'}
          </strong>
        </div>
        <div>
          <span>连续失败</span>
          <strong>
            {health ? `${health.consecutiveFailures} / ${health.failureThreshold}` : '—'}
          </strong>
        </div>
        <div>
          <span>桌面活动流</span>
          <strong>{health ? health.activeStreams : '—'}</strong>
        </div>
      </div>
      <EngineRuntimeHealth snapshot={snapshot} />
      <div className="engine-resource__capacity" aria-label="宿主容量">
        <div>
          <span>宿主内存</span>
          <strong>
            {formatResourceBytes(resources?.hostMemory.availableBytes)} 可用 /{' '}
            {formatResourceBytes(resources?.hostMemory.totalBytes)}
          </strong>
          {hostMemoryPercent !== null ? (
            <meter min="0" max="100" value={hostMemoryPercent} aria-label="宿主内存已用比例" />
          ) : null}
        </div>
        <div>
          <span>数据所在磁盘</span>
          <strong>
            已用 {formatResourceBytes(diskUsed)} ·{' '}
            {formatResourceBytes(resources?.disk.availableBytes)} 可用 /{' '}
            {formatResourceBytes(resources?.disk.totalBytes)}
          </strong>
          {diskPercent !== null ? (
            <meter min="0" max="100" value={diskPercent} aria-label="数据磁盘已用比例" />
          ) : null}
          <small title={resources?.disk.path || undefined}>
            {resources?.disk.path || '未提供磁盘位置'}
          </small>
        </div>
      </div>
      <section className="engine-resource__storage" aria-label="引擎数据存储">
        <header>
          <div>
            <h3>数据存储</h3>
            <p>
              {storage?.state === 'available' ? (
                <>
                  <strong>{formatResourceBytes(storage.totalBytes)}</strong> ·{' '}
                  {storage.files.toLocaleString('zh-CN')} 个文件
                  {storage.partial ? ' · 部分统计' : ''}
                </>
              ) : (
                '按实际文件占用分类'
              )}
            </p>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            disabled={
              collecting || refreshingStorage || storageCooldown > 0 || snapshot.mode === 'remote'
            }
            title={
              storageCooldown > 0 ? `${storageCooldown} 秒后可重新扫描` : '重新统计引擎数据文件占用'
            }
            onClick={() => void collect.current(true)}
          >
            {refreshingStorage
              ? '正在统计…'
              : storageCooldown > 0
                ? `${storageCooldown} 秒后刷新`
                : '刷新存储用量'}
          </button>
        </header>
        {storage?.state === 'available' ? (
          <>
            {segments.length && storage.totalBytes ? (
              <div className="engine-resource__storage-bar" aria-hidden="true">
                {segments.map((segment, index) => (
                  <span
                    key={segment.category}
                    data-color={index % 6}
                    style={{ width: `${segment.percent}%` }}
                  />
                ))}
              </div>
            ) : null}
            <ul className="engine-resource__storage-legend">
              {segments.map((segment, index) => (
                <li key={segment.category}>
                  <span
                    className="engine-resource__storage-dot"
                    data-color={index % 6}
                    aria-hidden="true"
                  />
                  <span>{storageCategoryLabel(segment.category)}</span>
                  <strong>{formatResourceBytes(segment.bytes)}</strong>
                  <small>{segment.files.toLocaleString('zh-CN')} 个文件</small>
                </li>
              ))}
            </ul>
            <p className="engine-resource__storage-path" title={storage.path || undefined}>
              {storage.path || '未提供数据路径'}
            </p>
            <p className="engine-resource__storage-note">
              {storage.partial
                ? '达到采集预算或部分文件不可读，当前为已统计用量。'
                : '按实际文件统计；数据库中的会话与子代理记录共用空间，不估算拆分。'}{' '}
              · 上次统计 {formatResourceTimestamp(storage.scannedAt)}
            </p>
          </>
        ) : (
          <p className="engine-resource__storage-note">
            {storage?.reason || (collecting ? '正在统计数据用量…' : '尚无存储样本。')}
          </p>
        )}
      </section>
      <footer className="engine-resource__footer">
        <span>
          资源采样 {formatResourceTimestamp(resources?.sampledAt)}
          {resources?.collection
            ? ` · 采集 ${Math.round(resources.collection.durationMs)} ms${resources.collection.cached ? ' · 缓存' : ''}`
            : ''}
        </span>
        <span>{collecting ? '正在采样' : '页面隐藏后暂停采样'}</span>
      </footer>
      <p className="engine-resource__scope">
        顶部资源卡显示引擎主进程；“进程”表会在权限允许时合计可确认的后代进程。I/O
        包括文件、管道和设备传输。连接心跳复用主进程每 5 秒的 /health 与实例身份检查，
        不新增引擎请求{health?.timeoutMs ? `；单次超时 ${health.timeoutMs / 1000} 秒` : ''}。
      </p>
    </section>
  )
}
