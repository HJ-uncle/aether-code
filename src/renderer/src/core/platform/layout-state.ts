/** Shared editor selection; session layout is owned by the workspace surface. */
export interface LayoutState { activeEditorView: string }

const STORAGE_KEY = 'aether.ide.layout'
function load(): LayoutState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<LayoutState>
    return { activeEditorView: typeof saved.activeEditorView === 'string' && saved.activeEditorView.startsWith('doc:') ? saved.activeEditorView : '' }
  } catch { return { activeEditorView: '' } }
}
let state = load()
const listeners = new Set<() => void>()
export function getLayout(): LayoutState { return state }
export function setLayout(patch: Partial<LayoutState>): void {
  if (patch.activeEditorView === undefined || patch.activeEditorView === state.activeEditorView) return
  state = { activeEditorView: patch.activeEditorView }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* Selection remains usable without local storage. */ }
  for (const listener of listeners) listener()
}
export function onLayoutChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
