import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  useSyncExternalStore
} from 'react'
import { useApp } from '@renderer/core/app-context'
import {
  closeFile,
  documentKey,
  getDocument,
  getEditorState,
  isDirty,
  setActiveDocument,
  useEditor
} from '@renderer/core/editor/editor-store'
import { setContextKey } from '@renderer/core/platform/context-keys'
import { getKeybindingHint } from '@renderer/core/platform/keybindings'
import { releaseModel } from '@renderer/core/editor/monaco-setup'
import { getLayout, setLayout, closeEditorView } from '@renderer/core/platform/layout-state'
import { setActiveFile } from '@renderer/core/workspace/workspace-store'
import { ContextMenu, type ContextMenuItem } from '@renderer/workbench/ContextMenu'
import { Icon } from '@renderer/workbench/icons'
import { WelcomeView } from '@renderer/workbench/WelcomeView'
import { useLayout } from '@renderer/workbench/useLayout'
import {
  getDocumentRenderer,
  getViews,
  onViewsChanged,
  type DocumentRenderer,
  type ViewRegistration
} from '@renderer/workbench/view-registry'

interface Tab {
  key: string
  title: string
  /** 有未保存改动 */
  dirty: boolean
  closable: boolean
  /** 关闭面板里的「关闭其它」要区分文件与固定视图，故保留原始路径（仅文件标签有） */
  filePath: string | null
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
  const layout = useLayout()
  const { ready } = useApp()
  const editor = useEditor()
  const views = useSyncExternalStore(onViewsChanged, () => getViews('editor'))
  const DocumentRenderer = useSyncExternalStore(onViewsChanged, getDocumentRenderer)
  // 只保留仍然可见的固定视图：被关闭过的（closedEditorViews）不再出现在标签栏，
  // 也不能作为激活项（否则标签没了内容还在）
  const visibleViews = useMemo(
    () => views.filter((view) => !layout.closedEditorViews.includes(view.id)),
    [views, layout.closedEditorViews]
  )

  const tabs = useMemo<Tab[]>(() => {
    const staticTabs: Tab[] = visibleViews.map((view) => ({
      key: view.id,
      title: view.title,
      dirty: false,
      closable: view.closable === true,
      filePath: null
    }))
    const docTabs: Tab[] = editor.order.map((filePath) => {
      const doc = editor.docs.get(filePath)
      return {
        key: documentKey(filePath),
        title: doc?.name ?? filePath,
        dirty: doc ? isDirty(doc) : false,
        closable: true,
        filePath
      }
    })
    return [...staticTabs, ...docTabs]
  }, [visibleViews, editor.order, editor.docs])

  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null)

  // 激活项：优先 layout 指定；失效（被关闭 / 无此标签）时回落到第一个可见标签，
  // 一个都没有则为空字符串 → 内容区显示空态，与标签栏保持一致
  const activeKey =
    tabs.find((tab) => tab.key === layout.activeEditorView)?.key ?? tabs[0]?.key ?? ''

  const activeFilePath = activeKey.startsWith('doc:') ? activeKey.slice(4) : null

  // 激活的是文件时，同步给资源管理器做高亮，并登记为「当前文件」
  useEffect(() => {
    setActiveFile(activeFilePath)
    setActiveDocument(activeFilePath)
  }, [activeFilePath])

  // 文件标签数量写进上下文键：关闭类命令/键位的 when 都挂在 editorTabsCount 上。
  // 只数文件标签，不含设置等固定视图 —— 「关闭编辑器」对它们没有意义。
  // 未设置过的键在 evaluateWhen 里为 undefined → falsy，会让这些命令全部失效，
  // 所以这里必须真的写进去（0 也要写，不能跳过）
  useEffect(() => {
    setContextKey('editorTabsCount', editor.order.length)
  }, [editor.order.length])

  const handleClose = useCallback(
    (key: string) => {
      // 固定视图关闭：记录到布局状态（标签栏移除，可经命令/菜单恢复）
      if (!key.startsWith('doc:')) {
        closeEditorView(key)
        return
      }

      const filePath = key.slice(4)
      const doc = editor.docs.get(filePath)
      if (doc && isDirty(doc)) {
        const confirmed = window.confirm(`「${doc.name}」有未保存的修改，确定关闭吗？`)
        if (!confirmed) return
      }

      // 关闭后优先切到右侧邻居，没有则切到左侧最后一个，最后回落到固定视图
      const index = editor.order.indexOf(filePath)
      const remaining = editor.order.filter((item) => item !== filePath)
      const nextPath = remaining[index] ?? remaining[index - 1] ?? null

      // 关掉的是激活标签时才改激活项：否则「关闭其它」会把激活项
      // 从用户正看着的标签上挪走，落到一个无关的文件
      if (key === activeKey) {
        setLayout({ activeEditorView: nextPath ? documentKey(nextPath) : '' })
      }

      releaseModel(filePath)
      closeFile(filePath)
    },
    [activeKey, editor.docs, editor.order]
  )

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

    return [
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
        onSelect: () => closeOtherFileTabs(tab.filePath ?? '')
      },
      {
        id: 'closeRight',
        label: '关闭右侧',
        disabled: rightCount === 0,
        onSelect: () => closeFileTabsToRight(tab.filePath ?? '')
      },
      {
        id: 'closeAll',
        label: '全部关闭',
        hint: closeAllKey,
        onSelect: () => closeAllFileTabs()
      }
    ]
  }, [menu, tabs, handleClose])
  return (
    <section className="editor-area" aria-label="编辑区">
      <header className="editor-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className={`editor-tab${tab.key === activeKey ? ' is-active' : ''}`}
            role="tab"
            aria-selected={tab.key === activeKey}
            title={tab.filePath ?? tab.title}
            onClick={() => setLayout({ activeEditorView: tab.key })}
            // 中键关闭：与 VS Code 一致（浏览器标签的习惯），只对可关闭标签生效
            onAuxClick={(event: ReactMouseEvent) => {
              if (event.button !== 1 || !tab.closable) return
              event.preventDefault()
              handleClose(tab.key)
            }}
            onContextMenu={(event: ReactMouseEvent) => {
              event.preventDefault()
              // 右键同时激活该标签：菜单里的「关闭其他」等操作要作用在
              // 用户指向的标签上，而不是当前激活的另一个
              setLayout({ activeEditorView: tab.key })
              setMenu({ x: event.clientX, y: event.clientY, key: tab.key })
            }}
          >
            <span className="editor-tab__label">
              {tab.title}
              {tab.dirty ? <span className="editor-tab__dirty">●</span> : null}
            </span>
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
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </div>
        ))}
        <div className="editor-tabs__spacer" />
        {!ready ? <span className="editor-tabs__hint">引擎未就绪</span> : null}
      </header>

      <div className="editor-area__body">
        {activeKey.startsWith('doc:') ? (
          <DocumentSlot filePath={activeKey.slice(4)} Renderer={DocumentRenderer} />
        ) : activeKey ? (
          renderStaticView(visibleViews, activeKey)
        ) : (
          <WelcomeView />
        )}
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
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
  Renderer
}: {
  filePath: string
  Renderer: DocumentRenderer | null
}): JSX.Element {
  if (!Renderer) return <div className="doc-placeholder">未注册文档渲染器。</div>
  return <Renderer key={filePath} filePath={filePath} />
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

/** 真正关掉一批文件标签：先释放 Monaco model，再交给 store 入关闭栈 */
function closeFileTabs(filePaths: string[]): void {
  for (const filePath of filePaths) {
    releaseModel(filePath)
    closeFile(filePath)
  }
}

/**
 * 关闭后激活项落到哪儿。
 *
 * 关掉的文件里包含当前激活文件时才需要改：从剩下的文件标签里挑一个
 * ——一个都不剩就交给布局层回落（空字符串 → 固定视图或欢迎页）。
 * 挑的是「剩余文件标签的最后一个」而非右邻，因为批量关闭后右邻往往也没了。
 */
function settleActiveFile(closed: string[]): void {
  const layout = getLayout()
  const activeFilePath = layout.activeEditorView.startsWith('doc:')
    ? layout.activeEditorView.slice(4)
    : null
  if (!activeFilePath || !closed.includes(activeFilePath)) return

  const remaining = getEditorState().order
  setLayout({
    activeEditorView: remaining.length > 0 ? documentKey(remaining[remaining.length - 1]) : ''
  })
}

/** 关闭除 key 之外的所有文件标签 */
export function closeOtherFileTabs(keepPath: string): void {
  const closed = getEditorState().order.filter((filePath) => filePath !== keepPath)
  closeFileTabs(closed)
  settleActiveFile(closed)
}

/** 关闭 key 右侧的所有文件标签（不含 key 自身） */
export function closeFileTabsToRight(fromPath: string): void {
  const order = getEditorState().order
  const index = order.indexOf(fromPath)
  if (index < 0) return
  const closed = order.slice(index + 1)
  closeFileTabs(closed)
  settleActiveFile(closed)
}

/** 关闭全部文件标签 */
export function closeAllFileTabs(): void {
  const closed = [...getEditorState().order]
  closeFileTabs(closed)
  settleActiveFile(closed)
}

/** 给命令用的「按标签键关闭」：接受 'doc:<path>' 或视图 ID */
export function closeTabByKey(key: string): void {
  if (!key.startsWith('doc:')) {
    closeEditorView(key)
    return
  }

  const filePath = key.slice(4)
  const doc = getDocument(filePath)
  if (doc && isDirty(doc) && !window.confirm(`「${doc.name}」有未保存的修改，确定关闭吗？`)) return

  closeFileTabs([filePath])
  settleActiveFile([filePath])
}

/**
 * 给命令用的「关闭右侧」：以激活标签为基准。
 * 激活的是固定视图（不在文件顺序里）时无从判断左右，直接不动。
 */
export function closeTabsToRightOfActive(): void {
  const layout = getLayout()
  if (!layout.activeEditorView.startsWith('doc:')) return
  closeFileTabsToRight(layout.activeEditorView.slice(4))
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
  const order = getEditorState().order
  if (order.length === 0) return

  const layout = getLayout()
  const current = layout.activeEditorView.startsWith('doc:')
    ? layout.activeEditorView.slice(4)
    : null
  const index = current ? order.indexOf(current) : -1
  // 当前激活的不是文件标签（index < 0）时，+1 落到第一个文件、-1 落到最后一个
  const from = index < 0 ? (delta > 0 ? -1 : 0) : index
  const next = (((from + delta) % order.length) + order.length) % order.length
  setLayout({ activeEditorView: documentKey(order[next]) })
}
