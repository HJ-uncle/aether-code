import { getWorkspaceState, onWorkspaceChanged } from '../workspace/workspace-store'
import { getLayout, onLayoutChanged } from '../platform/layout-state'
import { toast } from '../toast'
import { fileIdentity } from './file-identity'
import { activateDocument } from './editor-activation'
import { getDocument, getDocumentIdentity, getEditorState, isDirty, onEditorChanged, openFile, restoreDocumentDraft } from './editor-store'
import { getEditorGroups, onEditorGroupsChanged, restoreEditorGroups, type EditorGroupsState } from './editor-groups'

interface SavedTab { path: string; draft?: { content: string; savedContent: string } }
interface Recovery { tabs: SavedTab[]; activePath: string | null; groups?: EditorGroupsState }
const keyFor = (root: string): string => `aether.editor.recovery:${fileIdentity(root)}`
const belongs = (root: string, path: string): boolean => fileIdentity(path).startsWith(`${fileIdentity(root).replace(/\/+$/, '')}/`)

function read(root: string): Recovery | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(keyFor(root)) ?? 'null')
    if (!value || typeof value !== 'object' || !('tabs' in value) || !Array.isArray(value.tabs)) return null
    const tabs: SavedTab[] = value.tabs.flatMap((tab: unknown) => {
      if (!tab || typeof tab !== 'object' || !('path' in tab) || typeof tab.path !== 'string' || !belongs(root, tab.path)) return []
      const draft = 'draft' in tab ? tab.draft : undefined
      return [{ path: tab.path, ...(draft && typeof draft === 'object' && 'content' in draft && 'savedContent' in draft &&
        typeof draft.content === 'string' && typeof draft.savedContent === 'string'
        ? { draft: { content: draft.content, savedContent: draft.savedContent } } : {}) }]
    })
    const rawGroups = 'groups' in value ? value.groups : undefined
    let groups: EditorGroupsState | undefined
    if (rawGroups && typeof rawGroups === 'object' && 'groups' in rawGroups && Array.isArray(rawGroups.groups)) {
      groups = {
        focusedGroupId: 'focusedGroupId' in rawGroups && typeof rawGroups.focusedGroupId === 'string' ? rawGroups.focusedGroupId : 'main',
        groups: rawGroups.groups.flatMap((group: unknown) => {
          if (!group || typeof group !== 'object' || !('id' in group) || typeof group.id !== 'string' ||
            !('paths' in group) || !Array.isArray(group.paths)) return []
          return [{ id: group.id, paths: group.paths.filter((path: unknown): path is string => typeof path === 'string' && belongs(root, path)),
            activeKey: 'activeKey' in group && typeof group.activeKey === 'string' ? group.activeKey : '' }]
        })
      }
    }
    return { tabs, activePath: 'activePath' in value && typeof value.activePath === 'string' && belongs(root, value.activePath) ? value.activePath : null, groups }
  } catch { return null }
}

/** 每项目恢复标签，并另存未保存内容；仅路径恢复无法保护编辑中的草稿。 */
export function startEditorRecovery(): () => void {
  let root: string | null = null
  let generation = 0
  let restoring = false
  let interactedDuringRestore = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let warned = false
  const persist = (): void => {
    if (!root || restoring) return
    const editor = getEditorState()
    const tabs: SavedTab[] = editor.order.filter((path) => belongs(root!, path)).map((path) => {
      const doc = getDocument(path)
      return { path, ...(doc && !doc.loading && !doc.truncated && isDirty(doc)
        ? { draft: { content: doc.content, savedContent: doc.savedContent } } : {}) }
    })
    const active = getLayout().activeEditorView
    const activePath = active.startsWith('doc:') ? active.slice(4) : null
    const state = getEditorGroups()
    const paths = new Set(tabs.map((tab) => tab.path))
    const groups: EditorGroupsState = {
      focusedGroupId: state.focusedGroupId,
      groups: state.groups.map((group) => ({
        ...group,
        paths: group.paths.filter((path) => paths.has(path)),
        activeKey: group.activeKey.startsWith('doc:') && !paths.has(group.activeKey.slice(4)) ? '' : group.activeKey
      }))
    }
    try {
      localStorage.setItem(keyFor(root), JSON.stringify({ tabs, activePath, groups } satisfies Recovery))
      warned = false
    } catch {
      if (!warned) toast.error('编辑草稿备份空间不足，请及时保存文件。')
      warned = true
    }
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, 250)
  }
  const switchWorkspace = (): void => {
    const next = getWorkspaceState().root
    if (next === root) return
    if (timer) clearTimeout(timer)
    persist()
    root = next
    const current = ++generation
    restoring = true
    interactedDuringRestore = false
    const saved = next ? read(next) : null
    if (!saved) { restoring = false; return }
    // StrictMode 会同步 setup → cleanup → setup；延后一拍才能让已清理的首轮在建立占位文档前退出。
    void Promise.resolve().then(async () => {
      if (current !== generation) return
      for (const tab of saved.tabs) {
        if (current !== generation) return
        if (getDocument(tab.path)) continue
        const opening = openFile(tab.path)
        const identity = getDocumentIdentity(tab.path)
        await opening
        if (current !== generation) return
        if (tab.draft && identity) restoreDocumentDraft(tab.path, tab.draft.content, tab.draft.savedContent, identity)
      }
      if (current !== generation) return
      // 用户已经主动打开另一个文件时，不让异步恢复抢走焦点。
      if (!interactedDuringRestore) {
        if (saved.groups) restoreEditorGroups(saved.groups)
        else if (saved.activePath && getDocument(saved.activePath)) activateDocument(saved.activePath)
      }
      restoring = false
      schedule()
    }).catch((error: unknown) => {
      if (current === generation) restoring = false
      console.error('[editor] 恢复编辑草稿失败', error)
    })
  }
  const unsubscribeWorkspace = onWorkspaceChanged(switchWorkspace)
  const unsubscribeEditor = onEditorChanged(schedule)
  const unsubscribeLayout = onLayoutChanged(schedule)
  const unsubscribeGroups = onEditorGroupsChanged(schedule)
  const recordInteraction = (): void => { if (restoring) interactedDuringRestore = true }
  window.addEventListener('pointerdown', recordInteraction, true)
  window.addEventListener('keydown', recordInteraction, true)
  window.addEventListener('beforeunload', persist)
  switchWorkspace()
  return () => {
    if (timer) clearTimeout(timer)
    persist()
    generation++
    unsubscribeWorkspace(); unsubscribeEditor(); unsubscribeLayout(); unsubscribeGroups()
    window.removeEventListener('pointerdown', recordInteraction, true)
    window.removeEventListener('keydown', recordInteraction, true)
    window.removeEventListener('beforeunload', persist)
  }
}
