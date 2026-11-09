import { useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { toolDisplayName } from '@renderer/core/engine/tool-labels'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { Icon } from '@renderer/workbench/icons'
import { workActivityState } from './work-inline-activity-state'
import { workToolTarget } from './work-message-timeline'
import { workPageRange } from './work-view-performance'
import './work-failure-navigator.css'

/** A task-wide diagnostic index without duplicating the tool inspector. */
export function WorkFailureNavigator({ tools, onReveal }: {
  tools: ToolActivity[]
  onReveal: (id: string) => void
}): JSX.Element | null {
  const failures = useMemo(() => tools.filter(tool => isVisibleToolActivity(tool) && ['error', 'interrupted'].includes(workActivityState(tool))), [tools])
  const [page, setPage] = useState(0)
  const focusRequest = useRef<string | null>(null)
  const root = useRef<HTMLDetailsElement>(null)
  const range = workPageRange(failures.length, page, 20)
  useLayoutEffect(() => {
    if (!focusRequest.current) return
    const button = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-failure-id]') ?? [])
      .find(node => node.dataset.failureId === focusRequest.current)
    if (button) { button.focus(); focusRequest.current = null }
  }, [range.page, failures])
  if (!failures.length) return null
  return <details ref={root} className="work-failure-navigator">
    <summary><Icon name="info" size={14} /><span>未完成的步骤 · {failures.length}</span><small>查看记录</small></summary>
    <div role="region" aria-label="未完成的步骤">
      <p>当前已加载对话中的记录；历史失败不代表任务最终失败。</p>
      <ul>{failures.slice(range.start, range.end).map((tool, offset) => <li key={tool.id}>
        <button type="button" data-failure-id={tool.id} onClick={() => onReveal(tool.id)} aria-label={`定位未完成步骤 ${toolDisplayName(tool.name)} ${workToolTarget(tool)}`}
          onKeyDown={event => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? failures.length - 1
              : Math.max(0, Math.min(failures.length - 1, range.start + offset + (event.key === 'ArrowUp' ? -1 : 1)))
            focusRequest.current = failures[next].id
            const nextPage = Math.floor(next / 20)
            if (nextPage === range.page) {
              root.current?.querySelector<HTMLButtonElement>(`[data-failure-id="${CSS.escape(failures[next].id)}"]`)?.focus()
              focusRequest.current = null
            } else setPage(nextPage)
          }}>
          <span>{toolDisplayName(tool.name)}</span><span title={workToolTarget(tool, undefined, true)}>{workToolTarget(tool)}</span>
          <Icon name="chevron-right" size={12} />
        </button>
      </li>)}</ul>
      {range.pages > 1 ? <nav aria-label="未完成步骤分页">
        <button type="button" disabled={range.page === 0} onClick={() => setPage(range.page - 1)}>上一页</button>
        <span>{range.page + 1} / {range.pages}</span>
        <button type="button" disabled={range.page === range.pages - 1} onClick={() => setPage(range.page + 1)}>下一页</button>
      </nav> : null}
    </div>
  </details>
}
