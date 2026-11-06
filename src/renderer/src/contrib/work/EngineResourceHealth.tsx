import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { EngineSnapshot } from '@shared/ipc'
import type { EngineDiagnostics } from '@shared/engine-diagnostics'
import { Icon } from '@renderer/workbench/icons'
import { getWorkbenchVisible, onWorkbenchVisibility } from '@renderer/core/platform/workbench-visibility'
import { EngineRuntimeHealth } from './EngineRuntimeHealth'
import { EngineMonitorRefreshButton } from './EngineMonitorRefreshButton'
import { createManualDiagnosticsReader } from './manual-diagnostics'
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
  const [runtimeCollecting, setRuntimeCollecting] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const collect = useRef<() => Promise<void>>(async () => {})
  const runtimeRefresh = useRef<(() => Promise<void>) | null>(null)
  const latestIdentity = useRef(identity)
  latestIdentity.current = identity

  useEffect(() => {
    setDiagnostics(null)
    setError(null)
    setCollecting(false)
    // Remote diagnostics reuse the existing host heartbeat and return explicit
    // unavailable OS resources; they never inspect a local stand-in process.
    if (snapshot.phase !== 'ready') {
      collect.current = async () => {}
      return
    }
    const reader = createManualDiagnosticsReader({
      current: () => latestIdentity.current === identity,
      read: async (refresh) => {
        const [result] = await Promise.all([
          window.aether.engine.diagnostics({ refresh }),
          refresh ? runtimeRefresh.current?.() : undefined
        ])
        return result
      },
      publish: (result) => {
        if (result.identity !== identity) return
        setDiagnostics(result)
        setError(null)
        setNow(Date.now())
      },
      error: cause => {
        setError({ identity, message: cause instanceof Error ? cause.message : '无法读取引擎资源，请重试。' })
        setNow(Date.now())
      },
      busy: setCollecting
    })
    collect.current = reader.refresh
    const onVisibility = (): void => reader.setVisible(getWorkbenchVisible())
    const offVisibility = onWorkbenchVisibility(onVisibility)
    onVisibility()
    return () => {
      reader.dispose()
      offVisibility()
      if (collect.current === reader.refresh) collect.current = async () => {}
    }
  }, [identity, snapshot.mode, snapshot.phase, snapshot.entryPath, snapshot.runtimeSource])

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
  const busy = collecting || runtimeCollecting
  const warming = processAvailable ? '需再次刷新' : '不可用'
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
    <section className="engine-resource" aria-label="引擎资源与健康监控" aria-busy={busy}>
      <header className="engine-resource__heading">
        <div>
          <h2>资源与健康</h2>
          <p>进入页面读取一次，之后手动刷新；CPU 和 I/O 速率需要两次采样。</p>
        </div>
        <div className="engine-resource__heading-actions" role="group" aria-label="监控操作">
          <span className="engine-resource__health" data-state={status.state}>
            <span aria-hidden="true" />
            {status.label}
          </span>
          <EngineMonitorRefreshButton label="刷新监控数据" busy={busy}
            disabled={snapshot.phase !== 'ready'} onRefresh={() => collect.current()} />
        </div>
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
            <p>引擎主进程及其真实后代 · 随手动刷新更新，最多显示 {PROCESS_ROWS_LIMIT} 项</p>
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
                <strong>{processTree.totals.cpu.percent === null ? '需再次刷新' : formatResourcePercent(processTree.totals.cpu.percent)}</strong>
              </div>
              <div>
                <span>合计 RSS</span>
                <strong>{formatResourceBytes(processTree.totals.memory.rssBytes)}</strong>
              </div>
              <div>
                <span>合计读取</span>
                <strong>{processTree.totals.io.readBytes !== null && processTree.totals.io.readBytesPerSecond === null ? '需再次刷新' : formatResourceRate(processTree.totals.io.readBytesPerSecond)}</strong>
              </div>
              <div>
                <span>合计写入</span>
                <strong>{processTree.totals.io.writeBytes !== null && processTree.totals.io.writeBytesPerSecond === null ? '需再次刷新' : formatResourceRate(processTree.totals.io.writeBytesPerSecond)}</strong>
              </div>
            </div>
            <div className="engine-resource__process-table-wrap" data-scroll-axis="x">
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
                      <td>{process.cpu.percent === null ? '需再次刷新' : formatResourcePercent(process.cpu.percent)}</td>
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
            disabled={busy}
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
          <span>采样时心跳新鲜度</span>
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
      <EngineRuntimeHealth snapshot={snapshot} refreshRef={runtimeRefresh} onCollecting={setRuntimeCollecting}
        refreshing={runtimeCollecting} />
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
      <section className="engine-resource__storage" aria-label="引擎数据存储" aria-busy={collecting}>
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
          <EngineMonitorRefreshButton label="刷新存储用量" busy={busy}
            disabled={snapshot.phase !== 'ready' || snapshot.mode === 'remote'} onRefresh={() => collect.current()} />
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
                ? `${storage.partialReasons?.join('；') || '达到采集预算或部分文件不可读'}，当前仅包含已统计用量。`
                : '按文件逻辑大小统计；文件数不代表会话数，长期记忆是磁盘数据，不是运行内存。'}{' '}
              · 上次统计 {formatResourceTimestamp(storage.scannedAt)}
              {storage.cached ? ' · 缓存样本' : ' · 新采样'}
              {' · '}采集 {Math.round(storage.durationMs)} ms
            </p>
            <details className="engine-resource__sqlite">
              <summary>SQLite 内部占用与维护收据</summary>
              {storage.sqlite?.state === 'available' ? (
                <>
                  <dl className="engine-resource__sqlite-facts">
                    <div><dt>数据库逻辑页</dt><dd>{storage.sqlite.pageCount?.toLocaleString('zh-CN') ?? '不可用'} 页</dd></div>
                    <div><dt>空闲页（可复用）</dt><dd>{formatResourceBytes(storage.sqlite.freeBytes)} · {storage.sqlite.freelistPages?.toLocaleString('zh-CN') ?? '不可用'} 页</dd></div>
                    <div><dt>页大小</dt><dd>{formatResourceBytes(storage.sqlite.pageSize)}</dd></div>
                  </dl>
                  <p className="engine-resource__storage-note">空闲页已包含在数据库文件内，不与文件总量重复相加；可复用不表示已归还磁盘空间。</p>
                  {storage.sqlite.maintenance ? (
                    <p className="engine-resource__storage-note">
                      历史维护收据：待提交 {storage.sqlite.maintenance.pending.toLocaleString('zh-CN')} · 已提交 {storage.sqlite.maintenance.committed.toLocaleString('zh-CN')} · 已失效 {storage.sqlite.maintenance.invalidated.toLocaleString('zh-CN')}
                      {storage.sqlite.maintenance.other ? ` · 其他 ${storage.sqlite.maintenance.other.toLocaleString('zh-CN')}` : ''}
                    </p>
                  ) : <p className="engine-resource__storage-note">当前数据库未提供历史维护收据统计。</p>}
                  {storage.sqlite.objects.length > 0 ? (
                    <div className="engine-resource__sqlite-table-wrap" data-scroll-axis="x">
                      <table className="engine-resource__sqlite-table">
                        <caption>表与索引占用最多的 {storage.sqlite.objects.length} 项</caption>
                        <thead><tr><th scope="col">对象</th><th scope="col">类型</th><th scope="col">分配页占用</th></tr></thead>
                        <tbody>{storage.sqlite.objects.map(object => (
                          <tr key={`${object.kind}:${object.name}`}>
                            <th scope="row" title={`${object.name} · 所属表 ${object.tableName}`}>{object.name}</th>
                            <td>{object.kind === 'index' ? '索引' : '表'}</td>
                            <td>{formatResourceBytes(object.bytes)}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  ) : null}
                  <p className="engine-resource__storage-note">
                    只读统计主数据库页分配，包含索引；不按会话或子代理估算拆分。统计时间 {formatResourceTimestamp(storage.sqlite.sampledAt)} · {Math.round(storage.sqlite.durationMs)} ms
                    {storage.sqlite.partial ? ` · 部分统计：${storage.sqlite.partialReasons.join('；') || '采集未完成'}` : ''}
                  </p>
                </>
              ) : (
                <p className="engine-resource__storage-note">{storage.sqlite?.reason || '当前桌面版本尚未提供 SQLite 内部统计，文件用量仍可使用。'}</p>
              )}
            </details>
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
        <div className="engine-resource__footer-actions">
          <EngineMonitorRefreshButton label="手动刷新监控数据" busy={busy}
            disabled={snapshot.phase !== 'ready'} onRefresh={() => collect.current()} />
        </div>
      </footer>
      <p className="engine-resource__scope">
        顶部资源卡显示引擎主进程；“进程”表会在权限允许时合计可确认的后代进程。I/O
        包括文件、管道和设备传输。连接心跳复用主进程每 5 秒的 /health 与实例身份检查，
        不新增引擎请求{health?.timeoutMs ? `；单次超时 ${health.timeoutMs / 1000} 秒` : ''}。
      </p>
    </section>
  )
}
