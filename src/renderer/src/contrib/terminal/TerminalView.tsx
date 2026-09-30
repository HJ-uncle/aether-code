import { useEffect, useRef, useState, type JSX } from 'react'
import '@xterm/xterm/css/xterm.css'
import {
  getWorkspaceState,
  useWorkspace,
  workspaceRestoreSettled
} from '@renderer/core/workspace/workspace-store'
import { copyIntoWorkspace } from '@renderer/core/workspace/fs-client'
import { watchTheme } from '@renderer/core/theme/palette'
import { Icon } from '@renderer/workbench/icons'
import { ContextMenu } from '@renderer/workbench/ContextMenu'
import { pushPendingMention } from '@renderer/contrib/chat/pending-mentions'
import {
  clearActiveSession,
  closeSession,
  copyTerminalSelection,
  createLocalSession,
  getTerminalState,
  isSessionAttached,
  isSessionDead,
  markSessionAttached,
  setActiveSession,
  useTerminalStore,
  type TerminalSession
} from './terminal-store'
import { buildTerminalTheme } from './terminal-theme'

/**
 * 终端视图（面板区）
 *
 * 形态对齐 VS Code：左侧终端内容区 + 右侧实例列表。
 * 列表只是会话切换器——xterm 实例与会话绑定，切换靠 DOM 显隐，
 * 后台会话的 shell 与滚动缓冲始终存活。
 */
export function TerminalView(): JSX.Element {
  const workspace = useWorkspace()
  const root = workspace.root
  const state = useTerminalStore()

  // 面板打开时无会话则自动建一个；creating 守卫住 StrictMode/竞态。
  // createFailed 必须一并检查：创建失败（如环境不支持 ConPTY）后若还自动重试，
  // 会陷入"失败→复位→再触发"的无限循环，这里改为停下来等显式操作。
  //
  // 必须先等启动恢复跑完：它是异步的，首帧执行到这里时 root 还是 null，
  // 直接建出来的 shell 会落在主目录、而不是当前项目。
  useEffect(() => {
    let cancelled = false
    void workspaceRestoreSettled().then(() => {
      if (cancelled) return
      const current = getTerminalState()
      if (current.sessions.length > 0 || current.creating || current.createFailed) return
      void createLocalSession(getWorkspaceState().root ?? undefined)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 外观/强调色变化（含 'system' 模式的系统切换）→ 热更新全部存活会话的主题
  useEffect(
    () =>
      watchTheme(() => {
        for (const session of getTerminalState().sessions) {
          session.term.options.theme = buildTerminalTheme()
        }
      }),
    []
  )

  return (
    <div className="terminal-view" aria-label="终端">
      <div className="terminal-view__main">
        {state.sessions.map((session) => (
          <SessionSlot key={session.id} session={session} active={session.id === state.activeId} />
        ))}
        {/* 创建失败时不再静默留白：用户至少要知道"终端没起来，以及为什么"，
            并有一个显式的重试入口（自动重试会陷入无限循环，见上方 effect）。 */}
        {state.sessions.length === 0 && state.createFailed ? (
          <div className="terminal-view__error" role="alert">
            <p className="terminal-view__error-title">终端启动失败</p>
            <p className="terminal-view__error-detail">{state.createFailed}</p>
            <button
              type="button"
              className="terminal-view__error-retry"
              onClick={() => void createLocalSession(root ?? undefined)}
            >
              重试
            </button>
          </div>
        ) : null}
      </div>

      <aside className="terminal-view__side" aria-label="终端列表">
        <div className="terminal-view__side-actions">
          <button
            type="button"
            className="terminal-view__side-btn"
            title="清屏"
            aria-label="清屏"
            onClick={() => clearActiveSession()}
          >
            <Icon name="trash" size={16} />
          </button>
          <button
            type="button"
            className="terminal-view__side-btn"
            title="新建终端"
            aria-label="新建终端"
            onClick={() => void createLocalSession(root ?? undefined)}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
        <div className="terminal-view__list">
          {state.sessions.map((session) => (
            <Item key={session.id} session={session} active={session.id === state.activeId} />
          ))}
        </div>
      </aside>
    </div>
  )
}

/** 右侧列表项：终端图标 + 标题，激活高亮，退出置灰，悬停显示关闭 */
function Item({ session, active }: { session: TerminalSession; active: boolean }): JSX.Element {
  const dead = isSessionDead(session.id)
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`terminal-view__item${active ? ' is-active' : ''}${dead ? ' is-dead' : ''}`}
      onClick={() => setActiveSession(session.id)}
    >
      <Icon name="terminal" size={16} />
      <span className="terminal-view__item-label">
        {dead ? `${session.title}（已退出）` : session.title}
      </span>
      <button
        type="button"
        className="terminal-view__item-close"
        aria-label={`关闭 ${session.title}`}
        onClick={(event) => {
          event.stopPropagation()
          closeSession(session.id)
        }}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}

/**
 * 单个会话的挂载点。xterm 只能 open 一次，因此每个会话对应一个
 * 常驻 DOM，用 display 显隐；激活时重新 fit 并把尺寸同步给传输层。
 * attached 标记由 store 的登记表持有，这里只读不写会话对象。
 */
function SessionSlot({
  session,
  active
}: {
  session: TerminalSession
  active: boolean
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const workspace = useWorkspace()
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!isSessionAttached(session.id)) {
      session.term.open(el)
      markSessionAttached(session.id)
    }
    if (active) {
      // display:none 期间 fit 会得到 0，激活后重新测量
      session.fit.fit()
      session.transport.resize(session.term.cols, session.term.rows)
      session.term.focus()
    }
  }, [active, session])

  /**
   * 选中文本「添加到对话」：把终端选区落盘成 .aether/attachments/ 下的
   * 临时文本文件，再作为一个 terminal 引用入队给聊天输入框。
   * 对齐 wuzu-client：终端内容量大且可能含控制字符，不直接塞进 prompt，
   * 落成文件后让 AI 自己读。
   */
  const addSelectionToChat = async (selection: string): Promise<void> => {
    const root = workspace.root
    if (!root) return
    const stamp = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const fileName = `terminal-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.txt`
    const result = await copyIntoWorkspace({
      root,
      fileName,
      data: new TextEncoder().encode(selection)
    })
    pushPendingMention({
      displayText: `${session.title} 输出`,
      source: 'terminal',
      path: result.relativePath
    })
  }

  return (
    <>
      <div
        ref={ref}
        className="terminal-view__session"
        style={{ display: active ? 'block' : 'none' }}
        onContextMenu={(event) => {
          const selection = session.term.getSelection()
          if (!selection) return // 无选区走 xterm 默认行为（复制/系统菜单）
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY, selection })
        }}
      />
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              id: 'copy',
              label: '复制',
              hint: 'Ctrl+C',
              onSelect: () => {
                setMenu(null)
                void copyTerminalSelection(menu.selection)
              }
            },
            {
              id: 'add-to-chat',
              label: '添加到对话',
              hint: `${menu.selection.length} 字符`,
              disabled: !workspace.root,
              onSelect: () => {
                setMenu(null)
                void addSelectionToChat(menu.selection)
              }
            }
          ]}
        />
      ) : null}
    </>
  )
}
