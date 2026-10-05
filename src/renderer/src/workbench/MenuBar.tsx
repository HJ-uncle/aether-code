import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { executeCommand } from '@renderer/core/platform/commands'
import { getKeybindingHint } from '@renderer/core/platform/keybindings'
import { setLayout, toggleChatPanel, toggleChatPosition } from '@renderer/core/platform/layout-state'
import { openAppSettings } from '@renderer/contrib/settings/app-settings-navigation'
import { Icon } from '@renderer/workbench/icons'
import brandIcon from '@renderer/assets/icon.png'
import { useLayout } from './useLayout'
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
    label: '编辑',
    items: [
      { label: '查找', command: 'aether.editor.find' },
      { label: '替换', command: 'aether.editor.replace' },
      { label: '格式化文档', command: 'aether.editor.formatDocument' },
      { label: '格式化选区', command: 'aether.editor.formatSelection' },
      { label: '重命名符号', command: 'aether.editor.renameSymbol' },
      { label: '切换行注释', command: 'aether.editor.toggleLineComment' },
      { label: '选择下一个匹配项', command: 'aether.editor.selectNextOccurrence' },
      { label: '选择所有匹配项', command: 'aether.editor.selectAllOccurrences' },
      { label: '切换自动换行', command: 'aether.editor.toggleWordWrap' },
      { label: '切换小地图', command: 'aether.editor.toggleMinimap' }
    ]
  },
  {
    label: '转到',
    items: [
      { label: '转到行', command: 'aether.editor.goToLine' },
      { label: '转到文件符号', command: 'aether.editor.goToSymbol' },
      { label: '转到定义', command: 'aether.editor.goToDefinition' },
      { label: '转到引用', command: 'aether.editor.goToReferences' }
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
  const [open, setOpen] = useState<{ label: string; anchor: DOMRect } | null>(null)
  const ref = useRef<HTMLElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const layout = useLayout()
  // 订阅用户键位变化：自定义快捷键后菜单提示立即跟随
  useSyncExternalStore(onUserKeybindingsChanged, getUserKeybindingRules)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      // 下拉已 portal 到 body，不在菜单栏 DOM 里 —— 两处都要算「内部」，否则点菜单项会先触发关闭
      if (ref.current?.contains(target) || dropdownRef.current?.contains(target)) return
      setOpen(null)
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
      <span className="menu-bar__brand">
        <img className="menu-bar__logo" src={brandIcon} alt="" draggable={false} />
        Aether
      </span>
      {MENUS.map((menu) => (
        <div key={menu.label} className="menu-bar__menu">
          <button
            type="button"
            className={`menu-bar__trigger${open?.label === menu.label ? ' is-open' : ''}`}
            aria-expanded={open?.label === menu.label}
            onClick={(event) => {
              if (open?.label === menu.label) {
                setOpen(null)
              } else {
                setOpen({ label: menu.label, anchor: event.currentTarget.getBoundingClientRect() })
              }
            }}
            // 悬停切换：VS Code 同款交互 —— 点开一个后划过去即换菜单
            onMouseEnter={(event) => {
              if (open) {
                setOpen({ label: menu.label, anchor: event.currentTarget.getBoundingClientRect() })
              }
            }}
          >
            {menu.label}
          </button>
        </div>
      ))}
      {/* 下拉 portal 到 body：菜单栏自身带 backdrop-filter，是 backdrop root，
          嵌在里面的模糊浮层采不到栏下方的真实内容（只能采到栏自己的半透明底色），
          磨砂直接失效。挂到 body 后采样恢复正常 —— 与 ContextMenu 子菜单同理。 */}
      {open
        ? createPortal(
            <div
              ref={dropdownRef}
              className="menu-bar__dropdown"
              role="menu"
              style={{
                position: 'fixed',
                top: open.anchor.bottom + 2,
                left: open.anchor.left
              }}
            >
              {(MENUS.find((menu) => menu.label === open.label)?.items ?? []).map((item) => (
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
            </div>,
            document.body
          )
        : null}
      {/* 右侧动作区：布局按钮组 + 设置入口（后续用户头像 / 账号等也在此扩展） */}
      <div className="menu-bar__spacer" />
      <div className="menu-bar__actions">
        <button
          type="button"
          className={`menu-bar__action${layout.sidebarVisible ? ' is-on' : ''}`}
          title="切换侧边栏"
          aria-label="切换侧边栏"
          onClick={() => setLayout({ sidebarVisible: !layout.sidebarVisible })}
        >
          <Icon name="layout-sidebar" size={16} />
        </button>
        <button
          type="button"
          className={`menu-bar__action${layout.chatPanelVisible ? ' is-on' : ''}`}
          title="切换对话面板"
          aria-label="切换对话面板"
          onClick={() => toggleChatPanel()}
        >
          {/* 图标随换位翻转：对话在右侧画右停靠、在左侧画左停靠，与实际位置对应 */}
          <Icon name={layout.chatOnLeft ? 'layout-panel-left' : 'layout-panel'} size={16} />
        </button>
        <button
          type="button"
          className="menu-bar__action"
          title="对话面板与主区换位"
          aria-label="对话面板与主区换位"
          disabled={!layout.chatPanelVisible}
          onClick={() => toggleChatPosition()}
        >
          <Icon name="swap-horizontal" size={16} />
        </button>
        <button
          type="button"
          className="menu-bar__action"
          title="设置（引擎管理 / 模型 / 安全 / 代码图）"
          aria-label="设置"
          onClick={() => openAppSettings()}
        >
          <Icon name="settings" size={16} />
        </button>
      </div>
      <WindowControls />
    </header>
  )
}
