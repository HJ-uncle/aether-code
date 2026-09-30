import { getEditorState, onEditorChanged, reloadDocuments, resolveDocumentPath } from './editor-store'

let watcherGeneration = 0

export function watchOpenDocuments(): () => void {
  const generation = ++watcherGeneration
  let lastPaths = ''
  let disposed = false
  let chain = Promise.resolve()
  let reloading = false
  const pending = new Set<string>()
  const drain = async (): Promise<void> => {
    if (disposed || reloading) return
    const paths = [...pending].filter((path) => !getEditorState().saving.has(path))
    if (!paths.length) return
    paths.forEach((path) => pending.delete(path))
    reloading = true
    try { await reloadDocuments(paths) }
    finally { reloading = false; void drain() }
  }
  const enqueue = (paths: string[]): void => {
    paths.forEach((path) => pending.add(resolveDocumentPath(path)))
    void drain()
  }
  const synchronize = (): void => {
    const paths = [...getEditorState().docs.keys()].sort()
    const key = JSON.stringify(paths)
    if (key === lastPaths) return
    lastPaths = key
    chain = chain.then(async () => {
      if (!disposed) {
        await window.aether.fs.watchDocuments(paths)
        if (!disposed) enqueue(paths)
      }
    }).catch((error: unknown) => console.error('[editor] 文件监听启动失败', error))
  }
  const unsubscribe = window.aether.fs.onDocumentsChanged(enqueue)
  const unsubscribeEditor = onEditorChanged(() => { synchronize(); void drain() })
  const refresh = (): void => enqueue([...getEditorState().docs.keys()])
  window.addEventListener('focus', refresh)
  synchronize()
  return () => {
    disposed = true
    unsubscribe()
    unsubscribeEditor()
    window.removeEventListener('focus', refresh)
    // StrictMode 重挂载或工作台重建后，旧实例的异步清理不能清掉新实例的监听。
    void chain.then(() => {
      if (watcherGeneration === generation) return window.aether.fs.watchDocuments([])
      return undefined
    }).catch((error: unknown) => console.error('[editor] 文件监听清理失败', error))
  }
}
