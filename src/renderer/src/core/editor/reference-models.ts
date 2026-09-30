import { getActiveEditor } from './active-editor'
import { getDocument } from './editor-store'
import { fileIdentity } from './file-identity'
import { languageForPath, monaco, peekModel } from './monaco-setup'
import { ensureWorkspaceModel } from './monaco-workspace'
import { readFile } from '../workspace/fs-client'
import { toast } from '../toast'

interface PreviewModel {
  model: monaco.editor.ITextModel
  owners: Set<string>
}
const previews = new Map<string, PreviewModel>()
const pending = new Map<string, Promise<monaco.editor.ITextModel | null>>()
const queries = new Map<string, number>()
const trackedEditors = new WeakSet<monaco.editor.ICodeEditor>()
let epoch = 0

function collectUnused(): void {
  for (const [key, preview] of previews) {
    // Once opened as a real document, the shared document service owns its lifetime.
    if (preview.model.isDisposed() || getDocument(preview.model.uri.fsPath)) {
      previews.delete(key)
      continue
    }
    if (!preview.owners.size && !preview.model.isAttachedToEditor()) {
      preview.model.dispose()
      previews.delete(key)
    }
  }
}
function release(owner: string): void {
  for (const preview of previews.values()) preview.owners.delete(owner)
  collectUnused()
}
function trackEditor(editor: monaco.editor.ICodeEditor): void {
  if (trackedEditors.has(editor)) return
  trackedEditors.add(editor)
  const change = editor.onDidChangeModel(() => {
    queries.delete(editor.getId())
    release(editor.getId())
  })
  const disposal = editor.onDidDispose(() => {
    release(editor.getId())
    queries.delete(editor.getId())
    change.dispose()
    disposal.dispose()
    // Embedded peek editors detach their models as they finish disposal.
    queueMicrotask(collectUnused)
  })
}
for (const editor of monaco.editor.getEditors()) trackEditor(editor)
monaco.editor.onDidCreateEditor(trackEditor)

async function load(resource: monaco.Uri): Promise<monaco.editor.ITextModel | null> {
  if (resource.scheme !== 'file') return null
  const key = fileIdentity(resource.fsPath)
  const existing = peekModel(resource.fsPath)
  if (existing) return existing
  if (getDocument(resource.fsPath)) return ensureWorkspaceModel(resource)
  const waiting = pending.get(key)
  if (waiting) return waiting
  const loadingEpoch = epoch
  const loading = (async () => {
    const file = await readFile(resource.fsPath)
    if (loadingEpoch !== epoch || file.isBinary || file.truncated || file.tooLarge) return null
    const nowOpen = peekModel(resource.fsPath)
    if (nowOpen) return nowOpen
    if (getDocument(resource.fsPath)) return ensureWorkspaceModel(resource)
    const model = monaco.editor.createModel(
      file.content,
      languageForPath(resource.fsPath),
      resource
    )
    previews.set(key, { model, owners: new Set() })
    return model
  })().catch(() => null)
  pending.set(key, loading)
  void loading.finally(() => {
    if (pending.get(key) === loading) pending.delete(key)
  })
  return loading
}

/** Keep only the current lookup per source editor, without opening a tab for every reference. */
export async function prepareReferenceLocations(
  source: monaco.editor.ITextModel,
  locations: monaco.languages.Location[],
  token: monaco.CancellationToken
): Promise<monaco.languages.Location[]> {
  const active = getActiveEditor()
  const editor =
    active?.getModel() === source
      ? active
      : monaco.editor.getEditors().find((candidate) => candidate.getModel() === source)
  const owner = editor?.getId() ?? source.uri.toString()
  const query = (queries.get(owner) ?? 0) + 1
  const queryEpoch = epoch
  queries.set(owner, query)
  release(owner)
  const resources = [
    ...new Map(
      locations.map((location) => [fileIdentity(location.uri.fsPath), location.uri])
    ).values()
  ]
  const loaded = new Map<string, monaco.editor.ITextModel>()
  let index = 0
  const current = (): boolean =>
    queryEpoch === epoch &&
    !token.isCancellationRequested &&
    !source.isDisposed() &&
    queries.get(owner) === query
  await Promise.all(
    Array.from({ length: Math.min(resources.length, 4) }, async () => {
      while (index < resources.length && current()) {
        const resource = resources[index++]
        const model = await load(resource)
        if (!model || !current()) continue
        const key = fileIdentity(resource.fsPath)
        loaded.set(key, model)
        previews.get(key)?.owners.add(owner)
      }
    })
  )
  collectUnused()
  if (!current()) return []
  const missing = resources.length - loaded.size
  if (missing) toast.warning(`${missing} 个目标文件无法完整预览，已显示其余可读取的位置`)
  return locations.flatMap((location) => {
    const model = loaded.get(fileIdentity(location.uri.fsPath))
    return model && !model.isDisposed() ? [{ ...location, uri: model.uri }] : []
  })
}

export function clearReferenceModels(): void {
  ++epoch
  queries.clear()
  for (const preview of previews.values()) preview.owners.clear()
  collectUnused()
}
