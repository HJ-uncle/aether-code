import { memo, useId, useState, type JSX } from 'react'
import type { EngineTodo } from '../../../../shared/ipc'
import { Icon } from '../../workbench/icons'
import { Spinner } from '../../workbench/ui-primitives'

const TODO_LABELS: Record<EngineTodo['status'], string> = {
  pending: '待开始', in_progress: '进行中', done: '已完成', cancelled: '已取消'
}

/** A finished root cannot keep executing a stale plan. Preserve the server's
 * counts, but distinguish unconfirmed work from a live operation. */
export const WorkTodoProgress = memo(function WorkTodoProgress({ todos, running }: {
  todos: EngineTodo[]
  running: boolean
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const done = todos.filter(todo => todo.status === 'done').length
  const cancelled = todos.filter(todo => todo.status === 'cancelled').length
  const current = todos.find(todo => todo.status === 'in_progress')
  const label = (todo: EngineTodo): string => !running && ['pending', 'in_progress'].includes(todo.status)
    ? '未确认完成' : TODO_LABELS[todo.status]
  if (!todos.length) return null
  return <section className="work-progress-panel" aria-label="执行反馈">
    <section className="work-progress-panel__section work-progress-panel__section--todos" aria-label="任务清单">
      <button type="button" className="work-progress-panel__todo-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
        <span className="work-progress-panel__title"><Icon name="check-all" size={15} /><span>任务清单</span></span>
        <span className="work-progress-panel__count" aria-live="polite">{done} / {todos.length} 已完成{cancelled ? ` · ${cancelled} 已取消` : ''}</span>
        <Icon name="chevron-right" size={13} className="work-progress-panel__changes-chevron" />
      </button>
      {!expanded && current ? <div className="work-progress-panel__current-todo" aria-label={running ? '当前步骤' : '未确认完成的步骤'}>
        {running ? <Spinner size={12} /> : <Icon name="circle" size={12} />}<span title={current.title}>{current.title}{running ? '' : ' · 未确认完成'}</span>
      </div> : null}
      <ol id={listId} className="work-progress-panel__todos" hidden={!expanded}>
        {todos.map(todo => <li key={todo.id} data-todo-id={todo.id} data-status={todo.status} aria-label={`${todo.title} · ${label(todo)}`}>
          <span className={`work-progress-panel__todo-icon work-progress-panel__todo-icon--${!running && todo.status === 'in_progress' ? 'pending' : todo.status}`} aria-hidden="true">
            {todo.status === 'in_progress' && running ? <Spinner size={14} /> : <Icon name={todo.status === 'done' ? 'check' : todo.status === 'cancelled' ? 'close' : 'circle'} size={15} />}
          </span>
          <span className="work-progress-panel__todo-text">{todo.title}</span>
          {todo.status !== 'done' ? <span className={`work-progress-panel__todo-status work-progress-panel__todo-status--${!running && todo.status === 'in_progress' ? 'pending' : todo.status}`}>{label(todo)}</span> : null}
        </li>)}
      </ol>
    </section>
  </section>
})
