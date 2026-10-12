import { memo, useEffect, useRef, useSyncExternalStore, type JSX } from 'react'
import { clearEngineLogs, useEngineLogs } from '@renderer/core/engine/log-store'
import type { EngineLogLine } from '@renderer/core/engine/log-buffer'
import { getAppMode, onAppModeChanged } from '@renderer/core/platform/app-mode'
import { getLayout, onLayoutChanged } from '@renderer/core/platform/layout-state'
import { Icon } from '@renderer/workbench/icons'

function outputVisible(): boolean {
  const layout = getLayout()
  return (
    getAppMode() === 'code' &&
    layout.panelVisible &&
    layout.activePanelView === 'output' &&
    !document.hidden
  )
}

function subscribeVisibility(listener: () => void): () => void {
  const offMode = onAppModeChanged(listener)
  const offLayout = onLayoutChanged(listener)
  document.addEventListener('visibilitychange', listener)
  return () => {
    offMode()
    offLayout()
    document.removeEventListener('visibilitychange', listener)
  }
}

const OutputLine = memo(function OutputLine({ entry }: { entry: EngineLogLine }): JSX.Element {
  return (
    <div className={`output__line output__line--${entry.level}`}>
      <span className="output__time">
        {new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })}
      </span>
      <span className="output__text" title={entry.truncated ? '日志过长，已截断显示' : undefined}>
        {entry.line}
      </span>
    </div>
  )
})

/**
 * 输出面板
 *
 * 展示主进程捕获的引擎日志。引擎启动失败时这里往往是唯一的线索来源，
 * 因此默认放在状态栏一键可达的位置。
 */
export function OutputView(): JSX.Element {
  const visible = useSyncExternalStore(subscribeVisibility, outputVisible)
  const { entries: logs, discarded } = useEngineLogs(visible)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // 仅在已贴底时自动滚动，避免打断用户向上翻阅
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <div className="output">
      <div className="output__toolbar">
        <span className="output__count">
          {logs.length} 行{discarded ? ` · 已淘汰 ${discarded} 行较早日志` : ''}
        </span>
        <div className="output__toolbar-spacer" />
        <button type="button" className="output__btn" onClick={clearEngineLogs}>
          <Icon name="trash" size={16} />
          清空
        </button>
      </div>
      <div className="output__lines" ref={scrollRef}>
        {logs.length === 0 ? (
          <div className="output__empty">暂无输出。启动引擎后可在此查看运行日志。</div>
        ) : (
          logs.map((entry) => <OutputLine key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  )
}
