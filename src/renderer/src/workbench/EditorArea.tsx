import { useCallback, useEffect, useMemo, type JSX, useSyncExternalStore } from 'react'
import { useApp } from '@renderer/core/app-context'
import { closeFile, documentKey, isDirty, useEditor } from '@renderer/core/editor/editor-store'
import { releaseModel } from '@renderer/core/editor/monaco-setup'
import { setLayout, closeEditorView } from '@renderer/core/platform/layout-state'
import { setActiveFile } from '@renderer/core/workspace/workspace-store'
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
      closable: view.closable === true
    }))
    const docTabs: Tab[] = editor.order.map((filePath) => {
      const doc = editor.docs.get(filePath)
      return {
        key: documentKey(filePath),
        title: doc?.name ?? filePath,
        dirty: doc ? isDirty(doc) : false,
        closable: true
      }
    })
    return [...staticTabs, ...docTabs]
  }, [visibleViews, editor.order, editor.docs])

  // 激活项：优先 layout 指定；失效（被关闭 / 无此标签）时回落到第一个可见标签，
  // 一个都没有则为空字符串 → 内容区显示空态，与标签栏保持一致
  const activeKey =
    tabs.find((tab) => tab.key === layout.activeEditorView)?.key ?? tabs[0]?.key ?? ''

  // 激活的是文件时，同步给资源管理器做高亮
  useEffect(() => {
    setActiveFile(activeKey.startsWith('doc:') ? activeKey.slice(4) : null)
  }, [activeKey])

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

      releaseModel(filePath)
      closeFile(filePath)
      setLayout({ activeEditorView: nextPath ? documentKey(nextPath) : '' })
    },
    [editor.docs, editor.order]
  )

  return (
    <section className="editor-area" aria-label="编辑区">
      <header className="editor-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className={`editor-tab${tab.key === activeKey ? ' is-active' : ''}`}
            role="tab"
            aria-selected={tab.key === activeKey}
            title={tab.key.startsWith('doc:') ? tab.key.slice(4) : tab.title}
            onClick={() => setLayout({ activeEditorView: tab.key })}
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
