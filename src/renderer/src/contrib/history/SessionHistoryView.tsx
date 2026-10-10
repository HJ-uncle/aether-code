/**
 * 会话历史视图（活动栏第一个标签）
 *
 * 列表形制对齐 wuzu-client 的 CodeSessionHistory（按用户要求不带左侧头像图标）：
 *   - 标题：自定义名 > 首条用户消息首行（截 50 字）
 *   - 副标题：最后一条 AI 回复纯文本，截 60 字
 *   - 右侧：相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期）
 *   - 左侧标记色点 + 置顶 pin（对齐 wuzu 的 tagColor / pinned 展示位）
 *   - 右键菜单：置顶 / 重命名 / 收藏 / 标记（6 色色板）/ 打开项目目录 / 删除会话
 *   - 头部：☆ 只看收藏（带数量角标）、⇅ 排序菜单（4 字段 × 升降序）、新建、刷新
 *   - 排序：置顶永远在最前，其余按当前字段+方向；置顶区与非置顶区间一条分割线
 *
 * 本地元数据（名称/置顶/收藏/颜色/工作区）存 session-meta.ts（localStorage 单 key），
 * 引擎不参与 —— 这些是纯界面偏好。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource, isRemoteEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { extractText } from '@renderer/core/engine/useChat'
import { showChatPanel } from '@renderer/core/platform/layout-state'
import { openFolderAt } from '@renderer/core/workspace/workspace-store'
import { Icon } from '@renderer/workbench/icons'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Dialog } from '@renderer/workbench/Dialog'
import {
  SESSION_TAG_COLORS,
  getSessionMetaTable,
  patchSessionMeta,
  removeSessionMeta,
  subscribeSessionMeta
} from './session-meta'
import {
  listPendingSessions,
  prunePendingSessions,
  registerPendingSession,
  removePendingSession,
  subscribePendingSessions,
  subscribeSessionListRefresh
} from './pending-sessions'

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

/** 排序字段（对齐 wuzu 排序菜单四项）；createdAt 引擎不下发，用 sessionId 里不可靠——退化为与 updatedAt 同义的 lastAt 低优先级替代不可行，故名称/颜色之外只有时间序 */
type SortField = 'updatedAt' | 'title' | 'tagColor'
interface SortState {
  field: SortField
  order: 'asc' | 'desc'
}

const SORT_FIELD_LABELS: Record<SortField, string> = {
  updatedAt: '按最后会话时间',
  title: '按名称',
  tagColor: '按标记颜色'
}

/** 标题：自定义名 > 首条用户消息首行，纯文本化后截 50 字（对齐 wuzu displayTitle） */
function sessionTitle(item: SessionSummary, customName?: string): string {
  if (customName?.trim()) return customName.trim()
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
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

function tagColorDot(colorKey: string | undefined): string | null {
  return SESSION_TAG_COLORS.find((c) => c.key === colorKey)?.dot ?? null
}

export function SessionHistoryView(): JSX.Element {
  const { ready, settings, updateSettings } = useApp()
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const refreshGeneration = useRef(0)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 头部 ☆：只看收藏（对齐 wuzu segment 切换的本地收藏过滤） */
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [sort, setSort] = useState<SortState>({ field: 'updatedAt', order: 'desc' })
  /** 右键菜单：命中的会话 + 视口坐标 */
  const [menu, setMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null)
  /** 标记色板（在原菜单位置弹出的二级面板，对齐 wuzu openTagPanel） */
  const [tagPanel, setTagPanel] = useState<{ x: number; y: number; sessionId: string } | null>(null)
  /** 排序菜单 */
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null)
  /** 重命名弹窗 */
  const [renaming, setRenaming] = useState<{ sessionId: string; value: string } | null>(null)

  const metaTable = useSyncExternalStore(subscribeSessionMeta, getSessionMetaTable)
  const pendingSessions = useSyncExternalStore(subscribePendingSessions, listPendingSessions)

  const refresh = useCallback(async () => {
    if (!ready || source !== getEngineSource()) return
    const generation = ++refreshGeneration.current
    setLoading(true)
    setError(null)
    try {
      const rows = await requestOrThrow<SessionSummary[]>({
        method: 'GET',
        path: '/conversation/sessions'
      })
      if (source !== getEngineSource() || generation !== refreshGeneration.current) return
      const list = Array.isArray(rows) ? rows : []
      setSessions(list)
      // 引擎开始返回该会话后，对应的本地占位条目退场，避免同一条会话出现两行
      prunePendingSessions(new Set(list.map((item) => item.sessionId)))
    } catch (err) {
      if (source !== getEngineSource() || generation !== refreshGeneration.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (source === getEngineSource() && generation === refreshGeneration.current) setLoading(false)
    }
  }, [ready, source])

  useEffect(() => subscribeEngineSource(() => {
    refreshGeneration.current++
    setSessions([])
    setLoading(false)
    setError(null)
    setMenu(null)
    setTagPanel(null)
    setRenaming(null)
  }), [])

  // 引擎就绪 / 当前会话变化（新会话发出第一条消息后会出现在列表里）时刷新。
  // refresh 开头会同步 setState，挪进微任务避免 effect 执行期内联触发级联渲染
  useEffect(() => {
    void Promise.resolve().then(refresh)
  }, [refresh, settings.lastSessionId])

  // 回合结束信号：首条消息落库后引擎才开始返回该会话，此时 lastSessionId
  // 没变，上面的 effect 不会触发；收到信号重新拉取，让本地占位条目退场。
  // 同样挪进微任务，避免订阅回调在 effect 执行期内联触发级联渲染
  useEffect(
    () => subscribeSessionListRefresh(() => void Promise.resolve().then(refresh)),
    [refresh]
  )

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
    // 引擎只列举「有对话记录」的会话，空会话不会出现；先登记本地占位条目，
    // 新会话立刻出现在列表顶部（发出首条消息、引擎落库后该占位自动退场）
    registerPendingSession(generated)
    void updateSettings({ lastSessionId: generated }).then(() => showChatPanel())
  }, [updateSettings])

  // ── 右键菜单动作 ──────────────────────────────────────────────────────────

  const togglePin = useCallback((sessionId: string) => {
    patchSessionMeta(sessionId, { pinned: !metaTable[sessionId]?.pinned })
  }, [metaTable])

  const toggleFavorite = useCallback((sessionId: string) => {
    patchSessionMeta(sessionId, { favorite: !metaTable[sessionId]?.favorite })
  }, [metaTable])

  const startRename = useCallback((sessionId: string) => {
    const item = sessions.find((s) => s.sessionId === sessionId)
    setRenaming({ sessionId, value: sessionTitle(item ?? { sessionId }, metaTable[sessionId]?.name) })
  }, [sessions, metaTable])

  const commitRename = useCallback(() => {
    if (!renaming) return
    const value = renaming.value.trim()
    // 空名 = 清除自定义名，回到引擎标题
    patchSessionMeta(renaming.sessionId, { name: value || undefined })
    setRenaming(null)
  }, [renaming])

  const openProjectDir = useCallback(
    (sessionId: string) => {
      if (isRemoteEngine() || source !== getEngineSource()) return
      const workspacePath = metaTable[sessionId]?.workspacePath
      if (!workspacePath) {
        void confirmDialog({
          title: '打开项目目录',
          body: '这个会话还没有记录过项目目录（在该会话里发过消息后才会记录）。',
          confirmText: '知道了'
        })
        return
      }
      // 切工作区 + 切会话，两步都做完这条会话就在它原本的项目里打开了
      openFolderAt(workspacePath)
      void updateSettings({ lastSessionId: sessionId }).then(() => showChatPanel())
    },
    [metaTable, updateSettings, source]
  )

  const deleteSession = useCallback(
    (sessionId: string) => {
      // Session deletion is an engine-owned operation and is available for
      // remote connections too. Remote mode only blocks local workspace actions.
      if (source !== getEngineSource()) return
      const item = sessions.find((s) => s.sessionId === sessionId)
      const title = sessionTitle(item ?? { sessionId }, metaTable[sessionId]?.name)
      void confirmDialog({
        title: '删除会话',
        body: `删除「${title}」？引擎侧的对话记录会一并删除，不可恢复。`,
        danger: true,
        confirmText: '删除'
      }).then((confirmed) => {
        if (!confirmed || source !== getEngineSource()) return
        // 删的是当前会话：先换一个新 ID，避免删除后还挂在已销毁的会话上
        const isCurrent = sessionId === settings.lastSessionId
        // 刚新建、还没发过消息的会话在引擎侧没有记录，DELETE 会失败；
        // 这类会话只需清掉本地占位条目，不算删除失败
        const isPending = pendingSessions.some((item) => item.sessionId === sessionId)
        void requestOrThrow({
          method: 'DELETE',
          path: `/sessions/${encodeURIComponent(sessionId)}`,
          query: { keepWorkspace: 'true' }
        })
          .catch((err: unknown) => {
            if (!isPending) throw err
            return undefined
          })
          .then(() => {
            if (source !== getEngineSource()) return
            removeSessionMeta(sessionId)
            removePendingSession(sessionId)
            if (isCurrent) {
              const generated = globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}`
              return updateSettings({ lastSessionId: generated })
            }
            return undefined
          })
          .then(() => {
            if (source === getEngineSource()) return refresh()
            return undefined
          })
          .catch((err) => {
            if (source !== getEngineSource()) return
            void confirmDialog({
              title: '删除失败',
              body: err instanceof Error ? err.message : String(err),
              confirmText: '知道了'
            })
          })
      })
    },
    [sessions, pendingSessions, metaTable, settings.lastSessionId, updateSettings, refresh, source]
  )

  // ── 派生列表：过滤（只看收藏）→ 排序（置顶恒前）──────────────────────────

  const favoriteCount = useMemo(
    () => sessions.filter((s) => metaTable[s.sessionId]?.favorite).length,
    [sessions, metaTable]
  )

  const visibleSessions = useMemo(() => {
    // 引擎只列举有对话记录的会话；本地占位条目（刚新建、还没发过消息）按 sessionId
    // 去重后并入，新会话才会立刻出现在列表里
    const known = new Set(sessions.map((s) => s.sessionId))
    const pending: SessionSummary[] = pendingSessions
      .filter((item) => !known.has(item.sessionId))
      .map((item) => ({
        sessionId: item.sessionId,
        lastAt: item.lastAt,
        messageCount: 0,
        title: '未命名会话'
      }))
    const merged = [...pending, ...sessions]
    const filtered = favoritesOnly
      ? merged.filter((s) => metaTable[s.sessionId]?.favorite)
      : merged
    const tagOrder = new Map(SESSION_TAG_COLORS.map((c, index) => [c.key, index]))
    const dir = sort.order === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      // 置顶恒前（对齐 wuzu pb - pa）；置顶之间仍按当前字段排
      const pa = metaTable[a.sessionId]?.pinned ? 1 : 0
      const pb = metaTable[b.sessionId]?.pinned ? 1 : 0
      if (pa !== pb) return pb - pa
      switch (sort.field) {
        case 'title':
          return (
            sessionTitle(a, metaTable[a.sessionId]?.name).localeCompare(
              sessionTitle(b, metaTable[b.sessionId]?.name),
              'zh'
            ) * dir
          )
        case 'tagColor': {
          // 有标记的在前；颜色间按色板固定顺序；同色内按时间（对齐 wuzu）
          const ca = metaTable[a.sessionId]?.color
          const cb = metaTable[b.sessionId]?.color
          if (!ca && !cb) return ((a.lastAt ?? 0) - (b.lastAt ?? 0)) * dir
          if (!ca) return 1
          if (!cb) return -1
          const oa = tagOrder.get(ca) ?? 99
          const ob = tagOrder.get(cb) ?? 99
          if (oa !== ob) return oa - ob
          return ((a.lastAt ?? 0) - (b.lastAt ?? 0)) * dir
        }
        default:
          return ((a.lastAt ?? 0) - (b.lastAt ?? 0)) * dir
      }
    })
  }, [sessions, pendingSessions, favoritesOnly, sort, metaTable])

  /** 第一条非置顶项的 id：置顶区与非置顶区之间画分割线（对齐 wuzu） */
  const firstUnpinnedId = useMemo(
    () => visibleSessions.find((s) => !metaTable[s.sessionId]?.pinned)?.sessionId ?? null,
    [visibleSessions, metaTable]
  )

  // ── 菜单定义 ──────────────────────────────────────────────────────────────

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!menu) return []
    const meta = metaTable[menu.sessionId]
    return [
      {
        id: 'toggle-pin',
        label: meta?.pinned ? '取消置顶' : '置顶',
        onSelect: () => {
          setMenu(null)
          togglePin(menu.sessionId)
        }
      },
      {
        id: 'rename',
        label: '重命名',
        onSelect: () => {
          const id = menu.sessionId
          setMenu(null)
          startRename(id)
        }
      },
      {
        id: 'favorite',
        label: meta?.favorite ? '取消收藏' : '收藏',
        onSelect: () => {
          setMenu(null)
          toggleFavorite(menu.sessionId)
        }
      },
      {
        id: 'tag-color',
        label: '标记',
        onSelect: () => {
          // 在原菜单位置弹色板（对齐 wuzu openTagPanel 的位置记忆）
          setTagPanel({ x: menu.x, y: menu.y, sessionId: menu.sessionId })
          setMenu(null)
        }
      },
      {
        id: 'open-dir',
        label: '打开项目目录',
        disabled: isRemoteEngine(),
        onSelect: () => {
          setMenu(null)
          openProjectDir(menu.sessionId)
        }
      },
      {
        id: 'delete',
        label: '删除会话',
        danger: true,
        onSelect: () => {
          setMenu(null)
          deleteSession(menu.sessionId)
        }
      }
    ]
  }, [menu, metaTable, togglePin, toggleFavorite, startRename, openProjectDir, deleteSession])

  const sortMenuItems = useMemo((): ContextMenuItem[] => {
    const fields: SortField[] = ['updatedAt', 'title', 'tagColor']
    return [
      ...fields.map((field) => ({
        id: `field-${field}`,
        label: `${sort.field === field ? '✓ ' : ''}${SORT_FIELD_LABELS[field]}`,
        onSelect: () => {
          setSort((s) => ({ ...s, field }))
          setSortMenu(null)
        }
      })),
      {
        id: 'order-desc',
        label: `${sort.order === 'desc' ? '✓ ' : ''}降序`,
        onSelect: () => {
          setSort((s) => ({ ...s, order: 'desc' }))
          setSortMenu(null)
        }
      },
      {
        id: 'order-asc',
        label: `${sort.order === 'asc' ? '✓ ' : ''}升序`,
        onSelect: () => {
          setSort((s) => ({ ...s, order: 'asc' }))
          setSortMenu(null)
        }
      }
    ]
  }, [sort])

  return (
    <div className="history-view">
      <div className="history-view__toolbar">
        <span className="history-view__title">会话历史</span>
        <div className="history-view__toolbar-spacer" />
        <button
          type="button"
          className={`history-view__refresh${favoritesOnly ? ' is-active' : ''}`}
          aria-label={favoritesOnly ? '显示全部会话' : '只看收藏的会话'}
          title={favoritesOnly ? '显示全部会话' : '只看收藏的会话'}
          onClick={() => setFavoritesOnly((v) => !v)}
        >
          <Icon name={favoritesOnly ? 'star' : 'star-outline'} size={16} />
          {favoriteCount > 0 ? (
            <span className="history-view__badge">{favoriteCount}</span>
          ) : null}
        </button>
        <button
          type="button"
          className="history-view__refresh"
          aria-label="排序方式"
          title={`排序：${SORT_FIELD_LABELS[sort.field]} · ${sort.order === 'desc' ? '降序' : '升序'}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setSortMenu({ x: rect.left, y: rect.bottom + 4 })
          }}
        >
          <Icon name="sort" size={16} />
        </button>
        <button
          type="button"
          className="history-view__refresh"
          aria-label="新建会话"
          title="新建会话"
          disabled={!ready}
          onClick={createSession}
        >
          <Icon name="plus" size={16} />
        </button>
        <button
          type="button"
          className="history-view__refresh"
          aria-label="刷新会话列表"
          title="刷新会话列表"
          disabled={loading || !ready}
          onClick={() => void refresh()}
        >
          <Icon name="restart" size={16} />
        </button>
      </div>

      {!ready ? (
        <div className="history-view__empty">引擎未就绪，就绪后显示历史会话。</div>
      ) : error ? (
        <div className="history-view__empty history-view__empty--error">加载失败：{error}</div>
      ) : visibleSessions.length === 0 ? (
        <div className="history-view__empty">
          {loading
            ? '正在加载…'
            : favoritesOnly
              ? '没有收藏的会话。右键会话可以收藏。'
              : '暂无历史会话。开始对话后，记录会出现在这里。'}
        </div>
      ) : (
        <ul className="history-view__list">
          {visibleSessions.map((item) => {
            const active = item.sessionId === settings.lastSessionId
            const meta = metaTable[item.sessionId]
            const title = sessionTitle(item, meta?.name)
            const subtitle = sessionSubtitle(item)
            const dot = tagColorDot(meta?.color)
            return (
              <li key={item.sessionId}>
                {item.sessionId === firstUnpinnedId && visibleSessions[0]?.sessionId !== firstUnpinnedId ? (
                  <div className="history-view__divider" />
                ) : null}
                <button
                  type="button"
                  className={`history-view__item${active ? ' is-active' : ''}`}
                  data-session-id={item.sessionId}
                  title={`${title}\n最后活跃：${formatAbsolute(item.lastAt)}`}
                  onClick={() => openSession(item.sessionId)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setMenu({ x: event.clientX, y: event.clientY, sessionId: item.sessionId })
                  }}
                >
                  {dot ? (
                    <span className="history-view__tag" style={{ background: dot }} />
                  ) : null}
                  <span className="history-view__main">
                    <span className="history-view__row">
                      {meta?.pinned ? (
                        <Icon name="pin" size={16} className="history-view__pin" />
                      ) : null}
                      <span className="history-view__summary">{title}</span>
                      <span className="history-view__time">{formatRelative(item.lastAt)}</span>
                    </span>
                    {subtitle ? (
                      <span className="history-view__subtitle">{subtitle}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={contextMenuItems} onClose={() => setMenu(null)} />
      ) : null}

      {sortMenu ? (
        <ContextMenu x={sortMenu.x} y={sortMenu.y} items={sortMenuItems} onClose={() => setSortMenu(null)} />
      ) : null}

      {tagPanel ? (
        <>
          {/* 透明遮罩：点面板外任意处关闭（对齐 ContextMenu 的 dismiss 行为） */}
          <button
            type="button"
            className="tag-panel__backdrop"
            aria-label="关闭标记面板"
            onClick={() => setTagPanel(null)}
          />
          <div className="tag-panel" style={{ left: tagPanel.x, top: tagPanel.y }}>
            <div className="tag-panel__grid">
              <button
                type="button"
                className="tag-panel__clear"
                onClick={() => {
                  patchSessionMeta(tagPanel.sessionId, { color: undefined })
                  setTagPanel(null)
                }}
              >
                清除
              </button>
              {SESSION_TAG_COLORS.map((color) => (
                <button
                  key={color.key}
                  type="button"
                  className="tag-panel__dot"
                  title={color.label}
                  style={{ background: color.dot }}
                  onClick={() => {
                    patchSessionMeta(tagPanel.sessionId, { color: color.key })
                    setTagPanel(null)
                  }}
                />
              ))}
            </div>
          </div>
        </>
      ) : null}

      {renaming ? (
        <Dialog
          title="重命名会话"
          onClose={() => setRenaming(null)}
          footer={
            <>
              <button type="button" className="btn btn--sm" onClick={() => setRenaming(null)}>
                取消
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={commitRename}>
                确定
              </button>
            </>
          }
        >
          <input
            type="text"
            className="history-view__rename-input"
            maxLength={60}
            autoFocus
            value={renaming.value}
            placeholder="留空则恢复默认标题"
            onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') setRenaming(null)
            }}
          />
        </Dialog>
      ) : null}
    </div>
  )
}
