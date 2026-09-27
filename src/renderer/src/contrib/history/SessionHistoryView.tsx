/**
 * 会话历史视图（活动栏第一个标签）
 *
 * 列出引擎里所有有对话记录的会话（GET /conversation/sessions，
 * 引擎按最近活跃倒序返回）。点击条目把 lastSessionId 切到该会话：
 * ChatView 的 sessionId 跟随 settings.lastSessionId，切换后自动
 * 回放引擎侧历史，右侧对话面板随之恢复现场。
 */
import { useCallback, useEffect, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { requestOrThrow } from '@renderer/core/engine/client'
import { extractText } from '@renderer/core/engine/useChat'
import { showChatPanel } from '@renderer/core/platform/layout-state'
import { Icon } from '@renderer/workbench/icons'

/** GET /conversation/sessions 的 data 项（lastAt 已由引擎换算为毫秒时间戳） */
interface SessionSummary {
  sessionId: string
  lastMessage?: unknown
  lastAt?: number
  messageCount?: number
  agentId?: string | null
}

function summarize(content: unknown): string {
  const text = extractText(content).replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || '（无文本内容）'
}

/** lastAt 是毫秒时间戳（引擎侧已乘 1000）；今天显示时刻，更早显示日期 */
function formatTime(lastAt: number | undefined): string {
  if (!lastAt) return ''
  const date = new Date(lastAt)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hm
  const md = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}-${md}`
}

export function SessionHistoryView(): JSX.Element {
  const { ready, settings, updateSettings } = useApp()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!ready) return
    setLoading(true)
    setError(null)
    try {
      const rows = await requestOrThrow<SessionSummary[]>({
        method: 'GET',
        path: '/conversation/sessions'
      })
      setSessions(Array.isArray(rows) ? rows : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [ready])

  // 引擎就绪 / 当前会话变化（新会话发出第一条消息后会出现在列表里）时刷新。
  // refresh 开头会同步 setState，挪进微任务避免 effect 执行期内联触发级联渲染
  useEffect(() => {
    void Promise.resolve().then(refresh)
  }, [refresh, settings.lastSessionId])

  const openSession = useCallback(
    (sessionId: string) => {
      if (sessionId === settings.lastSessionId) {
        showChatPanel()
        return
      }
      void updateSettings({ lastSessionId: sessionId }).then(() => showChatPanel())
    },
    [settings.lastSessionId, updateSettings]
  )

  // 新建会话：换一个新的 sessionId 即可 —— ChatView 的会话 ID 跟随设置，
  // 切换后回放到的历史为空，等于开了一条全新对话，不引入额外的会话对象
  const createSession = useCallback(() => {
    const generated = globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}`
    void updateSettings({ lastSessionId: generated }).then(() => showChatPanel())
  }, [updateSettings])

  return (
    <div className="history-view">
      <div className="history-view__toolbar">
        <span className="history-view__title">会话历史</span>
        <div className="history-view__toolbar-spacer" />
        <button
          type="button"
          className="history-view__refresh"
          aria-label="新建会话"
          title="新建会话"
          disabled={!ready}
          onClick={createSession}
        >
          <Icon name="plus" size={13} />
        </button>
        <button
          type="button"
          className="history-view__refresh"
          aria-label="刷新会话列表"
          title="刷新会话列表"
          disabled={loading || !ready}
          onClick={() => void refresh()}
        >
          <Icon name="restart" size={13} />
        </button>
      </div>

      {!ready ? (
        <div className="history-view__empty">引擎未就绪，就绪后显示历史会话。</div>
      ) : error ? (
        <div className="history-view__empty history-view__empty--error">加载失败：{error}</div>
      ) : sessions.length === 0 ? (
        <div className="history-view__empty">
          {loading ? '正在加载…' : '暂无历史会话。开始对话后，记录会出现在这里。'}
        </div>
      ) : (
        <ul className="history-view__list">
          {sessions.map((item) => {
            const active = item.sessionId === settings.lastSessionId
            return (
              <li key={item.sessionId}>
                <button
                  type="button"
                  className={`history-view__item${active ? ' is-active' : ''}`}
                  title={`${item.sessionId}${item.agentId ? ` · agent: ${item.agentId}` : ''}`}
                  onClick={() => openSession(item.sessionId)}
                >
                  <span className="history-view__summary">{summarize(item.lastMessage)}</span>
                  <span className="history-view__meta">
                    <span className="history-view__time">{formatTime(item.lastAt)}</span>
                    {typeof item.messageCount === 'number' ? (
                      <span className="history-view__count">{item.messageCount} 条</span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
