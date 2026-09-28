/**
 * 会话历史视图（活动栏第一个标签）
 *
 * 列表形制对齐 wuzu-client 的 CodeSessionHistory（按用户要求不带左侧头像图标）：
 *   - 标题：首条用户消息首行，截 50 字，加粗单行截断
 *   - 副标题：最后一条 AI 回复纯文本，截 60 字，灰色单行截断
 *   - 右侧：相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期）
 *   - 当前会话高亮；hover 浮现；点击切到该会话并展开右侧对话面板
 *
 * 引擎按最近活跃倒序返回（GET /conversation/sessions，title/lastReply 字段
 * 由引擎 SQL 直出首条用户消息与最后一条助手消息原文，纯文本化在前端做）。
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
  /** 首条用户消息原文（可能含附件结构 JSON，extractText 负责纯文本化） */
  title?: string
  /** 最后一条助手消息原文 */
  lastReply?: string
}

/** 标题：首条用户消息首行，纯文本化后截 50 字（对齐 wuzu displayTitle） */
function sessionTitle(item: SessionSummary): string {
  const raw = extractText(item.title ?? item.lastMessage).split('\n')[0].replace(/\s+/g, ' ').trim()
  if (!raw) return '未命名会话'
  return raw.length > 50 ? `${raw.slice(0, 50)}…` : raw
}

/** 副标题：最后一条 AI 回复，纯文本化后截 60 字（对齐 wuzu displaySubtitle） */
function sessionSubtitle(item: SessionSummary): string {
  const raw = extractText(item.lastReply ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw
}

/** 相对时间（对齐 wuzu formatRelative）：刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD */
function formatRelative(lastAt: number | undefined): string {
  if (!lastAt) return ''
  const time = new Date(lastAt)
  if (Number.isNaN(time.getTime())) return ''
  const min = Math.floor((Date.now() - lastAt) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const y = time.getFullYear()
  const md = `${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`
  return `${y}-${md}`
}

/** title 提示用绝对时间：YYYY-MM-DD HH:mm */
function formatAbsolute(lastAt: number | undefined): string {
  if (!lastAt) return ''
  const time = new Date(lastAt)
  if (Number.isNaN(time.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
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
            const title = sessionTitle(item)
            const subtitle = sessionSubtitle(item)
            return (
              <li key={item.sessionId}>
                <button
                  type="button"
                  className={`history-view__item${active ? ' is-active' : ''}`}
                  title={`${title}\n最后活跃：${formatAbsolute(item.lastAt)}`}
                  onClick={() => openSession(item.sessionId)}
                >
                  <span className="history-view__row">
                    <span className="history-view__summary">{title}</span>
                    <span className="history-view__time">{formatRelative(item.lastAt)}</span>
                  </span>
                  {subtitle ? (
                    <span className="history-view__subtitle">{subtitle}</span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
