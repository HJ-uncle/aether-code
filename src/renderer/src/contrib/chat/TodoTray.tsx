import type { JSX } from 'react'
import type { EngineTodo } from '@shared/ipc'
import { Icon } from '@renderer/workbench/icons'

/** todo 状态 → 中文标签（条目右侧展示） */
const STATUS_LABEL: Record<EngineTodo['status'], string> = {
  pending: '待开始',
  in_progress: '进行中',
  done: '已完成',
  cancelled: '已取消'
}

/**
 * 任务托盘（Trae 风格）：
 * - 进行中/待处理项以 checklist 展示
 * - 已完成/取消项排在底部，和进行中项目保持同一条信息轴
 * - 底部常驻进度条
 *
 * 数据来自引擎 todo 帧（useChat.todos），组件只读不回写 ——
 * 状态变更由 Agent 调 todo_update 后经新帧整表下发。
 */
export function TodoTray({ todos }: { todos: EngineTodo[] }): JSX.Element | null {
  if (todos.length === 0) return null

  // 引擎按 created_at 倒序返回，展示时反转为创建顺序（先建的任务在上）
  const ordered = [...todos].reverse()
  const active = ordered.filter((t) => t.status === 'pending' || t.status === 'in_progress')
  const completed = ordered.filter((t) => t.status === 'done' || t.status === 'cancelled')
  const total = todos.length
  const percent = total === 0 ? 0 : Math.round((completed.length / total) * 100)

  return (
    <div className="todo-tray">
      {active.length > 0 ? (
        <ul className="todo-tray__list">
          {active.map((todo) => (
            <li key={todo.id} className={`todo-tray__item todo-tray__item--${todo.status}`}>
              <Icon name={todo.status === 'in_progress' ? 'circle-dot' : 'circle'} size={16} />
              <span className="todo-tray__title" title={todo.description || todo.title}>
                {todo.title}
              </span>
              <span className={`todo-tray__status todo-tray__status--${todo.status}`}>
                {STATUS_LABEL[todo.status]}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {completed.length > 0 ? (
        <div className="todo-tray__done">
          {/* 去掉「已完成 N 项」标签行：条目上的删除线 + ✓ 已表达状态，计数由底部
              进度行的「N/M 个任务已完成」承担，标签行是纯占位 */}
          <ul className="todo-tray__list todo-tray__list--done">
            {completed.map((todo) => (
              <li key={todo.id} className="todo-tray__item todo-tray__item--done">
                <Icon name="check" size={16} />
                <span className="todo-tray__title" title={todo.description || todo.title}>
                  {todo.title}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="todo-tray__footer">
        <div className="todo-tray__progress">
          <div className="todo-tray__progress-bar" style={{ width: `${percent}%` }} />
        </div>
        <span className="todo-tray__progress-text">
          {completed.length}/{total} 个任务已完成
        </span>
      </div>
    </div>
  )
}
