/**
 * 视图注册表
 *
 * 侧边栏与面板里的内容不写死在布局组件里，而是通过注册的方式挂入。
 * 新增一个视图只需在 contrib 目录注册，不必修改 Workbench / Sidebar。
 *
 * 这就是「可扩展性」在渲染层的落点：布局只认 ID 与元数据，
 * 不认具体功能。
 */
import type { ComponentType } from 'react'

export type ViewLocation = 'sidebar' | 'panel' | 'editor' | 'right'

export interface ViewRegistration {
  id: string
  title: string
  location: ViewLocation
  /** 图标 ID，见 workbench/icons.tsx */
  icon: string
  /** 排序权重，越小越靠前 */
  order?: number
  /** 条件表达式，不满足时该视图不出现（见 core/platform/context-keys） */
  when?: string
  /** 主区固定标签是否允许用户关闭（仅 editor 位置有意义）；关闭后可通过 showEditorView 恢复 */
  closable?: boolean
  component: ComponentType
}

const views = new Map<string, ViewRegistration>()
const listeners = new Set<() => void>()
/** 按 location 缓存的列表：两次通知之间 getViews 返回同一引用，
 * 使 useSyncExternalStore 可直接以 getViews 作为快照函数 */
const cache = new Map<ViewLocation, ViewRegistration[]>()

function notify(): void {
  cache.clear()
  for (const listener of listeners) listener()
}

export function registerView(registration: ViewRegistration): () => void {
  if (views.has(registration.id)) {
    console.warn(`[views] 重复注册视图: ${registration.id}`)
  }
  views.set(registration.id, registration)
  notify()

  return () => {
    views.delete(registration.id)
    notify()
  }
}

export function registerViews(registrations: ViewRegistration[]): () => void {
  const disposers = registrations.map(registerView)
  return () => disposers.forEach((dispose) => dispose())
}

/** 更新动态视图元数据（例如 Git 差异标签需要跟随当前文件名变化）。 */
export function updateView(id: string, patch: Partial<Omit<ViewRegistration, 'id' | 'component'>>): void {
  const current = views.get(id)
  if (!current) return
  views.set(id, { ...current, ...patch })
  notify()
}

export function getViews(location: ViewLocation): ViewRegistration[] {
  let list = cache.get(location)
  if (!list) {
    list = [...views.values()]
      .filter((view) => view.location === location)
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    cache.set(location, list)
  }
  return list
}

export function getView(id: string): ViewRegistration | undefined {
  return views.get(id)
}

export function onViewsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ==================== 文档渲染器 ====================

/**
 * 文件标签的渲染组件。
 *
 * 之所以单独注册而不是让 EditorArea 直接 import 编辑器的实现：
 * workbench 层只应认识「ID + 组件」这种元数据，不该依赖 contrib 里的具体功能，
 * 否则布局代码会被功能拖住，新增/替换编辑器实现都要改 workbench。
 */
export type DocumentRenderer = ComponentType<{ filePath: string; groupId?: string }>

let documentRenderer: DocumentRenderer | null = null

export function registerDocumentRenderer(renderer: DocumentRenderer): void {
  documentRenderer = renderer
  notify()
}

export function getDocumentRenderer(): DocumentRenderer | null {
  return documentRenderer
}
