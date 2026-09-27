import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import { Icon } from '@renderer/workbench/icons'
import { requestOrThrow } from '@renderer/core/engine/client'
import {
  MAX_RENDER_ROWS,
  computeLineDiff,
  diffForDeletedFile,
  diffForNewFile,
  diffStats
} from './diff'

/**
 * 改动确认面板（输入框上方）
 *
 * 列出本会话 Agent 产生的待确认文件改动：每行 = 文件名 + 目录 + 增删统计 +
 * 状态徽章 + 待确认按钮；底部 = 改动数 | 全部撤回 | 全部保留。
 *
 * 数据源是引擎的 /changes REST（SQLite 里的快照），不依赖 SSE 在线：
 * 一轮对话结束时刷新，确认/撤回后立即刷新。
 */

type ChangeBadge = 'A' | 'M' | 'D'

function badgeOf(change: EngineFileChange): ChangeBadge {
  if (change.kind === 'delete') return 'D'
  return change.isNew ? 'A' : 'M'
}

/** 估算增删行数；内容未存档时返回 null（不显示数字） */
function statsOf(change: EngineFileChange): { added: number; removed: number } | null {
  if (change.truncated) return null
  let rows
  if (change.kind === 'delete') rows = diffForDeletedFile(change.oldContent ?? '')
  else if (change.isNew) rows = diffForNewFile(change.newContent ?? '')
  else {
    if (change.oldContent === null || change.newContent === null) return null
    rows = computeLineDiff(change.oldContent, change.newContent).slice(0, MAX_RENDER_ROWS)
  }
  return diffStats(rows)
}

function splitPath(change: EngineFileChange): { name: string; dir: string } {
  const display = (change.displayPath || change.path).replace(/\\/g, '/')
  const index = display.lastIndexOf('/')
  if (index === -1) return { name: display, dir: '' }
  return { name: display.slice(index + 1), dir: display.slice(0, index) }
}

export function ChangesPanel({
  sessionId,
  streaming
}: {
  sessionId: string
  streaming: boolean
}): JSX.Element | null {
  const [changes, setChanges] = useState<EngineFileChange[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!sessionId) return
    try {
      const data = await requestOrThrow<EngineFileChange[]>({
        method: 'GET',
        path: '/changes',
        query: { sessionId, status: 'pending' }
      })
      setChanges(Array.isArray(data) ? data : [])
      setError(null)
    } catch {
      // 引擎未就绪时静默（面板直接不渲染）
    }
  }, [sessionId])

  // setState 放进定时器回调：effect 体内同步触发级联渲染是 lint 禁止的模式
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0)
    return () => clearTimeout(timer)
  }, [refresh])

  // 一轮对话结束（true→false）时快照刚落库，此时刷新
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void refresh()
    wasStreaming.current = streaming
  }, [streaming, refresh])

  const act = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        await action()
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const keepOne = (id: string): Promise<void> =>
    // POST 必须带 body（哪怕是空对象）：IDE 的 engine.request 只在有 body 时
    // 才发 Content-Type，而 Fastify 对无 Content-Type 的 POST 一律 415
    act(() => requestOrThrow({ method: 'POST', path: `/changes/${id}/keep`, body: {} }))

  const revertOne = (id: string): Promise<void> =>
    act(() => requestOrThrow({ method: 'POST', path: `/changes/${id}/revert`, body: {} }))

  const keepAll = (): Promise<void> =>
    act(() => requestOrThrow({ method: 'POST', path: '/changes/keep-all', body: { sessionId } }))

  const revertAll = (): Promise<void> =>
    act(async () => {
      // 逐条撤回（引擎单条接口）；失败的条目留在面板里下次再试
      for (const change of [...changes].reverse()) {
        await requestOrThrow({ method: 'POST', path: `/changes/${change.id}/revert`, body: {} })
      }
    })

  if (changes.length === 0) return null

  return (
    <div className="changes-panel">
      <ul className="changes-panel__list">
        {changes.map((change) => {
          const { name, dir } = splitPath(change)
          const stats = statsOf(change)
          const badge = badgeOf(change)
          return (
            <li key={change.id} className="changes-panel__item">
              <Icon name="file" size={14} />
              <span className="changes-panel__name" title={change.displayPath || change.path}>
                {name}
              </span>
              {dir ? <span className="changes-panel__dir">{dir}</span> : null}
              <span className="changes-panel__spacer" />
              {stats ? (
                <span className="changes-panel__stats">
                  {stats.added > 0 ? (
                    <span className="changes-panel__add">+{stats.added}</span>
                  ) : null}
                  {stats.removed > 0 ? (
                    <span className="changes-panel__del">-{stats.removed}</span>
                  ) : null}
                </span>
              ) : null}
              <span className={`changes-panel__badge changes-panel__badge--${badge.toLowerCase()}`}>
                {badge}
              </span>
              <button
                type="button"
                className="changes-panel__confirm"
                disabled={busy}
                onClick={() => void keepOne(change.id)}
              >
                待确认
              </button>
              <button
                type="button"
                className="changes-panel__row-revert"
                title="撤回这条改动（按快照恢复文件）"
                disabled={busy || change.truncated}
                onClick={() => void revertOne(change.id)}
              >
                <Icon name="restart" size={12} />
              </button>
            </li>
          )
        })}
      </ul>

      {error ? <div className="changes-panel__error">{error}</div> : null}

      <div className="changes-panel__footer">
        <span className="changes-panel__count">改动 {changes.length}</span>
        <span className="changes-panel__spacer" />
        <button
          type="button"
          className="changes-panel__footer-btn"
          disabled={busy}
          title="按快照把所有改动恢复到改动前（无法恢复未存档内容的大文件）"
          onClick={() => void revertAll()}
        >
          <Icon name="restart" size={12} />
          撤回
        </button>
        <button
          type="button"
          className="changes-panel__footer-btn changes-panel__footer-btn--keep"
          disabled={busy}
          title="确认保留全部改动（从待确认列表移除）"
          onClick={() => void keepAll()}
        >
          <Icon name="check" size={12} />
          保留
        </button>
      </div>
    </div>
  )
}
