import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import { horizontalWheelTarget } from '@renderer/core/platform/horizontal-scroll'
import { ContextMenu, type ContextMenuItem } from '@renderer/ui/ContextMenu'
import { Icon } from '@renderer/ui/icons'
import { messageNavPanelLayout, resolveActiveNavId } from './message-nav'
import './message-nav.css'

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

/** Short conversations expose each turn; long ones fold into a bounded list. */
export function MessageNavRail({
  sessionId,
  turns,
  containerRef,
  disabled,
  onCopy,
  onRetry,
  onRevert,
  onDelete,
  turnSelector = ':scope > .chat__turn[data-turn-id]',
  onNavigate,
  onTop,
  onBottom,
  navigationKey,
  className = ''
}: {
  sessionId: string
  turns: NavTurn[]
  /** 消息流滚动容器（跳转与联动高亮都以它为参照） */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** 流式进行中/多选模式下禁用重试类操作（与消息气泡工具条一致） */
  disabled: boolean
  onCopy: (message: ChatMessage) => void
  onRetry?: (message: ChatMessage) => void
  onRevert?: (message: ChatMessage) => void
  onDelete?: (message: ChatMessage) => void
  /** Work nests its turn anchors inside a bounded history window. */
  turnSelector?: string
  /** A windowed host mounts the requested turn before scrolling to it. */
  onNavigate?: (turn: NavTurn) => void
  onTop?: () => void
  onBottom?: () => void
  /** Recompute the active turn when the host replaces its mounted window. */
  navigationKey?: string | number | null
  className?: string
}): JSX.Element | null {
  const radar = turns.length > 10
  const visible = turns.length >= 2
  const storageKey = `aether:navMarks:${sessionId}`
  const [marks, setMarks] = useState<Record<string, string>>(() => readMarks(storageKey))
  /** 当前视口所处轮次（滚动联动） */
  const [scrollActiveId, setScrollActiveId] = useState<string | null>(null)
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const selection = useRef<{ messageId: string; edge?: 'top'; positioned: boolean } | null>(null)
  const currentTurns = useRef(turns)
  currentTurns.current = turns
  /** 右键菜单：记录命中的轮次与鼠标位置 */
  const [menu, setMenu] = useState<{ turn: NavTurn; x: number; y: number } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [layout, setLayout] = useState<ReturnType<typeof messageNavPanelLayout> | null>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const navRef = useRef<HTMLElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const [preview, setPreview] = useState<{ id: string; left: number; top: number; width: number } | null>(null)
  const expandedRef = useRef(false)
  const pointerInside = useRef(false)
  const keyboardFocus = useRef(false)
  const returningFocus = useRef(false)
  const menuOpen = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focusFrame = useRef(0)
  const panelId = useId()
  const previewId = useId()
  const activeId = turns.find(turn => turn.message.id === selectedMessageId)?.id ?? scrollActiveId
  const activeIndex = turns.findIndex(turn => turn.id === activeId)
  const previewIndex = turns.findIndex(turn => turn.id === preview?.id)
  const lastTurnId = turns.at(-1)?.id

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
    const anchors = Array.from(container.querySelectorAll<HTMLElement>(turnSelector))
      .filter((node) => Boolean(node.dataset.turnId))
      .map((node) => ({
        id: node.dataset.turnId!,
        top: node.getBoundingClientRect().top - containerTop + container.scrollTop
      }))
    // A deliberate jump must not be replaced by the viewport's reading probe:
    // several short turns may fit below it, or share the same clamped scroll
    // position near the end. Retain that cursor until the reading position moves.
    const requested = selection.current
    if (requested) {
      const turn = currentTurns.current.find(turn => turn.message.id === requested.messageId)
      const anchor = turn && anchors.find(anchor => anchor.id === turn.id)
      if (turn && !anchor) return // Work mounts older history asynchronously.
      if (anchor) {
        const maximum = Math.max(0, container.scrollHeight - container.clientHeight)
        const target = requested.edge === 'top' ? 0
          : Math.max(0, Math.min(maximum, anchor.top - 8))
        if (Math.abs(container.scrollTop - target) <= 2) { requested.positioned = true; return }
        // A restored anchor can exist before Work has fetched its full body.
        // The host owns that asynchronous jump; an old window is not a scroll away.
        if (!requested.positioned) return
      }
      selection.current = null
      setSelectedMessageId(null)
    }
    // A short final reply can start below the viewport probe even at the true
    // bottom. Only select the global last turn when its anchor is mounted;
    // the bottom of an older Work history window is not the conversation end.
    const atEnd = container.scrollHeight > container.clientHeight + 2 &&
      container.scrollHeight - container.clientHeight - container.scrollTop <= 2 &&
      anchors.at(-1)?.id === lastTurnId
    setScrollActiveId(atEnd && lastTurnId ? lastTurnId : resolveActiveNavId(anchors, probe))
  }, [containerRef, turnSelector, lastTurnId])

  // 监听器只绑一次（turns 每次消息变化都是新数组，放进依赖会让 scroll 监听反复重绑）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let raf = 0
    const onScroll = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(syncActive)
    }
    const inspect = (): void => {
      selection.current = null
      setSelectedMessageId(null)
      onScroll()
    }
    const onWheel = (event: WheelEvent): void => {
      if (!event.deltaY || event.defaultPrevented || event.ctrlKey || event.metaKey || horizontalWheelTarget(event)) return
      // Scrolling a code block or a nested transcript does not move the reading
      // position. If scroll chaining reaches the outer pane, syncActive handles it.
      for (let node = event.target instanceof Element ? event.target : null; node && node !== container; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) return
      }
      inspect()
    }
    const onPointerDown = (event: PointerEvent): void => { if (event.target === container) inspect() }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) inspect()
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('wheel', onWheel, { passive: true })
    container.addEventListener('touchmove', inspect, { passive: true })
    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('keydown', onKeyDown)
    syncActive()
    return () => {
      cancelAnimationFrame(raf)
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('touchmove', inspect)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('keydown', onKeyDown)
    }
  }, [containerRef, syncActive])

  // 轮次增减后（消息流变了，offsetTop 随之变化）重算一次当前高亮
  useEffect(() => {
    syncActive()
  }, [syncActive, turns, navigationKey])

  const jumpTo = useCallback(
    (turn: NavTurn) => {
      if (onNavigate) {
        selection.current = { messageId: turn.message.id, positioned: false }
        setSelectedMessageId(turn.message.id)
        onNavigate(turn)
        return
      }
      const container = containerRef.current
      if (!container) return
      const el = Array.from(container.querySelectorAll<HTMLElement>(turnSelector))
        .find((node) => node.dataset.turnId === turn.id)
      if (!el) return
      selection.current = { messageId: turn.message.id, positioned: true }
      setSelectedMessageId(turn.message.id)
      const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      container.scrollTop = Math.max(0, top - 8)
    },
    [containerRef, onNavigate, turnSelector]
  )

  const scrollToTop = useCallback(() => {
    const first = currentTurns.current[0]
    selection.current = first ? { messageId: first.message.id, edge: 'top', positioned: !onTop } : null
    setSelectedMessageId(first?.message.id ?? null)
    if (onTop) { onTop(); return }
    const container = containerRef.current
    if (container) container.scrollTop = 0
  }, [containerRef, onTop])

  const scrollToBottom = useCallback(() => {
    // Returning to the live tail must follow new turns, not pin the old last one.
    selection.current = null
    setSelectedMessageId(null)
    setScrollActiveId(currentTurns.current.at(-1)?.id ?? null)
    if (onBottom) { onBottom(); return }
    const container = containerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [containerRef, onBottom])

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
        ...(onRetry ? [{
          id: 'retry',
          label: '重新发送',
          hint: '删除此后的对话并重发',
          disabled,
          onSelect: () => onRetry(turn.message)
        }] : []),
        ...(onRevert ? [{
          id: 'revert',
          label: '回退到此处',
          hint: '撤销后续修改并回填原文',
          disabled,
          onSelect: () => onRevert(turn.message)
        }] : []),
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
        ...(onDelete ? [{
          id: 'delete',
          label: '删除本轮',
          danger: true,
          disabled,
          onSelect: () => onDelete(turn.message)
        }] : [])
      ]
    },
    [marks, disabled, onCopy, onRetry, onRevert, onDelete, setMark]
  )

  const openMenu = useCallback((turn: NavTurn, event: React.MouseEvent) => {
    event.preventDefault()
    menuOpen.current = true
    setMenu({ turn, x: event.clientX, y: event.clientY })
  }, [])

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  const measurePanel = useCallback(() => {
    const trigger = triggerRef.current, container = containerRef.current, nav = navRef.current
    if (!trigger || !container || !nav) return
    const pane = container.getBoundingClientRect()
    const anchor = nav.getBoundingClientRect()
    const next = messageNavPanelLayout(trigger.getBoundingClientRect(), {
      left: Math.max(8, pane.left - 26), right: Math.min(innerWidth - 8, pane.right - 4),
      top: Math.max(8, pane.top + 4), bottom: Math.min(innerHeight - 8, pane.bottom - 4)
    }, turns.length)
    // Code's animated pane establishes a fixed containing block. Keep the
    // bounded surface in the anchor's local coordinates so both modes agree.
    setLayout({ ...next, left: next.left - anchor.left, top: next.top - anchor.top })
  }, [containerRef, turns.length])

  const showPreview = useCallback((turn: NavTurn, row: HTMLElement) => {
    const container = containerRef.current, nav = navRef.current
    if (!container || !nav) return
    const pane = container.getBoundingClientRect(), anchor = row.getBoundingClientRect(), rail = nav.getBoundingClientRect()
    const leftBound = Math.max(8, pane.left), rightBound = Math.min(innerWidth - 8, pane.right - 4)
    const width = Math.min(292, Math.max(1, rightBound - leftBound))
    const height = previewRef.current?.offsetHeight ?? 88
    const left = Math.max(leftBound, Math.min(anchor.right + 8, rightBound - width)) - rail.left
    const top = Math.max(Math.max(8, pane.top + 4), Math.min((anchor.top + anchor.bottom - height) / 2,
      Math.min(innerHeight - 8, pane.bottom - 4) - height)) - rail.top
    setPreview(previous => previous?.id === turn.id && previous.left === left && previous.top === top && previous.width === width
      ? previous : { id: turn.id, left, top, width })
  }, [containerRef])

  useLayoutEffect(() => {
    if (!preview || radar) return
    const measure = (): void => {
      const turn = turns.find(turn => turn.id === preview.id)
      const row = Array.from(navRef.current?.querySelectorAll<HTMLElement>('.chat__nav-wave') ?? [])
        .find(row => row.dataset.turnId === preview.id)
      if (turn && row) showPreview(turn, row)
      else setPreview(null)
    }
    measure()
    const resize = new ResizeObserver(measure)
    if (containerRef.current) resize.observe(containerRef.current)
    window.addEventListener('resize', measure)
    return () => { resize.disconnect(); window.removeEventListener('resize', measure) }
  }, [preview?.id, radar, turns, containerRef, showPreview])

  const returnToTrigger = useCallback(() => {
    returningFocus.current = true
    triggerRef.current?.focus({ preventScroll: true })
    returningFocus.current = false
  }, [])

  const closePanel = useCallback((returnFocus = false) => {
    cancelClose()
    expandedRef.current = false
    setExpanded(false)
    if (returnFocus || listRef.current?.closest('.chat__nav-list')?.contains(document.activeElement)) returnToTrigger()
  }, [cancelClose, returnToTrigger])

  const openPanel = useCallback(() => {
    if (!radar) return
    cancelClose()
    measurePanel()
    if (expandedRef.current) return
    expandedRef.current = true
    setFocusedIndex(Math.max(0, turns.findIndex(turn => turn.id === activeId)))
    setExpanded(true)
  }, [activeId, cancelClose, measurePanel, turns, radar])

  // A short grace period bridges the gap between the small anchor and its list.
  // Keyboard reading stays open until focus leaves; pointer reading folds away.
  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      if (menuOpen.current || pointerInside.current || keyboardFocus.current && navRef.current?.contains(document.activeElement)) return
      closePanel()
      setPreview(null)
    }, 160)
  }, [cancelClose, closePanel])

  const focusTurn = useCallback((index: number) => {
    const next = Math.max(0, Math.min(turns.length - 1, index))
    if (radar) openPanel()
    setFocusedIndex(next)
    cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      const row = (radar ? listRef.current : navRef.current)?.querySelector<HTMLButtonElement>(`[data-nav-index="${next}"]`)
      row?.focus({ preventScroll: true })
      if (radar) revealNavRow(listRef.current, row)
    })
  }, [openPanel, turns.length, radar])

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    keyboardFocus.current = true
    if (event.key === 'Escape') {
      if (menuOpen.current) return
      event.preventDefault(); event.stopPropagation()
      if (radar) closePanel(true)
      setPreview(null)
      return
    }
    const target = event.target instanceof Element ? event.target : null
    const row = target?.closest<HTMLElement>('[data-nav-index]')
    const isTrigger = target === triggerRef.current
    if (!row && !isTrigger) return
    const index = row ? Number(row.dataset.navIndex) : Math.max(0, turns.findIndex(turn => turn.id === activeId))
    if (event.key === 'Home' || event.key === 'End' || ['ArrowDown', 'ArrowUp', 'ArrowRight'].includes(event.key)) {
      event.preventDefault()
      focusTurn(event.key === 'Home' ? 0 : event.key === 'End' ? turns.length - 1
        : isTrigger || event.key === 'ArrowRight' ? index : index + (event.key === 'ArrowDown' ? 1 : -1))
    } else if (row && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const rect = row.getBoundingClientRect()
      menuOpen.current = true
      setMenu({ turn: turns[index], x: rect.left + 16, y: rect.bottom })
    }
  }

  useEffect(() => {
    if (!expanded) return
    const container = containerRef.current
    const resize = new ResizeObserver(measurePanel)
    if (container) resize.observe(container)
    window.addEventListener('resize', measurePanel)
    const frame = requestAnimationFrame(() => {
      revealNavRow(listRef.current, listRef.current?.querySelector<HTMLElement>('[aria-current="true"]'))
    })
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      window.removeEventListener('resize', measurePanel)
    }
  }, [expanded, containerRef, measurePanel])

  useLayoutEffect(() => {
    if (expanded) revealNavRow(listRef.current, listRef.current?.querySelector<HTMLElement>('[aria-current="true"]'))
  }, [expanded, activeId])

  useEffect(() => {
    selection.current = null
    setSelectedMessageId(null)
    syncActive()
  }, [sessionId])

  useEffect(() => {
    closePanel()
    cancelAnimationFrame(focusFrame.current)
    setPreview(null)
    setFocusedIndex(0)
    pointerInside.current = false
    keyboardFocus.current = false
    menuOpen.current = false
    setMenu(null)
  }, [sessionId, radar, visible, closePanel])

  useEffect(() => () => {
    cancelClose()
    cancelAnimationFrame(focusFrame.current)
  }, [cancelClose])

  if (!visible) return null

  return (
    <nav
      ref={navRef}
      className={`chat__nav chat__nav--adaptive chat__nav--${radar ? 'radar' : 'waves'}${radar && expanded ? ' is-expanded' : ''}${className ? ` ${className}` : ''}`}
      aria-label="消息导航"
      data-variant={radar ? 'radar' : 'waves'}
      data-state={radar && expanded ? 'open' : 'closed'}
      onMouseEnter={() => { pointerInside.current = true; keyboardFocus.current = false; cancelClose() }}
      onMouseLeave={() => { pointerInside.current = false; scheduleClose() }}
      onPointerDown={() => { keyboardFocus.current = false }}
      onFocusCapture={event => {
        if (returningFocus.current) return
        if (!pointerInside.current) keyboardFocus.current = true
        if (event.target === triggerRef.current) openPanel()
      }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose() }}
      onKeyDown={onKeyDown}
    >
      <button type="button" className="chat__nav-btn chat__nav-edge" title="回到顶部" aria-label="回到顶部" onMouseEnter={() => setPreview(null)} onClick={scrollToTop}>
        <Icon name="chevron-double-up" size={16} />
      </button>
      {radar ? <>
        <button ref={triggerRef} type="button" className="chat__nav-trigger" aria-label="展开消息导航"
          aria-expanded={expanded} aria-controls={panelId} title="消息导航 · ↑↓ 浏览，Esc 收起"
          onMouseEnter={openPanel} onClick={openPanel}>
          <span className="chat__nav-radar" aria-hidden="true"><i /><i /><b /></span>
        </button>
        {/* Keep the long list mounted so leaving reverses the same centre-out motion. */}
        <div id={panelId} className="chat__nav-list" aria-hidden={!expanded} inert={!expanded}
          style={layout ? { left: layout.left, top: layout.top, width: layout.width, height: layout.height,
            '--nav-origin-y': `${layout.originY}px` } as CSSProperties : undefined}>
          <header className="chat__nav-heading">
            <span>消息</span>
            <small aria-label={activeIndex >= 0 ? `当前第 ${activeIndex + 1} 条，共 ${turns.length} 条` : `共 ${turns.length} 条`}>
              {activeIndex >= 0 ? `${activeIndex + 1} / ${turns.length}` : `${turns.length} 条`}
            </small>
            <div className="chat__nav-controls" role="group" aria-label="逐条浏览">
              <button type="button" className="chat__nav-btn" title="上一条" aria-label="上一条" disabled={activeIndex === 0} onClick={() => stepTurn(-1)}>
                <Icon name="chevron-up" size={14} />
              </button>
              <button type="button" className="chat__nav-btn" title="下一条" aria-label="下一条" disabled={activeIndex === turns.length - 1} onClick={() => stepTurn(1)}>
                <Icon name="chevron-down" size={14} />
              </button>
            </div>
          </header>
          <div className="chat__nav-entries" ref={listRef}>
            {turns.map((turn, index) => (
              <button key={turn.id} type="button"
                className={`chat__nav-item chat__nav-dot${turn.id === activeId ? ' is-active' : ''}`}
                data-nav-index={index} tabIndex={expanded && index === focusedIndex ? 0 : -1}
                title={turn.preview} aria-label={`跳转到：${turn.preview}`}
                aria-current={turn.id === activeId ? 'true' : undefined}
                onFocus={() => setFocusedIndex(index)} onClick={() => jumpTo(turn)}
                onContextMenu={event => openMenu(turn, event)}>
                <span className="chat__nav-item-dot" style={marks[turn.id] ? { background: marks[turn.id] } : undefined} />
                <span className="chat__nav-item-text">{turn.preview}</span>
              </button>
            ))}
          </div>
        </div>
      </> : <div className="chat__nav-waves">
        {turns.map((turn, index) => <button key={turn.id} type="button"
          className={`chat__nav-wave${turn.id === activeId ? ' is-active' : ''}${turn.id === preview?.id ? ' is-preview' : ''}${Math.abs(index - (previewIndex >= 0 ? previewIndex : activeIndex)) === 1 ? ' is-near' : ''}`}
          data-nav-index={index} data-turn-id={turn.id}
          tabIndex={index === Math.min(focusedIndex, turns.length - 1) ? 0 : -1}
          aria-label={`跳转到：${turn.preview}`} aria-current={turn.id === activeId ? 'true' : undefined}
          aria-describedby={turn.id === preview?.id ? previewId : undefined}
          onMouseEnter={event => showPreview(turn, event.currentTarget)}
          onFocus={event => { setFocusedIndex(index); showPreview(turn, event.currentTarget) }}
          onBlur={() => setPreview(null)}
          onClick={() => jumpTo(turn)} onContextMenu={event => openMenu(turn, event)}>
          <span className="chat__nav-wave-line" aria-hidden="true" style={marks[turn.id] ? { background: marks[turn.id] } : undefined} />
        </button>)}
      </div>}
      <button type="button" className="chat__nav-btn chat__nav-edge" title="回到底部" aria-label="回到底部" onMouseEnter={() => setPreview(null)} onClick={scrollToBottom}>
        <Icon name="chevron-double-down" size={16} />
      </button>
      {!radar && preview && turns[previewIndex] ? <div ref={previewRef} id={previewId} role="tooltip" className="chat__nav-preview"
        style={{ left: preview.left, top: preview.top, width: preview.width }}>
        <small>第 {previewIndex + 1} 条</small><span>{turns[previewIndex].preview}</span>
      </div> : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.turn)} onClose={() => {
          menuOpen.current = false; setMenu(null)
          if (!pointerInside.current) scheduleClose()
        }} />
      ) : null}
    </nav>
  )
}

/** Only the preview list should scroll; scrollIntoView also moves pane ancestors. */
function revealNavRow(list: HTMLElement | null, row: HTMLElement | null | undefined): void {
  if (!list || !row) return
  const top = row.offsetTop
  if (top < list.scrollTop) list.scrollTop = top
  else if (top + row.offsetHeight > list.scrollTop + list.clientHeight)
    list.scrollTop = top + row.offsetHeight - list.clientHeight
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
