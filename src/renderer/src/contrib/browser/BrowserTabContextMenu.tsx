import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { BrowserTabState } from '@shared/browser'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'

/**
 * Context menu for a browser tab.
 *
 * The menu receives operations from BrowserView instead of calling the browser
 * bridge directly. This keeps the menu useful for both Code and Work surfaces,
 * and lets the owner serialize destructive actions and session sharing.
 */
export function BrowserTabContextMenu({
  tab,
  tabs,
  x,
  y,
  anchor,
  onClose,
  onNew,
  onDuplicate,
  onReload,
  onStop,
  onDevtools,
  onCopyAddress,
  onAddToChat,
  addToChatDisabled,
  addToChatHint,
  onCloseTab,
  onCloseOthers,
  onCloseRight,
  onCloseAll
}: {
  tab: BrowserTabState
  tabs: readonly BrowserTabState[]
  x: number
  y: number
  anchor: Element
  onClose: () => void
  onNew: () => void
  onDuplicate: () => void
  onReload: () => void
  onStop: () => void
  onDevtools: () => void
  onCopyAddress: () => void
  onAddToChat: () => void
  addToChatDisabled?: boolean
  addToChatHint?: string
  onCloseTab: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
  onCloseAll: () => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    host.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [tab.tabId])
  const close = (): void => {
    // Escape/selection return keyboard focus to the originating tab. A mouse
    // click outside can then focus its own destination normally.
    if (host.current?.contains(document.activeElement) && anchor instanceof HTMLElement) {
      const focusTarget = anchor.matches('[role="tab"]')
        ? anchor
        : anchor.querySelector<HTMLElement>('[role="tab"]')
      focusTarget?.focus({ preventScroll: true })
    }
    onClose()
  }
  const navigate = (event: KeyboardEvent): void => {
    const items = [
      ...(host.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        [])
    ]
    const current = items.findIndex((item) => item === document.activeElement)
    let next: number
    if (event.key === 'ArrowDown') next = (current + 1) % items.length
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Tab') {
      close()
      return
    } else return
    event.preventDefault()
    event.stopPropagation()
    items[next]?.focus()
  }
  const index = tabs.findIndex((item) => item.tabId === tab.tabId)
  const hasOtherTabs = tabs.length > 1
  const hasTabsRight = index >= 0 && index < tabs.length - 1
  const items: ContextMenuItem[] = [
    { id: 'new', label: '新建标签页', onSelect: onNew },
    { id: 'duplicate', label: '复制标签页', onSelect: onDuplicate },
    {
      id: 'reload',
      label: '重新加载',
      hint: 'Ctrl+R',
      onSelect: onReload
    },
    {
      id: 'stop',
      label: '停止加载',
      disabled: !tab.loading,
      onSelect: onStop
    },
    { id: 'copy-address', label: '复制网页地址', onSelect: onCopyAddress },
    { id: 'devtools', label: '开发者工具', onSelect: onDevtools },
    {
      id: 'add-to-chat',
      label: '添加到当前会话',
      hint: addToChatHint,
      disabled: addToChatDisabled,
      onSelect: onAddToChat
    },
    { id: 'close', label: '关闭标签页', hint: 'Ctrl+W', onSelect: onCloseTab },
    {
      id: 'close-others',
      label: '关闭其他标签页',
      disabled: !hasOtherTabs,
      onSelect: onCloseOthers
    },
    {
      id: 'close-right',
      label: '关闭右侧标签页',
      disabled: !hasTabsRight,
      onSelect: onCloseRight
    },
    { id: 'close-all', label: '关闭全部标签页', onSelect: onCloseAll }
  ]
  // BrowserView is a size-query container with overflow clipping. The menu
  // needs viewport coordinates and must also cover the native page surface.
  return createPortal(
    <div ref={host} className="browser-tab-menu-host" onKeyDownCapture={navigate}>
      <ContextMenu x={x} y={y} anchor={anchor} items={items} onClose={close} />
    </div>,
    document.body
  )
}

/** A single source of truth for mouse and keyboard tab-menu invocation. */
export function openBrowserTabContextMenu(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  open: (x: number, y: number, anchor: HTMLElement) => void
): void {
  const isKeyboard = !('clientX' in event)
  if (isKeyboard) {
    if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
    event.preventDefault()
    event.stopPropagation()
  } else {
    event.preventDefault()
    event.stopPropagation()
  }
  const anchor = event.currentTarget
  const rect = anchor.getBoundingClientRect()
  open(
    isKeyboard ? rect.left + Math.min(16, Math.max(4, rect.width / 2)) : event.clientX,
    isKeyboard ? rect.bottom : event.clientY,
    anchor
  )
}
