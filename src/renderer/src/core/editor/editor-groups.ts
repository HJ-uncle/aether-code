import { useSyncExternalStore } from 'react'
import { documentKey, getDocument, getEditorState, onEditorChanged, setActiveDocument } from './editor-store'
import { fileIdentity } from './file-identity'
import { getActiveEditor, setActiveEditorGroup } from './active-editor'
import { getLayout, onLayoutChanged, setLayout } from '../platform/layout-state'
import { setActiveFile } from '../workspace/workspace-store'
import { getView, getViews, updateView } from '../../workbench/view-registry'
import { onDocumentRenamed } from './editor-store'

export interface EditorGroup {
  id: string
  paths: string[]
  activeKey: string
}

export interface EditorGroupsState {
  groups: EditorGroup[]
  focusedGroupId: string
}

let state: EditorGroupsState = {
  groups: [{ id: 'main', paths: [...getEditorState().order], activeKey: getLayout().activeEditorView }],
  focusedGroupId: 'main'
}
let nextGroupId = 1
let knownPaths = new Set(getEditorState().order)
const listeners = new Set<() => void>()
const viewStates = new Map<string, Map<string, unknown>>()
const renamedViewPaths = new Map<string, string>()

export function getEditorGroups(): EditorGroupsState { return state }

export function onEditorGroupsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 恢复只重建视图归属，文档必须先由恢复服务读取，损坏的快照不能制造悬空标签。 */
export function restoreEditorGroups(snapshot: EditorGroupsState): void {
  const ids = new Set<string>()
  for (const group of snapshot.groups) {
    const numeric = /^group-([1-9]\d*)$/.exec(group.id)
    if (numeric && Number.isSafeInteger(Number(numeric[1])) && Number(numeric[1]) < Number.MAX_SAFE_INTEGER) nextGroupId = Math.max(nextGroupId, Number(numeric[1]) + 1)
  }
  const visibleViews = new Set(getViews('editor')
    .filter((view) => !getLayout().closedEditorViews.includes(view.id)).map((view) => view.id))
  const groups = snapshot.groups.slice(0, 2).map((group, index): EditorGroup => {
    const validId = (group.id === 'main' || (/^group-[1-9]\d*$/.test(group.id) && Number.isSafeInteger(Number(group.id.slice(6))) && Number(group.id.slice(6)) < Number.MAX_SAFE_INTEGER)) && !ids.has(group.id)
    const id = validId ? group.id : `group-${nextGroupId++}`
    ids.add(id)
    const paths = [...new Set(group.paths.flatMap((path) => {
      const canonical = getDocument(path)?.path
      return canonical ? [canonical] : []
    }))]
    const path = activePath(group.activeKey)
    const canonical = path ? getDocument(path)?.path : null
    const activeKey = canonical && paths.includes(canonical) ? documentKey(canonical)
      : !path && index === 0 && visibleViews.has(group.activeKey) ? group.activeKey
        : paths[0] ? documentKey(paths[0]) : ''
    return { id, paths, activeKey }
  })
  if (!groups.length) groups.push({ id: 'main', paths: [], activeKey: '' })
  const focusedGroupId = groups.some((group) => group.id === snapshot.focusedGroupId)
    ? snapshot.focusedGroupId : groups[0].id
  // 恢复期间用户可能又打开文件，或切项目时还有旧项目的草稿；这些文档也必须保留可见入口。
  const represented = new Set(groups.flatMap((group) => group.paths))
  const target = groups.find((group) => group.id === focusedGroupId)!
  target.paths.push(...getEditorState().order.filter((path) => !represented.has(path)))
  if (!target.activeKey && target.paths.length) target.activeKey = documentKey(target.paths[0])
  knownPaths = new Set(getEditorState().order)
  publish(groups, focusedGroupId)
  syncFocusedDocument()
}

function publish(groups: EditorGroup[], focusedGroupId = state.focusedGroupId): void {
  state = { groups, focusedGroupId }
  for (const listener of listeners) listener()
}

function activePath(key: string): string | null {
  return key.startsWith('doc:') ? key.slice(4) : null
}

function syncFocusedDocument(): void {
  const group = state.groups.find((item) => item.id === state.focusedGroupId) ?? state.groups[0]
  const path = activePath(group.activeKey)
  setActiveEditorGroup(group.id)
  setActiveDocument(path)
  setActiveFile(path)
  setLayout({ activeEditorView: group.activeKey })
}

export function focusEditorGroup(id: string, focusText = false): void {
  if (!state.groups.some((group) => group.id === id)) return
  if (state.focusedGroupId !== id) publish(state.groups, id)
  syncFocusedDocument()
  if (focusText) getActiveEditor()?.focus()
}

export function activateGroupTab(id: string, key: string): void {
  const path = activePath(key)
  const canonical = path ? getDocument(path)?.path : null
  if (path && !canonical) return
  const targetKey = canonical ? documentKey(canonical) : key
  const groups = state.groups.map((group) => group.id === id ? {
    ...group,
    paths: canonical && !group.paths.includes(canonical) ? [...group.paths, canonical] : group.paths,
    activeKey: targetKey
  } : group)
  publish(groups, id)
  syncFocusedDocument()
  if (canonical) getActiveEditor()?.focus()
}

/** 文件数据只有一份，拆分仅创建第二个视图，不读取磁盘或覆盖现有模型。 */
export function splitDocumentToRight(path: string): void {
  const canonical = getDocument(path)?.path
  if (!canonical) return
  let target = state.groups[1]
  if (!target) {
    target = { id: `group-${nextGroupId++}`, paths: [], activeKey: '' }
    publish([...state.groups, target])
  }
  activateGroupTab(target.id, documentKey(canonical))
}

/** Move a registered editor surface beside code without duplicating its native view. */
export function openViewToRight(viewId: string): void {
  let target = state.groups[1]
  if (!target) {
    target = { id: `group-${nextGroupId++}`, paths: [], activeKey: '' }
    publish([...state.groups, target])
  }
  updateView(viewId, { editorGroupId: target.id })
  const layout = getLayout()
  setLayout({ closedEditorViews: layout.closedEditorViews.filter((id) => id !== viewId) })
  activateGroupTab(target.id, viewId)
}

export function moveDocumentToOtherGroup(groupId: string, path: string): void {
  const canonical = getDocument(path)?.path
  const source = state.groups.find((group) => group.id === groupId)
  if (!canonical || !source?.paths.includes(canonical)) return
  let target = state.groups.find((group) => group.id !== groupId)
  if (!target) {
    target = { id: `group-${nextGroupId++}`, paths: [], activeKey: '' }
    publish([...state.groups, target])
  }
  // 先建立目标所有权，再移除源视图，任何一刻都不会把仍有视图的文档当作可释放。
  activateGroupTab(target.id, documentKey(canonical))
  removeGroupTabs(groupId, [canonical])
}

export function documentGroups(path: string): EditorGroup[] {
  const identity = fileIdentity(path)
  return state.groups.filter((group) => group.paths.some((entry) => fileIdentity(entry) === identity))
}

/** 返回真正失去最后一个视图的文档，由调用方统一确认后关闭文档和释放模型。 */
export function finalDocumentsForGroupClose(groupId: string, paths: readonly string[]): string[] {
  return paths.filter((path) => !state.groups.some((group) =>
    group.id !== groupId && group.paths.includes(path)))
}

export function removeGroupTabs(groupId: string, paths: readonly string[], closeGroup = false): void {
  const removed = new Set(paths)
  let groups = state.groups.map((group) => {
    if (group.id !== groupId) return group
    const remaining = group.paths.filter((path) => !removed.has(path))
    const current = activePath(group.activeKey)
    if (!current || !removed.has(current)) return { ...group, paths: remaining }
    const index = group.paths.indexOf(current)
    const next = group.paths.slice(index + 1).find((path) => !removed.has(path))
      ?? group.paths.slice(0, index).reverse().find((path) => !removed.has(path))
    return { ...group, paths: remaining, activeKey: next ? documentKey(next) : '' }
  })
  if (closeGroup && groups.length > 1) {
    groups = groups.filter((group) => group.id !== groupId)
    viewStates.delete(groupId)
  }
  const focused = groups.some((group) => group.id === state.focusedGroupId)
    ? state.focusedGroupId : groups[0].id
  publish(groups, focused)
  syncFocusedDocument()
}

export function rememberGroupViewState(groupId: string, path: string, viewState: unknown): void {
  if (viewState == null || !state.groups.some((group) => group.id === groupId)) return
  const group = viewStates.get(groupId) ?? new Map<string, unknown>()
  const identity = fileIdentity(path)
  const key = renamedViewPaths.get(identity) ?? identity
  group.delete(key)
  group.set(key, viewState)
  if (group.size > 50) group.delete(group.keys().next().value!)
  viewStates.set(groupId, group)
}

export function takeGroupViewState(groupId: string, path: string): unknown {
  const group = viewStates.get(groupId)
  const key = fileIdentity(path)
  const result = group?.get(key)
  group?.delete(key)
  return result
}

onEditorChanged(() => {
  const paths = getEditorState().order
  const alive = new Set(paths)
  const added = paths.filter((path) => !knownPaths.has(path))
  // Quick Open publishes the requested layout key before its asynchronous file
  // load registers the document. Re-apply that pending activation when the
  // document arrives, otherwise the focused split can keep rendering the
  // previously active document while the new tab is appended in the background.
  const pendingActivePath = activePath(getLayout().activeEditorView)
  const pendingActive = pendingActivePath
    ? added.find((path) => fileIdentity(path) === fileIdentity(pendingActivePath))
    : undefined
  for (const path of added) renamedViewPaths.delete(fileIdentity(path))
  knownPaths = alive
  let changed = false
  const groups = state.groups.map((group) => {
    const remaining = group.paths.filter((path) => alive.has(path))
    if (group.id === state.focusedGroupId) remaining.push(...added.filter((path) => !remaining.includes(path)))
    const current = activePath(group.activeKey)
    const activeKey = current && !alive.has(current)
      ? (remaining.length ? documentKey(remaining[remaining.length - 1]) : '')
      : group.id === state.focusedGroupId && pendingActive
        ? documentKey(pendingActive)
        : group.activeKey
    if (remaining.length === group.paths.length && remaining.every((path, index) => path === group.paths[index]) && activeKey === group.activeKey) return group
    changed = true
    return { ...group, paths: remaining, activeKey }
  })
  if (changed) {
    publish(groups)
    syncFocusedDocument()
  }
})

onDocumentRenamed((oldPath, newPath) => {
  const oldIdentity = fileIdentity(oldPath)
  const newIdentity = fileIdentity(newPath)
  for (const [path, target] of renamedViewPaths) {
    if (target === oldIdentity) renamedViewPaths.set(path, newIdentity)
  }
  renamedViewPaths.delete(newIdentity)
  if (oldIdentity !== newIdentity) renamedViewPaths.set(oldIdentity, newIdentity)
  knownPaths.delete(oldPath)
  knownPaths.add(newPath)
  for (const views of viewStates.values()) {
    const previous = views.get(fileIdentity(oldPath))
    if (previous !== undefined) {
      views.delete(fileIdentity(oldPath))
      views.set(fileIdentity(newPath), previous)
    }
  }
  const groups = state.groups.map((group) => ({
    ...group,
    paths: [...new Set(group.paths.map((path) => path === oldPath ? newPath : path))],
    activeKey: activePath(group.activeKey) === oldPath ? documentKey(newPath) : group.activeKey
  }))
  publish(groups)
  syncFocusedDocument()
})

// 现有打开/设置命令仍使用 layout；它是焦点组的兼容入口，不能覆盖另一个组的活动项。
onLayoutChanged(() => {
  const key = getLayout().activeEditorView
  const group = state.groups.find((item) => item.id === state.focusedGroupId) ?? state.groups[0]
  if (group.activeKey === key) return
  const assigned = getView(key)?.editorGroupId
  const target = activePath(key) ? group : state.groups.find((item) => item.id === assigned) ?? state.groups[0]
  activateGroupTab(target.id, key)
})

export function useEditorGroups(): EditorGroupsState {
  return useSyncExternalStore(onEditorGroupsChanged, getEditorGroups)
}
