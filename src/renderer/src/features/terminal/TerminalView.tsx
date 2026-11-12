import { useEffect, useRef, useState, type JSX, type MouseEvent, type KeyboardEvent } from 'react'
import '@xterm/xterm/css/xterm.css'
import {
  getWorkspaceState,
  useWorkspace,
  workspaceRestoreSettled
} from '@renderer/core/workspace/workspace-store'
import { assertSessionFileTarget, captureSessionFileTarget, copyIntoWorkspace, writeFile } from '@renderer/core/workspace/fs-client'
import { watchTheme } from '@renderer/core/theme/palette'
import { useApp } from '@renderer/core/app-context'
import { Icon } from '@renderer/ui/icons'
import { ContextMenu } from '@renderer/ui/ContextMenu'
import { PromptDialog } from '@renderer/ui/PromptDialog'
import { confirmDialog } from '@renderer/ui/ConfirmDialog'
import { toast } from '@renderer/core/toast'
import { ipcErrorMessage } from '@renderer/core/ipc-error'
import { getEngineSource, getEngineStorageKey } from '@renderer/core/engine/source'
import { useWorkbenchVisible } from '@renderer/core/platform/workbench-visibility'
import { assertWorkspaceTarget, captureWorkspaceTarget } from '@renderer/core/workspace/connection'
import { pushPendingMention } from '@renderer/features/conversation/shared/pending-mentions'
import {
  clearSession,
  closeAllSessions,
  closeOtherSessions,
  closeSession,
  copyTerminalSelection,
  createLocalSession,
  getTerminalState,
  getTerminalScopeState,
  getSessionStatus,
  isSessionAttached,
  isSessionDead,
  markSessionAttached,
  pasteTerminalClipboard,
  reconnectSession,
  renameSession,
  restartSession,
  setActiveSession,
  useTerminalStore,
  type TerminalSession
} from './terminal-store'
import { buildTerminalTheme } from './terminal-theme'
import { useTerminalFit } from './use-terminal-fit'
import { readTerminalOutput } from './terminal-output'
import './terminal-view.css'

/**
 * 终端视图（面板区）
 *
 * 形态对齐 macOS 工具栏：终端内容区 + 顶部紧凑实例标签。
 * 标签栏只是会话切换器——xterm 实例与会话绑定，切换靠 DOM 显隐，
 * 后台会话的 shell 与滚动缓冲始终存活。
 */
export function TerminalView({ active: activeProp, sessionId: sessionIdProp, cwd }: { active?: boolean; sessionId?: string; cwd?: string | null } = {}): JSX.Element {
  const { engine, settings, settingsLoaded } = useApp()
  const windowVisible = useWorkbenchVisible()
  const visible = windowVisible && activeProp === true
  const sessionScoped = sessionIdProp !== undefined
  const sessionId = sessionScoped ? sessionIdProp.trim() : settings.lastSessionId
  const workspace = useWorkspace()
  const root = sessionScoped ? cwd ?? null : cwd === undefined ? workspace.root : cwd
  const state = useTerminalStore()
  const source = getEngineStorageKey()
  const sessions = state.sessions.filter(session => sessionScoped ? session.source === source && session.sessionId === sessionId : !session.scopedToSession)
  const scopeState = getTerminalScopeState(sessionScoped ? sessionId : undefined)
  const selectedByScope = useRef(new Map<string, string>())
  const viewScope = JSON.stringify([source, sessionScoped ? sessionId : null])
  if (state.activeId && sessions.some(session => session.id === state.activeId)) selectedByScope.current.set(viewScope, state.activeId)
  const activeId = sessions.find(session => session.id === selectedByScope.current.get(viewScope))?.id ?? sessions.at(-1)?.id
  const waitingForRemote = engine.snapshot.phase !== 'ready' && (engine.snapshot.mode === 'remote' || settings.engineMode === 'remote')
  const canCreate = visible && settingsLoaded && !waitingForRemote && (!sessionScoped || Boolean(sessionId))
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; selection: string; anchor: Element } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [attaching, setAttaching] = useState(false)
  const scopeRef = useRef({ root, sessionId, visible })
  scopeRef.current = { root, sessionId, visible }
  const menuSession = sessions.find(session => session.id === menu?.id)
  const menuText = menuSession ? menu?.selection || readTerminalOutput(menuSession.term.buffer.active) : ''
  const renameTarget = sessions.find(session => session.id === renaming)
  const create = (): void => { if (canCreate) void createLocalSession(root ?? undefined, sessionScoped ? sessionId : undefined) }
  useEffect(() => { if (visible && activeId) setActiveSession(activeId) }, [visible, activeId, viewScope])
  useEffect(() => { setMenu(null); setRenaming(null) }, [visible, viewScope])

  const openMenu = (session: TerminalSession, event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ id: session.id, x: 'clientX' in event ? event.clientX : rect.left + 12,
      y: 'clientY' in event ? event.clientY : rect.bottom, selection: session.term.getSelection(), anchor: event.currentTarget })
  }

  const addToChat = async (session: TerminalSession, text: string): Promise<void> => {
    if (attaching || !text.trim()) return
    setAttaching(true)
    try {
      const source = getEngineSource()
      const scope = scopeRef.current
      if ((!sessionScoped && !scope.root) || !scope.sessionId || !scope.visible) throw new Error('请先打开工作区和会话')
      if (session.source !== getEngineStorageKey()) throw new Error('终端所属账号或连接已变化，请使用当前连接的终端')
      if (sessionScoped && session.sessionId !== scope.sessionId) throw new Error('终端不属于当前任务')
      const fileName = `terminal-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.txt`
      const currentScope = (): void => {
        if (getEngineSource() !== source || !scopeRef.current.visible || scopeRef.current.root !== scope.root || scopeRef.current.sessionId !== scope.sessionId) throw new Error('当前工作区或会话已切换，请重新添加')
      }
      let relativePath: string
      if (sessionScoped) {
        const target = await captureSessionFileTarget(scope.sessionId, scope.root)
        currentScope()
        await writeFile(`${target.root.replace(/[\\/]+$/, '')}/${fileName}`, text, target)
        assertSessionFileTarget(target)
        relativePath = fileName
      } else {
        const target = captureWorkspaceTarget()
        const result = await copyIntoWorkspace({ root: scope.root!, fileName, data: new TextEncoder().encode(text) })
        assertWorkspaceTarget(target)
        relativePath = result.relativePath
      }
      currentScope()
      pushPendingMention({ displayText: `${session.title} 输出`, source: 'terminal', path: relativePath }, { sessionId: scope.sessionId, source })
      toast.success('终端输出已添加到当前会话')
    } catch (error) {
      toast.error(`添加终端输出失败：${ipcErrorMessage(error)}`)
    } finally { setAttaching(false) }
  }

  const restart = async (session: TerminalSession): Promise<void> => {
    if (getSessionStatus(session.id) !== 'exited' && !await confirmDialog({
      title: '重新启动终端', body: `将结束“${session.title}”的原进程并启动新终端，原有输出会清除。`, confirmText: '重新启动', danger: true
    })) return
    await restartSession(session.id)
  }

  // 面板打开时无会话则自动建一个；creating 守卫住 StrictMode/竞态。
  // createFailed 必须一并检查：创建失败（如环境不支持 ConPTY）后若还自动重试，
  // 会陷入"失败→复位→再触发"的无限循环，这里改为停下来等显式操作。
  //
  // 必须先等启动恢复跑完：它是异步的，首帧执行到这里时 root 还是 null，
  // 直接建出来的 shell 会落在主目录、而不是当前项目。
  useEffect(() => {
    if (!canCreate) return
    let cancelled = false
    void (sessionScoped ? Promise.resolve() : workspaceRestoreSettled()).then(() => {
      if (cancelled) return
      const current = getTerminalState()
      const scoped = getTerminalScopeState(sessionScoped ? sessionId : undefined)
      const hasSessions = current.sessions.some(session => sessionScoped ? session.source === source && session.sessionId === sessionId : !session.scopedToSession)
      if (hasSessions || current.creating || scoped.createFailed || scoped.closedAll) return
      void createLocalSession((sessionScoped ? root : getWorkspaceState().root) ?? undefined, sessionScoped ? sessionId : undefined)
    })
    return () => {
      cancelled = true
    }
  }, [canCreate, source, sessionScoped, sessionId, root, state.sessions, state.creating, scopeState.createFailed, scopeState.closedAll])

  // 外观/强调色变化（含 'system' 模式的系统切换）→ 热更新全部存活会话的主题
  useEffect(
    () => visible ? watchTheme(() => {
        for (const session of getTerminalState().sessions) {
          session.term.options.theme = buildTerminalTheme()
        }
      }) : undefined,
    [visible]
  )

  return (
    <div className="terminal-view terminal-view--tabs" aria-label="终端">
      <div className="terminal-view__main">
        {sessions.map((session) => (
          <SessionSlot key={session.id} session={session} active={visible && session.id === activeId} onMenu={openMenu} />
        ))}
        {sessions.length === 0 && waitingForRemote ? (
          <div className="terminal-view__error" role="status">
            <p className="terminal-view__error-title">等待远端引擎连接</p>
            <p className="terminal-view__error-detail">{engine.snapshot.error || scopeState.createFailed || '连接成功后即可使用远程终端。'}</p>
          </div>
        ) : null}
        {sessions.length === 0 && scopeState.closedAll && !scopeState.createFailed && !waitingForRemote ? (
          <div className="terminal-view__error"><p>所有终端已关闭</p><button type="button" className="btn" disabled={!canCreate || state.creating} onClick={create}>创建终端</button></div>
        ) : null}
        {/* 创建失败时不再静默留白：用户至少要知道"终端没起来，以及为什么"，
            并有一个显式的重试入口（自动重试会陷入无限循环，见上方 effect）。 */}
        {sessions.length === 0 && scopeState.createFailed && !waitingForRemote ? (
          <div className="terminal-view__error" role="alert">
            <p className="terminal-view__error-title">终端启动失败</p>
            <p className="terminal-view__error-detail">{scopeState.createFailed}</p>
            <button
              type="button"
              className="terminal-view__error-retry"
              disabled={!canCreate || state.creating}
              onClick={create}
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
            disabled={!activeId}
            onClick={() => { if (activeId) clearSession(activeId) }}
          >
            <Icon name="trash" size={16} />
          </button>
          <button
            type="button"
            className="terminal-view__side-btn"
            title="新建终端"
            aria-label="新建终端"
            disabled={!canCreate || state.creating}
            onClick={create}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
        <div className="terminal-view__list" data-scroll-axis="x" role="tablist" aria-label="终端标签">
          {sessions.map((session) => (
            <Item key={session.id} session={session} active={session.id === activeId} onMenu={openMenu} />
          ))}
        </div>
      </aside>
      {visible && menu && menuSession ? (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} onClose={() => setMenu(null)} items={[
          { id: 'new', label: '新建终端', disabled: !canCreate || state.creating, onSelect: () => { setMenu(null); create() } },
          { id: 'rename', label: '重命名', onSelect: () => { setMenu(null); setRenaming(menuSession.id) } },
          { id: 'add-to-chat', label: '添加到当前会话', hint: menu.selection ? '选中内容' : '保留的全部输出', disabled: attaching || !menuText.trim() || (!sessionScoped && !root) || !sessionId || menuSession.source !== source || (sessionScoped && menuSession.sessionId !== sessionId), onSelect: () => {
            setMenu(null)
            const text = menuText
            if (!text.trim()) toast.info('终端还没有可添加的输出')
            else void addToChat(menuSession, text)
          } },
          { id: 'copy', label: '复制', hint: navigator.platform.toLowerCase().includes('mac') ? 'Cmd+C' : 'Ctrl+C', disabled: !menu.selection, onSelect: () => { setMenu(null); void copyTerminalSelection(menu.selection) } },
          { id: 'copy-all', label: '复制全部输出', onSelect: () => { setMenu(null); void copyTerminalSelection(readTerminalOutput(menuSession.term.buffer.active)) } },
          { id: 'paste', label: '粘贴', hint: navigator.platform.toLowerCase().includes('mac') ? 'Cmd+V' : 'Ctrl+V', disabled: isSessionDead(menuSession.id), onSelect: () => { setMenu(null); setActiveSession(menuSession.id); void pasteTerminalClipboard(menuSession.id) } },
          { id: 'select-all', label: '全选', onSelect: () => { setMenu(null); setActiveSession(menuSession.id); menuSession.term.selectAll() } },
          { id: 'clear', label: '清屏', onSelect: () => { setMenu(null); clearSession(menuSession.id) } },
          ...(getSessionStatus(menuSession.id) === 'disconnected' || getSessionStatus(menuSession.id) === 'reconnecting' ? [
            { id: 'reconnect', label: getSessionStatus(menuSession.id) === 'reconnecting' ? '正在恢复连接…' : '恢复终端连接', disabled: !canCreate || getSessionStatus(menuSession.id) === 'reconnecting', onSelect: () => { setMenu(null); void reconnectSession(menuSession.id) } }
          ] : []),
          { id: 'restart', label: '重新启动终端', disabled: !canCreate || state.creating || getSessionStatus(menuSession.id) === 'reconnecting', onSelect: () => { setMenu(null); void restart(menuSession) } },
          { id: 'close', label: '关闭终端', onSelect: () => { setMenu(null); closeSession(menuSession.id) } },
          { id: 'close-others', label: '关闭其他终端', disabled: sessions.length < 2, onSelect: () => { setMenu(null); closeOtherSessions(menuSession.id, sessions.map(session => session.id)) } },
          { id: 'close-all', label: '关闭全部终端', onSelect: () => { setMenu(null); closeAllSessions(sessions.map(session => session.id), sessionScoped ? { sessionId, source } : undefined) } }
        ]} />
      ) : null}
      {visible && renameTarget ? <PromptDialog title="重命名终端" label="终端名称" initialValue={renameTarget.title} onConfirm={value => renameSession(renameTarget.id, value)} onClose={() => setRenaming(null)} /> : null}
    </div>
  )
}

/** 右侧列表项：终端图标 + 标题，激活高亮，退出置灰，悬停显示关闭 */
type TerminalMenuHandler = (session: TerminalSession, event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void

function Item({ session, active, onMenu }: { session: TerminalSession; active: boolean; onMenu: TerminalMenuHandler }): JSX.Element {
  const dead = isSessionDead(session.id)
  const suffix = { running: '', disconnected: '（已断开）', exited: '（已退出）', reconnecting: '（正在恢复）' }[getSessionStatus(session.id)]
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      aria-haspopup="menu"
      title={`${session.title}${suffix} · 右键查看更多操作`}
      className={`terminal-view__item${active ? ' is-active' : ''}${dead ? ' is-dead' : ''}`}
      onClick={() => setActiveSession(session.id)}
      onContextMenu={event => onMenu(session, event)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) onMenu(session, event)
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveSession(session.id) }
      }}
    >
      <Icon name="terminal" size={16} />
      <span className="terminal-view__item-label">
        {session.title}{suffix}
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
 * xterm 只能 open 一次；Code 与 Work 切换时只迁移已有 DOM，
 * 隐藏视图不认领挂载点，避免抢走当前视图的输出或焦点。
 * attached 标记由 store 的登记表持有，这里只读不写会话对象。
 */
function SessionSlot({ session, active, onMenu }: {
  session: TerminalSession
  active: boolean
  onMenu: TerminalMenuHandler
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    if (!isSessionAttached(session.id)) {
      session.term.open(el)
      markSessionAttached(session.id)
    } else if (session.term.element && session.term.element.parentElement !== el) {
      el.appendChild(session.term.element)
      session.term.refresh(0, session.term.rows - 1)
    }
    session.term.focus()
  }, [active, session])
  useTerminalFit(ref, session, active)
  return <div ref={ref} className="terminal-view__session" style={{ display: active ? 'block' : 'none' }}
    onContextMenu={event => onMenu(session, event)}
    onKeyDown={event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) onMenu(session, event)
    }} />
}
