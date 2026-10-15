import { useEffect, useState, type JSX } from 'react'
import { formatResourceBytes } from './engine-resource-presentation'
import { startRendererPerformanceProbe, type RendererPerformanceSnapshot } from './renderer-performance'
import { useWorkbenchVisible } from '@renderer/core/platform/workbench-visibility'

/** A page-only opt-in probe. Engine V8 heap must come from the engine itself;
 * Chromium's coarse memory estimate is labelled separately to avoid mixing PIDs. */
export function RendererPerformanceHealth(): JSX.Element {
  const [open, setOpen] = useState(false)
  const visible = useWorkbenchVisible()
  const [snapshot, setSnapshot] = useState<RendererPerformanceSnapshot | null>(null)
  useEffect(() => {
    if (!open || !visible) return
    let stop: (() => void) | undefined
    const sync = (): void => {
      stop?.()
      stop = undefined
      stop = startRendererPerformanceProbe({
        now: () => performance.now(),
        readHeap: () => (performance as Performance & { memory?: unknown }).memory,
        observe: consume => {
          if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return null
          const observer = new PerformanceObserver(list => consume(list.getEntries()))
          // buffered=false excludes work before the user opened this probe.
          observer.observe({ type: 'longtask', buffered: false })
          return () => observer.disconnect()
        },
        schedule: (publish, interval) => {
          const timer = window.setInterval(publish, interval)
          return () => window.clearInterval(timer)
        }
      }, setSnapshot)
    }
    sync()
    return () => { stop?.() }
  }, [open, visible])
  const paused = !visible
  const tasks = snapshot?.longTasks
  return <section className="engine-monitor__performance" aria-label="客户端性能">
    <header className="engine-monitor__toolbar">
      <span>客户端性能</span>
      <button type="button" className="btn btn--sm" aria-expanded={open} aria-controls="renderer-performance-body" onClick={() => setOpen(value => !value)}>
        {open ? '停止采集' : '按需采集页面性能'}
      </button>
    </header>
    {open ? <div className="engine-monitor__performance-body" id="renderer-performance-body" data-performance-state={paused ? 'paused' : 'sampling'}>
      <p className="engine-monitor__note">当前窗口 · {paused ? '页面隐藏，采集已暂停' : `本次可见采集 ${Math.floor((snapshot?.observedMs ?? 0) / 1000)} 秒`}。仅保留汇总，收起或离开后停止；重新打开从零计数。</p>
      <dl className="engine-monitor__performance-stats renderer-performance__stats">
        <div className="engine-monitor__stat"><dt className="engine-monitor__label">UI 长任务（≥50 ms）</dt><dd>{tasks?.available ? `${tasks.count} 次` : '不可用'}</dd><small>当前可见采集期间</small></div>
        <div className="engine-monitor__stat"><dt className="engine-monitor__label">长任务总时长 / 最长</dt><dd>{tasks?.available ? `${Math.round(tasks.totalMs)} / ${Math.round(tasks.maxMs)} ms` : '不可用'}</dd><small>主线程占用时间</small></div>
        <div className="engine-monitor__stat"><dt className="engine-monitor__label">页面 JS 堆估计</dt><dd>{formatResourceBytes(snapshot?.heap?.usedBytes)}</dd><small>{snapshot?.heap ? `已分配 ${formatResourceBytes(snapshot.heap.totalBytes)} · 上限 ${formatResourceBytes(snapshot.heap.limitBytes)}` : '当前 Chromium 未提供内存估计'}</small></div>
      </dl>
      <p className="engine-monitor__note">页面堆为 Chromium 粗略估计，可能包含共享上下文；引擎内存见上方资源与健康。</p>
    </div> : null}
  </section>
}
