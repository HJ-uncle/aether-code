import type { editor } from 'monaco-editor'
import { setContextKey } from '../platform/context-keys'

let lastFocusedEditor: editor.IStandaloneCodeEditor | null = null

/** 命令面板会拿走 DOM 焦点，因此动作应使用最后聚焦且尚未销毁的文本编辑器。 */
export function getActiveEditor(): editor.IStandaloneCodeEditor | null {
  const model = lastFocusedEditor?.getModel()
  return model && !model.isDisposed() ? lastFocusedEditor : null
}

export function registerActiveEditor(instance: editor.IStandaloneCodeEditor): () => void {
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
    if (lastFocusedEditor === instance) {
      lastFocusedEditor = null
      setContextKey('editorTextFocus', false)
    }
  }
  if (instance.hasTextFocus()) focus()
  return dispose
}
