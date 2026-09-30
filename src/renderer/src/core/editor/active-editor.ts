import type { editor } from 'monaco-editor'
import { setContextKey } from '../platform/context-keys'

let lastFocusedEditor: editor.IStandaloneCodeEditor | null = null
const groupEditors = new Map<string, editor.IStandaloneCodeEditor>()

/** 标签/工具栏取得焦点时也要切换命令目标，不能继续操作另一栏最后收到文本焦点的编辑器。 */
export function setActiveEditorGroup(groupId: string): void {
  // Diff 等静态视图可按自身 ID 注册，它的命令归属仍由所在编辑组决定。
  const hosted = [...groupEditors.values()].filter((instance) =>
    instance.getDomNode()?.closest<HTMLElement>('[data-editor-group]')?.dataset.editorGroup === groupId)
  lastFocusedEditor = hosted.find((instance) => instance.hasTextFocus())
    ?? (lastFocusedEditor && hosted.includes(lastFocusedEditor) ? lastFocusedEditor : null)
    ?? groupEditors.get(groupId) ?? hosted[hosted.length - 1] ?? null
  setContextKey('editorTextFocus', lastFocusedEditor?.hasTextFocus() === true)
}

/** 命令面板会拿走 DOM 焦点，因此动作应使用最后聚焦且尚未销毁的文本编辑器。 */
export function getActiveEditor(): editor.IStandaloneCodeEditor | null {
  const model = lastFocusedEditor?.getModel()
  return model && !model.isDisposed() ? lastFocusedEditor : null
}

export function registerActiveEditor(instance: editor.IStandaloneCodeEditor, groupId = 'main'): () => void {
  groupEditors.set(groupId, instance)
  let disposed = false
  const focus = (): void => {
    lastFocusedEditor = instance
    setContextKey('editorTextFocus', true)
  }
  const focusListener = instance.onDidFocusEditorText(focus)
  const blurListener = instance.onDidBlurEditorText(() => {
    if (lastFocusedEditor === instance) setContextKey('editorTextFocus', false)
  })
  const disposeListener = instance.onDidDispose(() => dispose())
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    focusListener.dispose()
    blurListener.dispose()
    disposeListener.dispose()
    if (groupEditors.get(groupId) === instance) groupEditors.delete(groupId)
    if (lastFocusedEditor === instance) {
      lastFocusedEditor = null
      setContextKey('editorTextFocus', false)
    }
  }
  if (instance.hasTextFocus()) focus()
  return dispose
}
