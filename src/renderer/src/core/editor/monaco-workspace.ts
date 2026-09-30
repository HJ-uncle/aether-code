import { acquireModel, languageForPath, monaco } from './monaco-setup'
import { activateDocument } from './editor-activation'
import { getDocument, onEditorChanged, openFile, resolveDocumentPath, setDocumentContent } from './editor-store'
import { fileIdentity } from './file-identity'

const pendingModels = new Map<string, Promise<monaco.editor.ITextModel>>()
const synchronizedModels = new WeakSet<monaco.editor.ITextModel>()

function documentPath(resource: monaco.Uri): string {
  if (resource.scheme !== 'file') throw new Error('语言服务只能打开本地文件')
  return resolveDocumentPath(resource.fsPath)
}

/** Keep background models synchronized when no mounted React editor can relay their changes. */
function synchronizeDocument(model: monaco.editor.ITextModel, filePath: string): void {
  // Aether can reload an inactive document after a search replacement. The store
  // is authoritative for that change and also retains the user's unsaved buffer.
  const updateModel = (): void => {
    const doc = getDocument(filePath)
    if (doc && !doc.loading && model.getValue() !== doc.content) model.setValue(doc.content)
  }
  updateModel()
  if (synchronizedModels.has(model)) return
  synchronizedModels.add(model)
  const changes = model.onDidChangeContent(() => setDocumentContent(filePath, model.getValue()))
  const stopStore = onEditorChanged(updateModel)
  const disposal = model.onWillDispose(() => { changes.dispose(); stopStore(); disposal.dispose() })
}

/** Register every rename target as a visible dirty document, without saving or activating it. */
export function ensureWorkspaceModel(resource: monaco.Uri): Promise<monaco.editor.ITextModel> {
  const key = fileIdentity(resource.fsPath)
  const pending = pendingModels.get(key)
  if (pending) return pending
  const loading = (async () => {
    const filePath = documentPath(resource)
    await openFile(filePath)
    const doc = getDocument(filePath)
    if (!doc || doc.loading) throw new Error(`文件尚未加载完成：${filePath}`)
    if (doc.error) throw new Error(doc.error)
    if (doc.isBinary || doc.truncated || doc.tooLarge) throw new Error(`不能重命名二进制或未完整加载的文件：${filePath}`)

    // URI aliases must reuse the existing buffer instead of creating a second
    // Monaco model; the document store keeps both edits and the saved baseline.
    const model = acquireModel(filePath, languageForPath(filePath))
    synchronizeDocument(model, filePath)
    return model
  })()
  pendingModels.set(key, loading)
  void loading.finally(() => { if (pendingModels.get(key) === loading) pendingModels.delete(key) }).catch(() => {})
  return loading
}

/** Public Monaco opener -> existing Aether tabs and reveal requests. */
export async function openWorkspaceResource(resource: monaco.Uri, selection?: monaco.IRange | monaco.IPosition): Promise<void> {
  const filePath = documentPath(resource)
  const range = selection && 'startLineNumber' in selection ? selection : undefined
  const position = selection && 'lineNumber' in selection ? selection : undefined
  const length = range && range.startLineNumber === range.endLineNumber ? range.endColumn - range.startColumn : undefined
  await openFile(filePath, range?.startLineNumber ?? position?.lineNumber, range?.startColumn ?? position?.column, length)
  activateDocument(filePath)
}
