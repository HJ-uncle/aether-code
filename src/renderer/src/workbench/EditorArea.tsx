import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useSyncExternalStore
} from 'react'
import { useApp } from '@renderer/core/app-context'
import {
  closeFile,
  documentKey,
  getDocument,
  isDirty,
  saveDocument,
  useEditor
} from '@renderer/core/editor/editor-store'
import { toast } from '@renderer/core/toast'
import { confirmDocumentClose } from '@renderer/core/editor/close-confirmation'
import {
  activateGroupTab,
  documentGroups,
  finalDocumentsForGroupClose,
  focusEditorGroup,
  getEditorGroups,
  moveDocumentToOtherGroup,
  removeGroupTabs,
  splitDocumentToRight,
  useEditorGroups,
  type EditorGroup
} from '@renderer/core/editor/editor-groups'
import { fileIdentity } from '@renderer/core/editor/file-identity'
import { copyFilePaths, revealFile } from '@renderer/core/editor/file-context-actions'
import { addFilesToChat } from '@renderer/contrib/chat/editor-context'
import { setContextKey } from '@renderer/core/platform/context-keys'
import { getKeybindingHint } from '@renderer/core/platform/keybindings'
import { releaseModel } from '@renderer/core/editor/monaco-setup'
import { closeEditorView } from '@renderer/core/platform/layout-state'
import { getWorkspaceState } from '@renderer/core/workspace/workspace-store'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { useGit } from '@renderer/core/git/git-store'
import { visualKeyOf, STATUS_LETTER, type GitVisualKey } from '@renderer/core/git/git-status-visuals'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Icon, type IconName } from '@renderer/workbench/icons'
import { FileGlyph } from '@renderer/contrib/explorer/FileGlyph'
import { WelcomeView } from '@renderer/workbench/WelcomeView'
import { useLayout } from '@renderer/workbench/useLayout'
import {
  getDocumentRenderer,
  getViews,
  onViewsChanged,
  type DocumentRenderer,
  type ViewRegistration
} from '@renderer/workbench/view-registry'
import './editor-groups.css'

interface Tab {
  key: string
  title: string
  /** 有未保存改动 */
  dirty: boolean
  closable: boolean
  /** 关闭面板里的「关闭其它」要区分文件与固定视图，故保留原始路径（仅文件标签有） */
  filePath: string | null
  icon?: IconName
  status?: GitVisualKey | null
}

const STATUS_LABEL: Record<GitVisualKey, string> = {
  modified: '已修改',
  added: '新增',
  untracked: '未跟踪',
  deleted: '已删除',
  renamed: '已重命名',
  copied: '已复制',
  conflict: '合并冲突'
}

function workspaceRelativePath(filePath: string, root: string | null): string {
  const path = filePath.replace(/\\/g, '/')
  const base = root?.replace(/\\/g, '/').replace(/\/$/, '')
  if (!base) return path
  const lowerPath = path.toLowerCase()
  const lowerBase = base.toLowerCase()
  return lowerPath === lowerBase || !lowerPath.startsWith(`${lowerBase}/`)
    ? path
    : path.slice(base.length + 1)
}

/**
 * 主区（对标 VS Code 编辑器区）
 *
 * 标签来自两个来源，统一在一处合并：
 *   - 固定视图（模型、安全）：由视图注册表提供，不可关闭
 *   - 已打开文件：由编辑器 store 提供，可关闭、可带脏标记
 * 当前激活项统一由 layout-state 的 activeEditorView 持有（'doc:<path>' 或视图 ID）。
 * 对话在右侧 ChatPanel，不占主区标签。
 */
export function EditorArea(): JSX.Element {
  const { groups, focusedGroupId } = useEditorGroups()
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(0.5)
  const focused = groups.find((group) => group.id === focusedGroupId) ?? groups[0]
  useEffect(() => {
    setContextKey('editorTabsCount', focused.paths.length)
    setContextKey('editorGroupCount', groups.length)
    setContextKey('activeEditorIsFile', focused.activeKey.startsWith('doc:'))
  }, [focused.paths.length, focused.activeKey, groups.length])

  return (
    <div className="editor-groups" ref={containerRef}>
      {groups.map((group, index) => (
        <div className="editor-group-cell" key={group.id} style={{ flex: groups.length === 1 ? 1 : index === 0 ? ratio : 1 - ratio }}>
          {index > 0 ? (
            <div
              className="editor-group-divider"
              role="separator"
              aria-label="调整编辑器分栏宽度"
              aria-orientation="vertical"
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuenow={Math.round(ratio * 100)}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                setRatio((current) => Math.min(0.8, Math.max(0.2, current + (event.key === 'ArrowLeft' ? -0.05 : 0.05))))
              }}
              onPointerDown={(event) => {
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                const rect = containerRef.current?.getBoundingClientRect()
                if (rect?.width) setRatio(Math.min(0.8, Math.max(0.2, (event.clientX - rect.left) / rect.width)))
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
              }}
            />
          ) : null}
          <EditorGroupView group={group} first={index === 0} focused={group.id === focusedGroupId} split={groups.length > 1} />
        </div>
      ))}
    </div>
  )
}

function EditorGroupView({ group, first, focused, split }: {
  group: EditorGroup
  first: boolean
  focused: boolean
  split: boolean
}): JSX.Element {
  const layout = useLayout()
  const { ready } = useApp()
  const editor = useEditor()
  const workspace = useWorkspace()
  const git = useGit()
  const views = useSyncExternalStore(onViewsChanged, () => getViews('editor'))
  const DocumentRenderer = useSyncExternalStore(onViewsChanged, getDocumentRenderer)
  // 只保留仍然可见的固定视图：被关闭过的（closedEditorViews）不再出现在标签栏，
  // 也不能作为激活项（否则标签没了内容还在）
  const visibleViews = useMemo(
    () => views.filter((view) => !layout.closedEditorViews.includes(view.id)),
    [views, layout.closedEditorViews]
  )

  const tabs = useMemo<Tab[]>(() => {
    const staticTabs: Tab[] = (first ? visibleViews : []).map((view) => ({
      key: view.id,
      title: view.title,
      dirty: false,
      closable: view.closable === true,
      filePath: null,
      icon: view.icon as IconName
    }))
    const docTabs: Tab[] = group.paths.map((filePath) => {
      const doc = editor.docs.get(filePath)
      const relativePath = workspaceRelativePath(filePath, workspace.root)
      const change = git.files.find((item) => item.path.replace(/\\/g, '/').toLowerCase() === relativePath.toLowerCase())
      return {
        key: documentKey(filePath),
        title: doc?.name ?? filePath,
        dirty: doc ? isDirty(doc) : false,
        closable: true,
        filePath,
        status: change ? visualKeyOf(change) : null
      }
    })
    return [...staticTabs, ...docTabs]
  }, [visibleViews, group.paths, editor.docs, first, workspace.root, git.files])

  const [menu, setMenu] = useState<{ x: number; y: number; key: string; anchor: Element } | null>(null)

  // 激活项：优先 layout 指定；失效（被关闭 / 无此标签）时回落到第一个可见标签，
  // 一个都没有则为空字符串 → 内容区显示空态，与标签栏保持一致
  const activeKey =
    tabs.find((tab) => tab.key === group.activeKey)?.key ?? tabs[0]?.key ?? ''

  const activeFilePath = activeKey.startsWith('doc:') ? activeKey.slice(4) : null

  // 只修复本组失效的活动项，不能让未聚焦组抢走命令目标。
  useEffect(() => {
    if (focused && activeKey !== group.activeKey) activateGroupTab(group.id, activeKey)
  }, [focused, activeKey, group.activeKey, group.id])

  const handleClose = useCallback((key: string) => {
    focusEditorGroup(group.id)
    void closeTabByKey(key)
  }, [group.id])

  /** 右键菜单项。按 VS Code 的 EditorTabContext：关闭 / 其它 / 右侧 / 全部 */
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return []
    const index = tabs.findIndex((tab) => tab.key === menu.key)
    if (index < 0) return []
    const tab = tabs[index]
    const rightCount = tabs.slice(index + 1).length

    const closeKey = tab.closable ? getKeybindingHint('aether.editor.closeTab') : undefined
    const closeOthersKey = getKeybindingHint('aether.editor.closeOthers')
    const closeAllKey = getKeybindingHint('aether.editor.closeAll')

    const items: ContextMenuItem[] = [
      {
        id: 'close',
        label: '关闭',
        hint: closeKey,
        disabled: !tab.closable,
        onSelect: () => handleClose(tab.key)
      },
      {
        id: 'closeOthers',
        label: '关闭其他',
        hint: closeOthersKey,
        onSelect: () => void closeOtherFileTabs(tab.filePath ?? '')
      },
      {
        id: 'closeRight',
        label: '关闭右侧',
        disabled: rightCount === 0,
        onSelect: () => void (tab.filePath ? closeFileTabsToRight(tab.filePath) : closeAllFileTabs())
      },
      {
        id: 'closeAll',
        label: '全部关闭',
        hint: closeAllKey,
        onSelect: () => void closeAllFileTabs()
      }
    ]
    const path = tab.filePath
    if (path) {
      items.push(
        {
          id: 'splitRight',
          label: '向右拆分编辑器',
          onSelect: () => splitDocumentToRight(path)
        },
        {
          id: 'moveToOtherGroup',
          label: '移动到另一编辑组',
          onSelect: () => moveDocumentToOtherGroup(group.id, path)
        },
        {
          id: 'addToChat',
          label: '添加到对话',
          onSelect: () => { addFilesToChat([{ path, kind: 'file' }]) }
        },
        {
          id: 'copyPath',
          label: '复制绝对路径',
          onSelect: () => void copyFilePaths([path])
        },
        {
          id: 'copyRelativePath',
          label: '复制相对路径',
          onSelect: () => void copyFilePaths([path], getWorkspaceState().root)
        },
        {
          id: 'revealFile',
          label: '在文件资源管理器中显示',
          onSelect: () => void revealFile(path)
        }
      )
    }
    if (split) items.push({ id: 'closeGroup', label: '关闭编辑组', onSelect: () => void closeEditorGroup(group.id) })
    return items
  }, [menu, tabs, handleClose, group.id, split])
  /** 标签栏键盘导航：方向键/Home/End 移动激活项（对齐 VS Code 的标签行为） */
  const handleTabsKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (tabs.length === 0) return
      const index = tabs.findIndex((tab) => tab.key === activeKey)
      const current = index < 0 ? 0 : index
      let next = -1
      switch (event.key) {
        case 'ArrowRight':
          next = (current + 1) % tabs.length
          break
        case 'ArrowLeft':
          next = (current - 1 + tabs.length) % tabs.length
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = tabs.length - 1
          break
        default:
          return
      }
      event.preventDefault()
      const target = tabs[next]
      if (!target || target.key === activeKey) return
      activateGroupTab(group.id, target.key)
      // 焦点跟随激活标签（roving tabindex 模式）
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-editor-group="${group.id}"] .editor-tab[data-tab-key="${CSS.escape(target.key)}"]`)
          ?.focus()
      })
    },
    [tabs, activeKey, group.id]
  )

  return (
    <section className={`editor-area${focused ? ' is-focused-group' : ''}`} aria-label={first ? '编辑区' : '右侧编辑区'} data-editor-group={group.id}
      // 已经是焦点组时不要每次右键/中键都再次同步活动文档；同步会让标签栏
      // 恢复滚动位置，正好把刚打开的右键菜单卸载掉。
      onPointerDownCapture={() => { if (!focused) focusEditorGroup(group.id) }} onFocusCapture={() => { if (!focused) focusEditorGroup(group.id) }}>
      <header className="editor-tabs" role="tablist" onKeyDown={handleTabsKeyDown}>
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className={`editor-tab${tab.key === activeKey ? ' is-active' : ''}`}
            role="tab"
            aria-selected={tab.key === activeKey}
            data-tab-key={tab.key}
            tabIndex={tab.key === activeKey ? 0 : -1}
            title={tab.filePath ?? tab.title}
            onClick={() => activateGroupTab(group.id, tab.key)}
            // 中键关闭：与 VS Code 一致（浏览器标签的习惯），只对可关闭标签生效。
            // Electron/Chromium 在 div 上有时只派发 mousedown，不派发 auxclick；
            // 在按下阶段处理才能保证真实鼠标和 Playwright 的中键路径一致。
            onMouseDown={(event: ReactMouseEvent) => {
              if (event.button !== 1 || !tab.closable) return
              event.preventDefault()
              handleClose(tab.key)
            }}
            onContextMenu={(event: ReactMouseEvent) => {
              event.preventDefault()
              // 右键同时激活该标签：菜单里的「关闭其他」等操作要作用在
              // 用户指向的标签上，而不是当前激活的另一个
              // 右键当前标签无需再次激活；重复激活会让编辑器恢复滚动位置，
              // 触发标签栏 scroll，从而把刚打开的菜单误关掉。
              if (group.activeKey !== tab.key) activateGroupTab(group.id, tab.key)
              setMenu({ x: event.clientX, y: event.clientY, key: tab.key, anchor: event.currentTarget })
            }}
          >
            {tab.filePath ? <FileGlyph name={tab.filePath} size={15} /> : tab.icon ? <Icon name={tab.icon} size={15} className="editor-tab__view-icon" /> : null}
            <span className="editor-tab__label">
              {tab.title}
              {tab.dirty ? <span className="editor-tab__dirty">●</span> : null}
            </span>
            {tab.status ? <span className={`editor-tab__status editor-tab__status--${tab.status}`} title={`Git 状态：${STATUS_LABEL[tab.status]}`}>
              {STATUS_LETTER[tab.status]}
            </span> : null}
            {tab.closable ? (
              <button
                type="button"
                className="editor-tab__close"
                aria-label={`关闭 ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation()
                  handleClose(tab.key)
                }}
              >
                <Icon name="close" size={16} />
              </button>
            ) : null}
          </div>
        ))}
        <div className="editor-tabs__spacer" />
        {first && activeFilePath ? <button type="button" className="editor-group-action" title="向右拆分编辑器" aria-label="向右拆分编辑器" onClick={() => splitDocumentToRight(activeFilePath)}>分栏</button> : null}
        {split ? <button type="button" className="editor-group-action" title="关闭编辑组" aria-label="关闭编辑组" onClick={() => void closeEditorGroup(group.id)}><Icon name="close" size={14} /></button> : null}
        {!ready ? <span className="editor-tabs__hint">引擎未就绪</span> : null}
      </header>

      <div className="editor-area__body">
        {activeKey.startsWith('doc:') ? (
          <DocumentSlot filePath={activeKey.slice(4)} groupId={group.id} Renderer={DocumentRenderer} />
        ) : activeKey ? (
          renderStaticView(visibleViews, activeKey)
        ) : (
          <WelcomeView />
        )}
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} anchor={menu.anchor} onClose={() => setMenu(null)} />
      ) : null}
    </section>
  )
}

/**
 * 文档渲染槽。渲染器来自订阅的注册表引用：渲染器被替换时组件类型改变，
 * React 会自然卸载重建文档实例（等价于旧的 version remount 方案）。
 */
function DocumentSlot({
  filePath,
  groupId,
  Renderer
}: {
  filePath: string
  groupId: string
  Renderer: DocumentRenderer | null
}): JSX.Element {
  if (!Renderer) return <div className="doc-placeholder">未注册文档渲染器。</div>
  return <Renderer key={filePath} filePath={filePath} groupId={groupId} />
}

function renderStaticView(views: ViewRegistration[], activeKey: string): JSX.Element {
  // 严格按 activeKey 查找：不再回落到 views[0]，否则「没有可见标签」时
  // 仍会渲染出第一个视图，造成标签栏与内容区不一致
  const view = views.find((item) => item.id === activeKey)
  if (!view) return <div className="doc-placeholder">没有可用的视图。</div>
  const Component = view.component
  return <Component />
}

// ==================== 关闭策略 ====================
//
// 只操作「文件标签」，不碰固定视图（设置/键盘快捷方式）：那些是 closable 的
// 视图标签，有自己的 closedEditorViews 记录，语义与文件不同。
// 命令与右键菜单共用下面这组函数，避免两处各写一套遍历逻辑。

/** 全部目标先确认，再一起关闭；命令、X、中键和右键菜单共用同一条保护链。 */
async function closeFileTabs(filePaths: string[], groupId = getEditorGroups().focusedGroupId, closeGroup = false): Promise<void> {
  const group = getEditorGroups().groups.find((item) => item.id === groupId)
  if (!group) return
  // 文档路径来自主进程，标签组路径来自恢复快照；Windows 盘符大小写或
  // 分隔符历史差异不能让待关闭项在 includes() 里静默掉出批次。
  const paths = filePaths.flatMap((path) => {
    const canonical = getDocument(path)?.path ?? path
    return group.paths.find((entry) => fileIdentity(entry) === fileIdentity(canonical)) ?? []
  })
  const finalDocuments = finalDocumentsForGroupClose(groupId, paths)
  const approved = await confirmDocumentClose(finalDocuments, {
    read: getDocument,
    save: saveDocument,
    confirm: confirmDialog,
    error: toast.error
  })
  if (!approved) return

  removeGroupTabs(groupId, paths, closeGroup)
  for (const filePath of new Set(finalDocuments)) {
    if (documentGroups(filePath).length > 0) continue
    releaseModel(filePath)
    closeFile(filePath)
  }
}

/** 关闭除 key 之外的所有文件标签 */
export async function closeOtherFileTabs(keepPath: string): Promise<void> {
  const closed = focusedGroup().paths.filter((filePath) => filePath !== keepPath)
  await closeFileTabs(closed)
}

/** 关闭 key 右侧的所有文件标签（不含 key 自身） */
export async function closeFileTabsToRight(fromPath: string): Promise<void> {
  const order = focusedGroup().paths
  const index = order.indexOf(fromPath)
  if (index < 0) return
  const closed = order.slice(index + 1)
  await closeFileTabs(closed)
}

/** 关闭全部文件标签 */
export async function closeAllFileTabs(): Promise<void> {
  const closed = [...focusedGroup().paths]
  await closeFileTabs(closed)
}

/** 给命令用的「按标签键关闭」：接受 'doc:<path>' 或视图 ID */
export async function closeTabByKey(key: string): Promise<void> {
  if (!key.startsWith('doc:')) {
    closeEditorView(key)
    return
  }

  const filePath = key.slice(4)
  await closeFileTabs([filePath])
}

/**
 * 给命令用的「关闭右侧」：以激活标签为基准。
 * 激活的是固定视图（不在文件顺序里）时无从判断左右，直接不动。
 */
export async function closeTabsToRightOfActive(): Promise<void> {
  const key = focusedGroup().activeKey
  if (!key.startsWith('doc:')) return
  await closeFileTabsToRight(key.slice(4))
}

function focusedGroup(): EditorGroup {
  const groups = getEditorGroups()
  return groups.groups.find((group) => group.id === groups.focusedGroupId) ?? groups.groups[0]
}

export async function closeEditorGroup(groupId = getEditorGroups().focusedGroupId): Promise<void> {
  const group = getEditorGroups().groups.find((item) => item.id === groupId)
  if (group) await closeFileTabs([...group.paths], groupId, true)
}

/**
 * 切换标签。
 *
 * 只在**文件**标签之间循环，跳过设置等固定视图 —— 与 VS Code 的
 * Ctrl+Tab / Ctrl+PageUp / Ctrl+PageDown 一致（它们是编辑器组内的循环切换，
 * 不会跳到设置页）。到达两端时绕回另一端，这样在只有两个标签时
 * Ctrl+Tab 能一直在两者间往复，而不是走到末尾就卡住。
 */
export function switchActiveTab(delta: number): void {
  const group = focusedGroup()
  const order = group.paths
  if (order.length === 0) return

  const current = group.activeKey.startsWith('doc:')
    ? group.activeKey.slice(4)
    : null
  const index = current ? order.indexOf(current) : -1
  // 当前激活的不是文件标签（index < 0）时，+1 落到第一个文件、-1 落到最后一个
  const from = index < 0 ? (delta > 0 ? -1 : 0) : index
  const next = (((from + delta) % order.length) + order.length) % order.length
  activateGroupTab(group.id, documentKey(order[next]))
}
