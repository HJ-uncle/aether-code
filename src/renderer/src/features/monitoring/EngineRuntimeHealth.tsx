import { useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import type { EngineSnapshot } from '@shared/ipc'
import { request } from '@renderer/core/engine/client'
import { engineConnectionKey, getEngineSource, getExpectedEngine } from '@renderer/core/engine/source'
import { useWorkbenchVisible } from '@renderer/core/platform/workbench-visibility'
import { engineDiagnosticsIdentity, formatResourceBytes, formatResourceTimestamp } from './engine-resource-presentation'
import { createEngineRuntimeSampler, type EngineRuntimeState } from './engine-runtime'
import { EngineMonitorRefreshButton } from './EngineMonitorRefreshButton'
import './engine-runtime-health.css'

/** Local refresh reads runtime directly; the header invokes the same reader via
 * refreshRef when collecting the whole page. Neither path schedules a poll. */
export function EngineRuntimeHealth({ snapshot, refreshRef, onCollecting, refreshing }: {
  snapshot: EngineSnapshot
  refreshRef: RefObject<(() => Promise<void>) | null>
  onCollecting: (busy: boolean) => void
  refreshing: boolean
}): JSX.Element {
  const identity = engineDiagnosticsIdentity(snapshot)
  const latestIdentity = useRef(identity); latestIdentity.current = identity
  const [open, setOpen] = useState(false)
  const visible = useWorkbenchVisible()
  const [result, setResult] = useState<{ identity: string; value: EngineRuntimeState } | null>(null)
  const samplerRef = useRef<ReturnType<typeof createEngineRuntimeSampler> | null>(null)
  useEffect(() => {
    const source = getEngineSource(), expectedEngine = { mode: snapshot.mode, baseUrl: snapshot.baseUrl, instanceId: snapshot.instanceId, accountId: snapshot.accountId }
    const sampler = createEngineRuntimeSampler({
      target: { instanceId: snapshot.instanceId, pid: snapshot.pid },
      current: () => latestIdentity.current === identity && getEngineSource() === source && engineConnectionKey({ ...expectedEngine, phase: snapshot.phase }) === engineConnectionKey({ ...getExpectedEngine(), phase: snapshot.phase }),
      read: () => request<unknown>({ method: 'GET', path: '/performance/runtime?refresh=true', expectedEngine }),
      publish: value => setResult({ identity, value }),
      busy: onCollecting
    })
    samplerRef.current = sampler
    refreshRef.current = sampler.retry
    return () => { sampler.dispose(); if (samplerRef.current === sampler) samplerRef.current = null; if (refreshRef.current === sampler.retry) refreshRef.current = null }
  }, [identity, snapshot.phase, snapshot.entryPath, snapshot.runtimeSource, refreshRef, onCollecting])
  useEffect(() => { samplerRef.current?.setActive(open && visible && snapshot.phase === 'ready') }, [identity, snapshot.phase, snapshot.entryPath, snapshot.runtimeSource, open, visible])

  const value = result?.identity === identity ? result.value : null
  const sample = value?.sample
  const warming = sample?.eventLoop.state !== 'available'
  const active = open && visible && snapshot.phase === 'ready'
  const message = !open ? '未提供样本。展开后按需读取引擎自身的堆内存和事件循环指标。'
    : snapshot.phase !== 'ready' ? '引擎尚未就绪，未开始采样。'
      : !visible ? '页面隐藏，运行时采样已暂停。'
        : value?.message || (value?.phase === 'loading' ? '正在读取引擎运行时指标…' : value?.cached ? '本次请求已完成，引擎返回同一采样时间的缓存样本。' : sample ? warming ? '内存数据已可用；此引擎的事件循环指标仍在建立基线。' : '已读取本次运行时样本。' : '尚无样本，请点击刷新按钮。')
  const displaySample = open && sample
  const numberMs = (number: number | undefined) => number === undefined ? '需再次刷新' : `${number.toFixed(1)} ms`
  return <details className="engine-resource__runtime engine-runtime" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span>运行时指标能力</span>{open ?
      <EngineMonitorRefreshButton label="刷新运行时指标" busy={refreshing}
        disabled={!active} onRefresh={() => samplerRef.current?.retry()} /> : <small>展开查看</small>}</summary>
    <div className="engine-runtime__body" aria-label="引擎运行时指标" data-runtime-state={!active ? 'paused' : value?.phase ?? 'idle'}>
      <p className="engine-runtime__status" role="status">{message}</p>
      {displaySample ? <>
        <dl className="engine-runtime__stats">
          <div><dt>引擎 V8 Heap</dt><dd>{formatResourceBytes(sample.memory.heapUsedBytes)}</dd><small>已分配 {formatResourceBytes(sample.memory.heapTotalBytes)} · 上限 {formatResourceBytes(sample.memory.heapLimitBytes)}</small></div>
          <div><dt>引擎进程 RSS</dt><dd>{formatResourceBytes(sample.memory.rssBytes)}</dd><small>引擎自身读取，PID {sample.pid}</small></div>
          <div><dt>堆外内存</dt><dd>{formatResourceBytes(sample.memory.externalBytes)}</dd><small>ArrayBuffer {formatResourceBytes(sample.memory.arrayBuffersBytes)}，已包含在堆外内存中</small></div>
          <div><dt>事件循环利用率</dt><dd>{warming || sample.eventLoop.utilization === null ? '需再次刷新' : `${(sample.eventLoop.utilization * 100).toFixed(1)}%`}</dd><small>ELU · 区间 {sample.eventLoop.intervalMs === null ? '未提供' : `${(sample.eventLoop.intervalMs / 1000).toFixed(1)} 秒`}</small></div>
          <div><dt>事件循环延迟 P95</dt><dd>{warming ? '需再次刷新' : numberMs(sample.eventLoop.delay?.p95Ms)}</dd><small>均值 {warming ? '需再次刷新' : numberMs(sample.eventLoop.delay?.meanMs)} · 最大 {warming ? '需再次刷新' : numberMs(sample.eventLoop.delay?.maxMs)}</small></div>
        </dl>
        <p className="engine-runtime__note">延迟直方图分辨率 {sample.collection.delayResolutionMs} ms，读数包含约 {sample.collection.delayResolutionMs} ms 的采样基线，不等同于额外阻塞时间。</p>
        <p className="engine-runtime__note">{sample.collection.sampleWindowMs === undefined
          ? `旧引擎至少缓存 ${sample.collection.minIntervalMs / 1000} 秒；${sample.collection.idleTimeoutMs / 1000} 秒无读取后自动停用采集。短间隔刷新可能返回同一时间的缓存样本。`
          : `本次按需窗口 ${sample.collection.sampleWindowMs} ms；采样结束即停止采集，无后台轮询。`}</p>
        <footer className="engine-runtime__footer"><span data-sampled-at={sample.sampledAt}>采样 {formatResourceTimestamp(sample.sampledAt)}.{String(Math.floor(sample.sampledAt) % 1000).padStart(3, '0')} · {value?.cached ? '缓存样本' : '新样本'}</span><span>引擎运行 {(sample.uptimeMs / 60000).toFixed(1)} 分钟 · PID {sample.pid}</span></footer>
      </> : <dl className="engine-runtime__missing"><div><dt>引擎 V8 Heap</dt><dd>未提供</dd></div><div><dt>引擎事件循环延迟</dt><dd>未提供</dd></div></dl>}
      <p className="engine-runtime__note">这些数据来自引擎 Node 进程。只保留一个样本；隐藏后恢复或再次展开不会自动读取。</p>
    </div>
  </details>
}
