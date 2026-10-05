import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { Icon } from '@renderer/workbench/icons'
import { resolveActiveNavId } from './message-nav'

/** 可选的标记颜色（存 localStorage 的是色值本身，换主题也不失真） */
const MARK_COLORS: { color: string; name: string }[] = [
  { color: '#f5a524', name: '橙色' },
  { color: '#4caf50', name: '绿色' },
  { color: '#42a5f5', name: '蓝色' },
  { color: '#ab47bc', name: '紫色' },
  { color: '#ef5350', name: '红色' }
]

export interface NavTurn {
  /** 轮次 ID（即本轮首条用户消息 ID，对应消息流里 .chat__turn 的 data-turn-id） */
  id: string
  /** 本轮的用户消息（右键菜单的操作对象） */
  message: ChatMessage
  /** 内容预览（悬停列表的条目文本） */
  preview: string
}

/**
 * 左侧消息导航栏（对齐 wuzu-client ConversationNavWidget，改为左侧 + 纯圆点）
 *
 * 每条用户消息一个圆点：点击跳转、滚动联动高亮当前轮次；
 * 右键圆点弹出该用户消息的全部操作（复制 / 重新发送 / 回退 / 删除）外加颜色标记。
 * 标记按会话存 localStorage，只影响圆点颜色，不动消息本身。
 *
 * 悬停整条栏会铺开展示消息列表（含预览），解决「几百条对话时圆点太密、
 * 看圆点认不出是哪条」的问题；栏底部带 到顶 / 上一条 / 下一条 / 到底 快捷按钮。
 *
 * 至少 2 条用户消息才显示 —— 单轮对话没有导航需求，一条竖线反而干扰。
 */
export function MessageNavRail({
  sessionId,
  turns,
  containerRef,
  disabled,
  onCopy,
  onRetry,
  onRevert,
  onDelete
}: {
  sessionId: string
  turns: NavTurn[]
  /** 消息流滚动容器（跳转与联动高亮都以它为参照） */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** 流式进行中/多选模式下禁用重试类操作（与消息气泡工具条一致） */
  disabled: boolean
  onCopy: (message: ChatMessage) => void
  onRetry: (message: ChatMessage) => void
  onRevert: (message: ChatMessage) => void
  onDelete: (message: ChatMessage) => void
}): JSX.Element | null {
  const storageKey = `aether:navMarks:${sessionId}`
  const [marks, setMarks] = useState<Record<string, string>>(() => readMarks(storageKey))
  /** 当前视口所处轮次（滚动联动） */
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 右键菜单：记录命中的轮次与鼠标位置 */
  const [menu, setMenu] = useState<{ turn: NavTurn; x: number; y: number } | null>(null)
  /** 悬停展开面板：锚定在导航栏右缘，按内容高度自然撑开 */
  const [listAnchor, setListAnchor] = useState<{ x: number; y: number } | null>(null)

  // 会话切换时换一份标记（storageKey 随 sessionId 变）
  useEffect(() => {
    setMarks(readMarks(storageKey))
  }, [storageKey])

  const setMark = useCallback(
    (turnId: string, color: string | null) => {
      setMarks((prev) => {
        const next = { ...prev }
        if (color) next[turnId] = color
        else delete next[turnId]
        try {
          localStorage.setItem(storageKey, JSON.stringify(next))
        } catch {
          /* 存储满/被禁用时标记只在本次会话内存活，不阻断操作 */
        }
        return next
      })
    },
    [storageKey]
  )

  // 滚动联动：视口顶部往下 1/3 处命中的轮次算「当前」，
  // 比「最近一个越过顶部的轮次」更符合人眼关注的区域
  const syncActive = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const probe = container.scrollTop + container.clientHeight / 3
    const containerTop = container.getBoundingClientRect().top
    // Only the outer turn wrappers are navigation anchors. MessageItem also puts
    // data-turn-id on each article; using querySelectorAll('[data-turn-id]') lets
    // those nested nodes overwrite the real turn id, so no dot can become active.
    const anchors = Array.from(container.children)
      .filter(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.classList.contains('chat__turn') && Boolean(node.dataset.turnId)
      )
      .map((node) => ({
        id: node.dataset.turnId!,
        top: node.getBoundingClientRect().top - containerTop + container.scrollTop
      }))
    setActiveId(resolveActiveNavId(anchors, probe))
  }, [containerRef])

  // 监听器只绑一次（turns 每次消息变化都是新数组，放进依赖会让 scroll 监听反复重绑）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let raf = 0
    const onScroll = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(syncActive)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    syncActive()
    return () => {
      cancelAnimationFrame(raf)
      container.removeEventListener('scroll', onScroll)
    }
  }, [containerRef, syncActive])

  // 轮次增减后（消息流变了，offsetTop 随之变化）重算一次当前高亮
  useEffect(() => {
    syncActive()
  }, [syncActive, turns])

  const jumpTo = useCallback(
    (turn: NavTurn) => {
      const container = containerRef.current
      if (!container) return
      const el = Array.from(container.children).find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement &&
          node.classList.contains('chat__turn') &&
          node.dataset.turnId === turn.id
      )
      if (!el) return
      const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      container.scrollTop = Math.max(0, top - 8)
      setActiveId(turn.id)
    },
    [containerRef]
  )

  const scrollToTop = useCallback(() => {
    const container = containerRef.current
    if (container) container.scrollTop = 0
  }, [containerRef])

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [containerRef])

  /** 上一条 / 下一条：以当前高亮轮次为基准步进；没有高亮时以滚动位置现算 */
  const stepTurn = useCallback(
    (direction: -1 | 1) => {
      if (turns.length === 0) return
      const index = turns.findIndex((turn) => turn.id === activeId)
      const next = index === -1 ? (direction === 1 ? 0 : turns.length - 1) : index + direction
      const clamped = Math.max(0, Math.min(turns.length - 1, next))
      jumpTo(turns[clamped])
    },
    [turns, activeId, jumpTo]
  )

  const menuItems = useCallback(
    (turn: NavTurn): ContextMenuItem[] => {
      const marked = marks[turn.id]
      return [
        { id: 'copy', label: '复制', onSelect: () => onCopy(turn.message) },
        {
          id: 'retry',
          label: '重新发送',
          hint: '删除此后的对话并重发',
          disabled,
          onSelect: () => onRetry(turn.message)
        },
        {
          id: 'revert',
          label: '回退到此处',
          hint: '撤销后续修改并回填原文',
          disabled,
          onSelect: () => onRevert(turn.message)
        },
        {
          id: 'mark',
          label: marked ? '更改标记' : '添加标记',
          onSelect: () => {},
          children: [
            ...MARK_COLORS.map(({ color, name }) => ({
              id: `mark-${color}`,
              label: marked === color ? `${name}（当前）` : name,
              swatch: color,
              onSelect: () => setMark(turn.id, color)
            })),
            ...(marked
              ? [{ id: 'mark-clear', label: '清除标记', onSelect: () => setMark(turn.id, null) }]
              : [])
          ]
        },
        {
          id: 'delete',
          label: '删除本轮',
          danger: true,
          disabled,
          onSelect: () => onDelete(turn.message)
        }
      ]
    },
    [marks, disabled, onCopy, onRetry, onRevert, onDelete, setMark]
  )

  const openMenu = useCallback((turn: NavTurn, event: React.MouseEvent) => {
    event.preventDefault()
    setMenu({ turn, x: event.clientX, y: event.clientY })
  }, [])

  /** 鼠标进入导航栏：记下位置，面板锚定在这附近（而不是占满整条消息区高度） */
  const handleEnter = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setListAnchor({ x: rect.right + 6, y: event.clientY })
  }, [])

  // 面板浮在导航栏右缘（与栏之间有 6px 间隙）：直接 leave 即关会让鼠标
  // 永远到不了面板。延迟 150ms 关闭，面板 onMouseEnter 时取消。
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleClose = useCallback(() => {
    closeTimer.current = setTimeout(() => setListAnchor(null), 150)
  }, [])
  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])
  useEffect(() => cancelClose, [cancelClose])

  if (turns.length < 2) return null

  return (
    <nav
      className={`chat__nav${listAnchor ? ' is-expanded' : ''}`}
      aria-label="消息导航"
      onMouseEnter={handleEnter}
      onMouseLeave={scheduleClose}
    >
      {/* 常态：圆点列 */}
      <div className="chat__nav-dots">
        {turns.map((turn) => {
          const mark = marks[turn.id]
          return (
            <button
              key={turn.id}
              type="button"
              className={`chat__nav-dot${turn.id === activeId ? ' is-active' : ''}`}
              style={mark ? { background: mark } : undefined}
              title={turn.preview}
              aria-label={`跳转到：${turn.preview}`}
              aria-current={turn.id === activeId ? 'true' : undefined}
              onClick={() => jumpTo(turn)}
              onContextMenu={(event) => openMenu(turn, event)}
            />
          )
        })}
      </div>

      {/* 悬停：铺开展示消息列表（fixed 浮层，锚定在鼠标进入处附近） */}
      {listAnchor ? (
        <div
          className="chat__nav-list"
          style={{
            left: listAnchor.x,
            top: Math.min(listAnchor.y, window.innerHeight - 200)
          }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {turns.map((turn) => {
            const mark = marks[turn.id]
            return (
              <button
                key={turn.id}
                type="button"
                className={`chat__nav-item${turn.id === activeId ? ' is-active' : ''}`}
                aria-current={turn.id === activeId ? 'true' : undefined}
                onClick={() => jumpTo(turn)}
                onContextMenu={(event) => openMenu(turn, event)}
              >
                <span
                  className="chat__nav-item-dot"
                  style={mark ? { background: mark } : undefined}
                />
                <span className="chat__nav-item-text">{turn.preview}</span>
              </button>
            )
          })}
        </div>
      ) : null}

      {/* 快捷按钮：到顶 / 上一条 / 下一条 / 到底 */}
      <div className="chat__nav-controls">
        <button
          type="button"
          className="chat__nav-btn"
          title="回到顶部"
          aria-label="回到顶部"
          onClick={scrollToTop}
        >
          <Icon name="chevron-double-up" size={16} />
        </button>
        <button
          type="button"
          className="chat__nav-btn"
          title="上一条"
          aria-label="上一条"
          onClick={() => stepTurn(-1)}
        >
          <Icon name="chevron-up" size={16} />
        </button>
        <button
          type="button"
          className="chat__nav-btn"
          title="下一条"
          aria-label="下一条"
          onClick={() => stepTurn(1)}
        >
          <Icon name="chevron" size={16} />
        </button>
        <button
          type="button"
          className="chat__nav-btn"
          title="回到底部"
          aria-label="回到底部"
          onClick={scrollToBottom}
        >
          <Icon name="chevron-double-down" size={16} />
        </button>
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.turn)} onClose={() => setMenu(null)} />
      ) : null}
    </nav>
  )
}

function readMarks(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}
