import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useMotionPresence, useMotionValue } from '../ui/MotionPresence'
import { OverlayScope, useOverlay } from '../ui/overlay'
import { executeCommand } from '@renderer/core/platform/commands'
import { getKeybindingHint } from '@renderer/core/platform/keybindings'
import { openAppSettings } from '@renderer/features/settings/app-settings-navigation'
import { AccountMenu } from '@renderer/features/account/AccountMenu'
import { Icon } from '@renderer/ui/icons'
import brandIcon from '@renderer/assets/icon.png'
import '../ui/menu-bar.css'
import {
  getUserKeybindingRules,
  onUserKeybindingsChanged
} from '@renderer/core/platform/user-keybindings'

interface MenuEntry {
  label: string
  command: string
}
interface Menu {
  label: string
  items: MenuEntry[]
}
/**
 * 顶部菜单栏（对标 VS Code 的 Title Bar + Menu Bar）
 *
 * 菜单项只是「命令 ID」的列表 —— 命令在 contrib 里已注册，这里不写任何实现，
 * 与键位面板/命令面板共享同一套动作，保证入口唯一。
 * 键位提示运行时查询键位表（优先用户自定义），不硬编码。
 */
const SESSION_MENUS: Menu[] = [
  { label: '文件', items: [{ label: '新任务', command: 'aether.work.new' }] },
  {
    label: '查看',
    items: [
      { label: '命令面板', command: 'aether.commandPalette.toggle' },
      { label: '设置', command: 'aether.view.appSettings' }
    ]
  },
  { label: '帮助', items: [{ label: '重启引擎', command: 'aether.engine.restart' }] }
]
const COMPACT_MENU = '应用菜单'

/**
 * 窗口控制按钮（最小化 / 最大化-还原 / 关闭）
 *
 * 无边框窗口（frame: false）没有系统按钮，必须自绘。
 * 最大化状态订阅 window 的 resize：窗口被拖到屏幕边缘触发系统最大化时
 * （不经过我们的按钮），图标也要跟着变成「还原」。
 */
function WindowControls(): JSX.Element | null {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    const sync = (): void => {
      void window.aether.window.isMaximized().then((v) => {
        if (alive) setMaximized(v)
      })
    }
    sync()
    // resize 是窗口尺寸变化的可靠信号（最大化/还原/拖拽边缘都会触发）
    window.addEventListener('resize', sync)
    return () => {
      alive = false
      window.removeEventListener('resize', sync)
    }
  }, [])

  // 无边框仅在非 macOS 启用；macOS 保留原生红绿灯，不重复画一套
  if (!window.aether?.window) return null

  return (
    <div className="menu-bar__win">
      <button
        type="button"
        className="menu-bar__win-btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => void window.aether.window.minimize()}
      >
        <Icon name="minimize" size={16} />
      </button>
      <button
        type="button"
        className="menu-bar__win-btn"
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => void window.aether.window.toggleMaximize()}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} size={16} />
      </button>
      <button
        type="button"
        className="menu-bar__win-btn menu-bar__win-btn--close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void window.aether.window.close()}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}

export function MenuBar(): JSX.Element {
  // open 持有触发按钮的矩形：下拉 portal 到 body 后靠它定位（见下方说明）
  const [open, setOpen] = useState<{ label: string; anchor: DOMRect; keyboard?: boolean } | null>(null)
  const dropdownMotion = useMotionPresence(Boolean(open))
  const shownMenu = useMotionValue(open)
  const ref = useRef<HTMLElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const overlay = useOverlay({ open: Boolean(open), present: dropdownMotion.present, panelRef: dropdownRef,
    triggerRef: ref, onClose: () => {
      if (dropdownRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
      setOpen(null)
    }, restoreFocus: false })
  const menus = SESSION_MENUS
  // 订阅用户键位变化：自定义快捷键后菜单提示立即跟随
  useSyncExternalStore(onUserKeybindingsChanged, getUserKeybindingRules)

  const close = (restoreFocus = false): void => {
    setOpen(null)
    if (restoreFocus) triggerRef.current?.focus()
  }
  const toggleMenu = (button: HTMLButtonElement, label: string, keyboard = false): void => {
    triggerRef.current = button
    setOpen(previous => previous?.label === label && !keyboard ? null : { label, anchor: button.getBoundingClientRect(), keyboard })
  }
  useEffect(() => {
    if (open?.keyboard) dropdownRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [open])
  useEffect(() => {
    // A responsive switch can remove the old anchor; do not leave its portal floating.
    const resized = (): void => setOpen(null)
    window.addEventListener('resize', resized)
    return () => window.removeEventListener('resize', resized)
  }, [])

  return (
    <header className="menu-bar" ref={ref}>
      <span className="menu-bar__brand">
        <img className="menu-bar__logo" src={brandIcon} alt="" draggable={false} />
        <span className="menu-bar__brand-name">Aether</span>
      </span>
      <div className="menu-bar__menus">
      {menus.map((menu) => (
        <div key={menu.label} className="menu-bar__menu">
          <button
            type="button"
            className={`menu-bar__trigger${open?.label === menu.label ? ' is-open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open?.label === menu.label}
            onClick={(event) => toggleMenu(event.currentTarget, menu.label)}
            onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); toggleMenu(event.currentTarget, menu.label, true) } }}
            // 悬停切换：VS Code 同款交互 —— 点开一个后划过去即换菜单
            onMouseEnter={(event) => {
              if (open) {
                triggerRef.current = event.currentTarget
                setOpen({ label: menu.label, anchor: event.currentTarget.getBoundingClientRect() })
              }
            }}
          >
            {menu.label}
          </button>
        </div>
      ))}
      </div>
      <button type="button" className={`menu-bar__trigger menu-bar__compact-trigger${open?.label === COMPACT_MENU ? ' is-open' : ''}`}
        aria-label={COMPACT_MENU} aria-haspopup="menu" aria-expanded={open?.label === COMPACT_MENU}
        onClick={event => toggleMenu(event.currentTarget, COMPACT_MENU)}
        onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); toggleMenu(event.currentTarget, COMPACT_MENU, true) } }}>
        菜单 <Icon name="chevron-down" size={12} />
      </button>
      {/* 下拉 portal 到 body：菜单栏自身带 backdrop-filter，是 backdrop root，
          嵌在里面的模糊浮层采不到栏下方的真实内容（只能采到栏自己的半透明底色），
          磨砂直接失效。挂到 body 后采样恢复正常 —— 与 ContextMenu 子菜单同理。 */}
      {dropdownMotion.present && shownMenu
        ? createPortal(
            <OverlayScope id={overlay.id}><div
              ref={dropdownRef}
              {...dropdownMotion.motionProps}
              {...overlay.layerProps}
              data-motion-axis="y"
              className="menu-bar__dropdown"
              role="menu"
              aria-label={shownMenu.label}
              onKeyDown={event => {
                const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
                const index = items.indexOf(document.activeElement as HTMLButtonElement)
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                    : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
                  items[next]?.focus()
                }
                if (event.key === 'Tab') close()
              }}
              style={{
                position: 'fixed',
                zIndex: overlay.zIndex,
                top: shownMenu.anchor.bottom + 2,
                left: Math.max(8, Math.min(shownMenu.anchor.left, window.innerWidth - 352))
              }}
            >
              {(shownMenu.label === COMPACT_MENU ? menus : menus.filter(menu => menu.label === shownMenu.label)).map(menu => <div key={menu.label} role="group" aria-label={menu.label}>
              {shownMenu.label === COMPACT_MENU ? <div className="menu-bar__group-label" aria-hidden="true">{menu.label}</div> : null}
              {menu.items.map((item) => (
                <button
                  key={item.command}
                  type="button"
                  role="menuitem"
                  className="menu-bar__item"
                  onClick={() => {
                    setOpen(null)
                    void executeCommand(item.command)
                  }}
                >
                  <span>{item.label}</span>
                  {getKeybindingHint(item.command) ? (
                    <span className="menu-bar__key">{getKeybindingHint(item.command)}</span>
                  ) : null}
                </button>
              ))}
              </div>)}
            </div></OverlayScope>,
            document.body
          )
        : null}
      {/* 右侧动作区：布局按钮组 + 设置入口（后续用户头像 / 账号等也在此扩展） */}
      <div className="menu-bar__spacer" />
      <div className="menu-bar__actions">
        <button
          type="button"
          className="menu-bar__action"
          title="设置（引擎管理 / 模型 / 安全 / 代码图）"
          aria-label="设置"
          onClick={() => openAppSettings()}
        >
          <Icon name="settings" size={16} />
        </button>
        <AccountMenu />
      </div>
      <WindowControls />
    </header>
  )
}
