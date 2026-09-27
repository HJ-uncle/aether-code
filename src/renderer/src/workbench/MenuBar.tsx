import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { executeCommand } from '@renderer/core/platform/commands'
import { getKeybindingHint } from '@renderer/core/platform/keybindings'
import { openAppSettings } from '@renderer/contrib/settings/app-settings-navigation'
import { Icon } from '@renderer/workbench/icons'
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
const MENUS: Menu[] = [
  {
    label: '文件',
    items: [
      { label: '打开文件夹…', command: 'aether.workspace.openFolder' },
      { label: '快速打开文件…', command: 'aether.quickOpen.toggle' },
      { label: '保存', command: 'aether.file.save' }
    ]
  },
  {
    label: '查看',
    items: [
      { label: '命令面板', command: 'aether.commandPalette.toggle' },
      { label: '资源管理器', command: 'aether.view.explorer' },
      { label: '搜索', command: 'aether.view.search' },
      { label: '版本控制', command: 'aether.view.git' },
      { label: '对话', command: 'aether.view.chat' },
      { label: '设置', command: 'aether.view.appSettings' },
      { label: '代码图索引', command: 'aether.view.codegraph' },
      { label: '模型', command: 'aether.view.models' },
      { label: '安全策略', command: 'aether.view.security' },
      { label: '输出面板', command: 'aether.panel.output' },
      { label: '终端', command: 'aether.panel.terminal' }
    ]
  },
  {
    label: '帮助',
    items: [{ label: '重启引擎', command: 'aether.engine.restart' }]
  }
]

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
        <Icon name="minimize" size={14} />
      </button>
      <button
        type="button"
        className="menu-bar__win-btn"
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => void window.aether.window.toggleMaximize()}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
      </button>
      <button
        type="button"
        className="menu-bar__win-btn menu-bar__win-btn--close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void window.aether.window.close()}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

export function MenuBar(): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLElement>(null)
  // 订阅用户键位变化：自定义快捷键后菜单提示立即跟随
  useSyncExternalStore(onUserKeybindingsChanged, getUserKeybindingRules)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <header className="menu-bar" ref={ref}>
      <span className="menu-bar__brand">Aether IDE</span>
      {MENUS.map((menu) => (
        <div key={menu.label} className="menu-bar__menu">
          <button
            type="button"
            className={`menu-bar__trigger${open === menu.label ? ' is-open' : ''}`}
            aria-expanded={open === menu.label}
            onClick={() => setOpen(open === menu.label ? null : menu.label)}
            // 悬停切换：VS Code 同款交互 —— 点开一个后划过去即换菜单
            onMouseEnter={() => {
              if (open) setOpen(menu.label)
            }}
          >
            {menu.label}
          </button>
          {open === menu.label ? (
            <div className="menu-bar__dropdown" role="menu">
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
            </div>
          ) : null}
        </div>
      ))}
      {/* 右侧动作区：设置入口固定在右上角，后续用户头像 / 账号等也在此扩展 */}
      <div className="menu-bar__spacer" />
      <div className="menu-bar__actions">
        <button
          type="button"
          className="menu-bar__action"
          title="设置（通用 / 模型 / 安全 / 代码图）"
          aria-label="设置"
          onClick={() => openAppSettings()}
        >
          <Icon name="settings" size={15} />
        </button>
      </div>
      <WindowControls />
    </header>
  )
}
