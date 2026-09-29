import { useEffect, useRef, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { Icon } from '@renderer/workbench/icons'

/**
 * 输出面板
 *
 * 展示主进程捕获的引擎日志。引擎启动失败时这里往往是唯一的线索来源，
 * 因此默认放在状态栏一键可达的位置。
 */
export function OutputView(): JSX.Element {
  const { engine } = useApp()
  const { logs, clearLogs } = engine
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
        <span className="output__count">{logs.length} 行</span>
        <div className="output__toolbar-spacer" />
        <button type="button" className="output__btn" onClick={clearLogs}>
          <Icon name="trash" size={16} />
          清空
        </button>
      </div>
      <div className="output__lines" ref={scrollRef}>
        {logs.length === 0 ? (
          <div className="output__empty">暂无输出。启动引擎后可在此查看运行日志。</div>
        ) : (
          logs.map((entry, index) => (
            <div
              key={`${entry.ts}-${index}`}
              className={`output__line output__line--${entry.level}`}
            >
              <span className="output__time">
                {new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
              <span className="output__text">{entry.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
