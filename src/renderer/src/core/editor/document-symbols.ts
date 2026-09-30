import type { languages } from 'monaco-editor'
import { monaco, peekModel } from './monaco-setup'
import { fileIdentity } from './file-identity'
import {
  getTsLanguageServiceGeneration,
  isTsLspRunning,
  onTsLanguageServiceChanged,
  requestProjectDocumentSymbols,
  supportsProjectSymbols
} from '../lsp/ts-client'

export interface DocumentSymbolsSnapshot {
  status: 'loading' | 'ready' | 'unavailable' | 'unsupported' | 'error'
  symbols: languages.DocumentSymbol[]
  message?: string
}

interface CachedSymbols {
  version: number
  generation: number
  language: string
  promise: Promise<DocumentSymbolsSnapshot>
  expiresAt: number
}

const cache = new WeakMap<monaco.editor.ITextModel, CachedSymbols>()
const EMPTY_RESULT_TTL_MS = 5_000

/** Outline and breadcrumbs share one request per document version and language-service session. */
export function fetchDocumentSymbols(
  filePath: string,
  force = false
): Promise<DocumentSymbolsSnapshot> {
  const model = peekModel(filePath)
  if (!model) return Promise.resolve({ status: 'loading', symbols: [], message: '正在加载文件…' })
  if (!supportsProjectSymbols(model))
    return Promise.resolve({
      status: 'unsupported',
      symbols: [],
      message: '当前语言尚未接入大纲服务'
    })
  if (!isTsLspRunning())
    return Promise.resolve({
      status: 'unavailable',
      symbols: [],
      message: '项目语言服务尚未就绪，请打开项目或稍后重试'
    })
  const version = model.getVersionId()
  const generation = getTsLanguageServiceGeneration()
  const previous = cache.get(model)
  if (
    !force &&
    previous?.version === version &&
    previous.generation === generation &&
    previous.language === model.getLanguageId() &&
    previous.expiresAt > Date.now()
  )
    return previous.promise

  const entry: CachedSymbols = {
    version,
    generation,
    language: model.getLanguageId(),
    expiresAt: Number.POSITIVE_INFINITY,
    promise: Promise.resolve({ status: 'loading', symbols: [] })
  }
  entry.promise = requestProjectDocumentSymbols(model)
    .then((symbols): DocumentSymbolsSnapshot => {
      // A late result must not become the navigation tree for newer unsaved text.
      if (
        model.isDisposed() ||
        model.getVersionId() !== version ||
        generation !== getTsLanguageServiceGeneration()
      ) {
        return { status: 'loading', symbols: [], message: '正在更新大纲…' }
      }
      if (!symbols.length) entry.expiresAt = Date.now() + EMPTY_RESULT_TTL_MS
      return { status: 'ready', symbols }
    })
    .catch((error: unknown): DocumentSymbolsSnapshot => {
      entry.expiresAt = Date.now() + EMPTY_RESULT_TTL_MS
      return {
        status: isTsLspRunning() ? 'error' : 'unavailable',
        symbols: [],
        message: isTsLspRunning()
          ? `无法获取大纲：${error instanceof Error ? error.message : String(error)}`
          : '项目语言服务已断开'
      }
    })
  cache.set(model, entry)
  return entry.promise
}

export function invalidateDocumentSymbols(filePath: string): void {
  const model = peekModel(filePath)
  if (model) cache.delete(model)
}

/** Changes are debounced while cursor movement alone never sends a language-service request. */
export function watchDocumentSymbols(
  filePath: string,
  listener: (snapshot: DocumentSymbolsSnapshot) => void
): () => void {
  let disposed = false
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let changeSubscription: monaco.IDisposable | undefined
  let watchedModel: monaco.editor.ITextModel | null = null
  const refresh = (): void => {
    const current = ++revision
    listener({ status: 'loading', symbols: [], message: '正在更新大纲…' })
    void fetchDocumentSymbols(filePath).then((snapshot) => {
      if (!disposed && current === revision) listener(snapshot)
    })
  }
  const schedule = (): void => {
    ++revision
    clearTimeout(timer)
    timer = setTimeout(refresh, 180)
  }
  const bind = (): void => {
    const model = peekModel(filePath)
    if (model === watchedModel) return
    changeSubscription?.dispose()
    watchedModel = model
    changeSubscription = model?.onDidChangeContent(schedule)
    refresh()
  }
  const identity = fileIdentity(filePath)
  const creation = monaco.editor.onDidCreateModel((model) => {
    if (model.uri.scheme === 'file' && fileIdentity(model.uri.fsPath) === identity) bind()
  })
  const disposal = monaco.editor.onWillDisposeModel((model) => {
    if (model !== watchedModel) return
    ++revision
    clearTimeout(timer)
    changeSubscription?.dispose()
    watchedModel = null
    listener({ status: 'unavailable', symbols: [], message: '文件已关闭' })
  })
  const languageChange = monaco.editor.onDidChangeModelLanguage(({ model }) => {
    if (model === watchedModel) refresh()
  })
  const stopService = onTsLanguageServiceChanged(refresh)
  bind()
  if (!watchedModel) refresh()
  return () => {
    disposed = true
    ++revision
    clearTimeout(timer)
    changeSubscription?.dispose()
    creation.dispose()
    disposal.dispose()
    languageChange.dispose()
    stopService()
  }
}
