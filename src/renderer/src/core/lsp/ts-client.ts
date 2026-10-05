/** Monaco <-> typescript-language-server bridge. */
import * as monaco from 'monaco-editor'
import { parseWorkspaceTextEdits } from './workspace-edit'
import { registerWorkspaceActions, type WorkspaceActionBridge } from './code-actions'
import { clearFileProblems, setFileProblems, type ProblemItem } from './problems-store'

let referenceModels: typeof import('../editor/reference-models') | null = null
let workspaceActions: WorkspaceActionBridge | null = null
let serverCommands: Set<string> | null = null
let codeActionResolveSupported = false
const MARKER_OWNER = 'tsserver'
const LSP_LANGUAGES = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact'])
const serviceListeners = new Set<() => void>()
export function onTsLanguageServiceChanged(listener: () => void): () => void {
  serviceListeners.add(listener)
  return () => serviceListeners.delete(listener)
}
function notifyServiceChanged(): void { for (const listener of serviceListeners) listener() }
export function getTsLanguageServiceGeneration(): number { return sessionGeneration }
export function supportsProjectSymbols(model: monaco.editor.ITextModel): boolean {
  return model.uri.scheme === 'file' && LSP_LANGUAGES.has(model.getLanguageId())
}
const REQUEST_TIMEOUT_MS = 15_000
const INITIALIZE_TIMEOUT_MS = 30_000
type BuiltinDefaults = typeof monaco.typescript.typescriptDefaults
const builtinModes = new Map<BuiltinDefaults, BuiltinDefaults['modeConfiguration']>()
const builtinDiagnostics = new Map<BuiltinDefaults, ReturnType<BuiltinDefaults['getDiagnosticsOptions']>>()

export function setBuiltinTsFeatures(disabled: boolean): void {
  const ts = monaco.typescript
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    if (!builtinModes.has(defaults)) builtinModes.set(defaults, { ...defaults.modeConfiguration })
    if (!builtinDiagnostics.has(defaults)) builtinDiagnostics.set(defaults, { ...defaults.getDiagnosticsOptions() })
    const modes = builtinModes.get(defaults)!
    const diagnostics = builtinDiagnostics.get(defaults)!
    defaults.setDiagnosticsOptions(disabled ? { ...diagnostics, noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true } : diagnostics)
    // Preserve features not replaced by the project LSP, such as on-type formatting
    // and inlay hints, and restore the original configuration when it disconnects.
    defaults.setModeConfiguration(disabled ? { ...modes, completionItems: false, hovers: false, definitions: false, references: false, documentHighlights: false, documentSymbols: false, rename: false, signatureHelp: false, diagnostics: false, documentRangeFormattingEdits: false } : modes)
  }
  if (disabled) for (const model of monaco.editor.getModels()) { monaco.editor.setModelMarkers(model, 'typescript', []); monaco.editor.setModelMarkers(model, 'javascript', []) }
}

interface PendingRequest { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout>; cancellationDisposable?: monaco.IDisposable }
let nextId = 1
const pendingRequests = new Map<number, PendingRequest>()
let disposeMessageListener: (() => void) | null = null
let disposeExitListener: (() => void) | null = null
let sessionGeneration = 0

function rejectPending(reason: Error): void {
  for (const [id, pending] of pendingRequests) { clearTimeout(pending.timer); pending.cancellationDisposable?.dispose(); pending.reject(reason); pendingRequests.delete(id) }
}
function lspRequest<T = unknown>(method: string, params?: unknown, token?: monaco.CancellationToken, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  if (token?.isCancellationRequested) return Promise.reject(new Error('LSP request cancelled'))
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = pendingRequests.get(id); if (!pending) return
      pendingRequests.delete(id); pending.cancellationDisposable?.dispose(); void window.aether.lsp.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }); reject(new Error(`LSP request timed out: ${method}`))
    }, timeoutMs)
    const pending: PendingRequest = { resolve: resolve as (value: unknown) => void, reject, timer }
    if (token) pending.cancellationDisposable = token.onCancellationRequested(() => { if (!pendingRequests.delete(id)) return; clearTimeout(timer); pending.cancellationDisposable?.dispose(); void window.aether.lsp.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }); reject(new Error('LSP request cancelled')) })
    pendingRequests.set(id, pending)
    void window.aether.lsp.send({ jsonrpc: '2.0', id, method, params }).then((result) => {
      if (!result.ok) { const current = pendingRequests.get(id); if (!current) return; pendingRequests.delete(id); clearTimeout(current.timer); current.cancellationDisposable?.dispose(); current.reject(new Error(`LSP send failed: ${method}`)) }
    }).catch((error: unknown) => { const current = pendingRequests.get(id); if (!current) return; pendingRequests.delete(id); clearTimeout(current.timer); current.cancellationDisposable?.dispose(); current.reject(error) })
  })
}
function lspNotify(method: string, params?: unknown): void { void window.aether.lsp.send({ jsonrpc: '2.0', method, params }).catch(() => undefined) }

interface LspRange { start: { line: number; character: number }; end: { line: number; character: number } }
interface LspDiagnostic { range: LspRange; severity?: number; code?: string | number; codeDescription?: { href?: string }; source?: string; message: string; tags?: number[]; relatedInformation?: Array<{ location: { uri: string; range: LspRange }; message: string }> }
interface PublishDiagnosticsParams { uri: string; diagnostics: LspDiagnostic[]; version?: number }
function toSeverity(severity?: number): monaco.MarkerSeverity { return severity === 1 ? monaco.MarkerSeverity.Error : severity === 2 ? monaco.MarkerSeverity.Warning : severity === 3 ? monaco.MarkerSeverity.Info : severity === 4 ? monaco.MarkerSeverity.Hint : monaco.MarkerSeverity.Error }
function toTags(tags?: number[]): monaco.MarkerTag[] | undefined { const result = (tags ?? []).filter((tag) => tag === 1 || tag === 2).map((tag) => tag === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated); return result.length ? result : undefined }
function toMonacoRange(range: LspRange): monaco.IRange { return { startLineNumber: range.start.line + 1, startColumn: range.start.character + 1, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 } }
function pathForUri(uri: string): string | null { try { return monaco.Uri.parse(uri).fsPath || null } catch { return null } }
const tsProblemFiles = new Set<string>()
const openVersions = new Map<string, number>()
function applyDiagnostics(params: PublishDiagnosticsParams): void {
  const model = monaco.editor.getModel(monaco.Uri.parse(params.uri)); const version = openVersions.get(params.uri)
  if (params.version !== undefined && version !== undefined && params.version < version) return
  const markers = params.diagnostics.map((diagnostic) => { const range = toMonacoRange(diagnostic.range); const marker: monaco.editor.IMarkerData = { severity: toSeverity(diagnostic.severity), message: diagnostic.message, source: diagnostic.source, startLineNumber: range.startLineNumber, startColumn: range.startColumn, endLineNumber: range.endLineNumber, endColumn: range.endColumn, tags: toTags(diagnostic.tags) }; if (diagnostic.code !== undefined) marker.code = diagnostic.codeDescription?.href ? { value: String(diagnostic.code), target: monaco.Uri.parse(diagnostic.codeDescription.href) } : String(diagnostic.code); if (diagnostic.relatedInformation?.length) marker.relatedInformation = diagnostic.relatedInformation.map((info) => { const related = toMonacoRange(info.location.range); return { resource: monaco.Uri.parse(info.location.uri), message: info.message, startLineNumber: related.startLineNumber, startColumn: related.startColumn, endLineNumber: related.endLineNumber, endColumn: related.endColumn } }); return marker })
  if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, markers)
  const filePath = pathForUri(params.uri); if (!filePath) return
  tsProblemFiles.add(filePath)
  const items: ProblemItem[] = params.diagnostics.map((diagnostic) => ({ severity: diagnostic.severity === 2 ? 'warning' : diagnostic.severity === 3 ? 'info' : diagnostic.severity === 4 ? 'hint' : 'error', line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1, endLine: diagnostic.range.end.line + 1, endColumn: diagnostic.range.end.character + 1, code: diagnostic.code === undefined ? undefined : String(diagnostic.code), message: diagnostic.message, source: diagnostic.source ?? 'typescript-language-server' }))
  setFileProblems(filePath, items, 'tsserver')
}
function handleMessage(message: Record<string, unknown>, generation = sessionGeneration): void {
  const id = message.id
  if (typeof id === 'number' && (message.result !== undefined || message.error !== undefined)) { const pending = pendingRequests.get(id); if (!pending) return; pendingRequests.delete(id); clearTimeout(pending.timer); pending.cancellationDisposable?.dispose(); if (message.error) pending.reject(new Error(String((message.error as { message?: unknown }).message ?? 'LSP request failed'))); else pending.resolve(message.result); return }
  if (message.method === 'workspace/applyEdit' && id !== undefined) {
    const params = message.params as { edit?: unknown } | undefined
    const applying = workspaceActions?.applyServerEdit(params?.edit) ?? Promise.resolve({ applied: false, failureReason: '项目语言服务尚未就绪' })
    void applying.then((result) => {
      if (generation === sessionGeneration) return window.aether.lsp.send({ jsonrpc: '2.0', id, result })
      return undefined
    }).catch(() => undefined)
    return
  }
  if (typeof message.method === 'string' && id !== undefined) { void window.aether.lsp.send({ jsonrpc: '2.0', id, result: null }).catch(() => undefined); return }
  if (message.method === 'textDocument/publishDiagnostics' && generation === sessionGeneration) applyDiagnostics(message.params as PublishDiagnosticsParams)
}

const syncedModels = new Set<string>(); const modelSubscriptions = new Map<string, monaco.IDisposable>(); let createModelSubscription: monaco.IDisposable | null = null; let disposeModelSubscription: monaco.IDisposable | null = null
function isLspLanguage(languageId: string): boolean { return LSP_LANGUAGES.has(languageId) }
function lspLanguageId(model: monaco.editor.ITextModel): string {
  const languageId = model.getLanguageId()
  // Monaco groups TSX/JSX under TypeScript/JavaScript, but tsserver uses the LSP ID
  // to choose its parser even when the filename has a JSX extension.
  if (languageId === 'typescript' && /\.tsx$/i.test(model.uri.path)) return 'typescriptreact'
  if (languageId === 'javascript' && /\.jsx$/i.test(model.uri.path)) return 'javascriptreact'
  return languageId
}
function attachModel(model: monaco.editor.ITextModel): void { const uri = model.uri.toString(); if (syncedModels.has(uri) || !isLspLanguage(model.getLanguageId())) return; syncedModels.add(uri); openVersions.set(uri, model.getVersionId()); lspNotify('textDocument/didOpen', { textDocument: { uri, languageId: lspLanguageId(model), version: model.getVersionId(), text: model.getValue() } }); modelSubscriptions.set(uri, model.onDidChangeContent(() => { const version = model.getVersionId(); openVersions.set(uri, version); lspNotify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: model.getValue() }] }) })) }
function detachModel(model: monaco.editor.ITextModel): void { const uri = model.uri.toString(); if (!syncedModels.delete(uri)) return; modelSubscriptions.get(uri)?.dispose(); modelSubscriptions.delete(uri); openVersions.delete(uri); lspNotify('textDocument/didClose', { textDocument: { uri } }); monaco.editor.setModelMarkers(model, MARKER_OWNER, []); const filePath = pathForUri(uri); if (filePath) { tsProblemFiles.delete(filePath); clearFileProblems(filePath, 'tsserver') } }
function syncAllModels(): void { for (const model of monaco.editor.getModels()) attachModel(model) }
function disposeModelListeners(): void { createModelSubscription?.dispose(); disposeModelSubscription?.dispose(); createModelSubscription = null; disposeModelSubscription = null; for (const subscription of modelSubscriptions.values()) subscription.dispose(); modelSubscriptions.clear(); syncedModels.clear(); openVersions.clear() }

function text(value: unknown): string | undefined { if (typeof value === 'string') return value; if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') return (value as { value: string }).value; return undefined }
function markdown(value: unknown): string | monaco.IMarkdownString | undefined { const content = text(value); return content ? { value: content, supportHtml: false } : undefined }
function positionParams(model: monaco.editor.ITextModel, position: monaco.Position): { textDocument: { uri: string }; position: { line: number; character: number } } { return { textDocument: { uri: model.uri.toString() }, position: { line: position.lineNumber - 1, character: position.column - 1 } } }
function mapKind(kind: unknown): monaco.languages.CompletionItemKind { const values: Record<number, monaco.languages.CompletionItemKind> = { 1: 18, 2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 7, 9: 8, 10: 9, 11: 10, 12: 11, 13: 12, 14: 13, 15: 15, 16: 16, 17: 17, 18: 6, 19: 10, 20: 20, 21: 21, 22: 23, 23: 15, 24: 24, 25: 25 }; return values[Number(kind)] ?? monaco.languages.CompletionItemKind.Text }
function mapEdit(edit: { range: LspRange; newText: string }): monaco.languages.TextEdit { return { range: toMonacoRange(edit.range), text: edit.newText } }
function mapSymbolKind(kind: unknown): monaco.languages.SymbolKind {
  const values: Record<number, monaco.languages.SymbolKind> = {
    1: monaco.languages.SymbolKind.File, 2: monaco.languages.SymbolKind.Module, 3: monaco.languages.SymbolKind.Namespace, 4: monaco.languages.SymbolKind.Package,
    5: monaco.languages.SymbolKind.Class, 6: monaco.languages.SymbolKind.Method, 7: monaco.languages.SymbolKind.Property, 8: monaco.languages.SymbolKind.Field,
    9: monaco.languages.SymbolKind.Constructor, 10: monaco.languages.SymbolKind.Enum, 11: monaco.languages.SymbolKind.Interface, 12: monaco.languages.SymbolKind.Function,
    13: monaco.languages.SymbolKind.Variable, 14: monaco.languages.SymbolKind.Constant, 15: monaco.languages.SymbolKind.String, 16: monaco.languages.SymbolKind.Number,
    17: monaco.languages.SymbolKind.Boolean, 18: monaco.languages.SymbolKind.Array, 19: monaco.languages.SymbolKind.Object, 20: monaco.languages.SymbolKind.Key,
    21: monaco.languages.SymbolKind.Null, 22: monaco.languages.SymbolKind.EnumMember, 23: monaco.languages.SymbolKind.Struct, 24: monaco.languages.SymbolKind.Event,
    25: monaco.languages.SymbolKind.Operator, 26: monaco.languages.SymbolKind.TypeParameter
  }
  return values[Number(kind)] ?? monaco.languages.SymbolKind.String
}
async function mapWorkspaceEdit(value: unknown, requestedVersions: Map<string, number>, token?: monaco.CancellationToken, generation = sessionGeneration): Promise<monaco.languages.WorkspaceEdit & monaco.languages.Rejection> {
  try {
    const documents = parseWorkspaceTextEdits(value)
    const resources = documents.map((document) => {
      const resource = monaco.Uri.parse(document.uri)
      if (resource.scheme !== 'file') throw new Error('语言服务只能编辑本地文件')
      return { document, resource }
    })
    if (token?.isCancellationRequested || generation !== sessionGeneration) return { edits: [], rejectReason: '已取消工作区编辑' }
    const { ensureWorkspaceModel } = await import('../editor/monaco-workspace')
    const targets = await Promise.all(resources.map(async ({ document, resource }) => ({ document, model: await ensureWorkspaceModel(resource) })))
    if (token?.isCancellationRequested || generation !== sessionGeneration) return { edits: [], rejectReason: '已取消工作区编辑' }
    const edits: monaco.languages.IWorkspaceTextEdit[] = []
    for (const { document, model } of targets) {
      const version = model.getVersionId()
      const requestedVersion = requestedVersions.get(model.uri.toString())
      if ((requestedVersion !== undefined && requestedVersion !== version) || (document.version != null && document.version !== version)) return { edits: [], rejectReason: '文件在操作期间发生变化，请重新执行' }
      for (const edit of document.edits) edits.push({ resource: model.uri, textEdit: mapEdit(edit), versionId: version })
    }
    return { edits }
  } catch (error) { return { edits: [], rejectReason: '无法准备工作区编辑：' + (error instanceof Error ? error.message : String(error)) } }
}

let providersDisposed: monaco.IDisposable[] = []
function disposeProviders(): void { referenceModels?.clearReferenceModels(); workspaceActions?.dispose(); workspaceActions = null; for (const disposable of providersDisposed) disposable.dispose(); providersDisposed = [] }
function registerProviders(): void {
  disposeProviders()
  // Monaco 0.56 reads modeConfiguration when its TS mode first initializes. An
  // exclusive public selector also excludes providers that initialized earlier,
  // so a rejected project rename cannot fall back to stale worker-only edits.
  const selector: monaco.languages.LanguageSelector = [...LSP_LANGUAGES].map((language) => ({ language, scheme: 'file', exclusive: true }))
  workspaceActions = registerWorkspaceActions({ selector, generation: () => sessionGeneration, request: lspRequest, prepareEdit: mapWorkspaceEdit, supportedCommands: serverCommands, resolveSupported: codeActionResolveSupported })
  providersDisposed.push(monaco.editor.registerEditorOpener({ async openCodeEditor(_source, resource, selection) {
    if (resource.scheme !== 'file') return false
    const { openWorkspaceResource } = await import('../editor/monaco-workspace')
    await openWorkspaceResource(resource, selection)
    return true
  } }))
  providersDisposed.push(monaco.languages.registerHoverProvider(selector, { async provideHover(model, position, token) { const result = await lspRequest<{ contents?: unknown; range?: LspRange } | null>('textDocument/hover', positionParams(model, position), token).catch(() => null); const contents = result?.contents; let value: string | undefined; if (Array.isArray(contents)) value = contents.map((entry) => text(entry) ?? '').filter(Boolean).join('\n\n'); else value = text(contents); return value ? { range: result?.range ? toMonacoRange(result.range) : undefined, contents: [{ value }] } : null } }))
  providersDisposed.push(monaco.languages.registerDefinitionProvider(selector, {
    async provideDefinition(model, position, token) {
      const result = await lspRequest<unknown>('textDocument/definition', positionParams(model, position), token).catch(() => null)
      return result ? prepareLocations(result, model, token) : null
    }
  }))
  providersDisposed.push(monaco.languages.registerReferenceProvider(selector, {
    async provideReferences(model, position, context, token) {
      const result = await lspRequest<unknown>('textDocument/references', { ...positionParams(model, position), context: { includeDeclaration: context.includeDeclaration } }, token).catch(() => null)
      return result ? prepareLocations(result, model, token) : null
    }
  }))
  providersDisposed.push(monaco.languages.registerRenameProvider(selector, {
    async resolveRenameLocation(model, position, token) {
      const fallback = { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '' }
      const version = model.getVersionId()
      try {
        const result = await lspRequest<LspRange | { range: LspRange; placeholder?: string } | { defaultBehavior: boolean } | null>('textDocument/prepareRename', positionParams(model, position), token)
        if (model.isDisposed() || model.getVersionId() !== version) return { ...fallback, rejectReason: '文件已变化，请重新选择要重命名的符号' }
        if (!result) return { ...fallback, rejectReason: '此位置的符号不能重命名' }
        if ('defaultBehavior' in result) {
          const word = result.defaultBehavior ? model.getWordAtPosition(position) : null
          return word ? { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), text: word.word } : { ...fallback, rejectReason: '此位置的符号不能重命名' }
        }
        const range = toMonacoRange('range' in result ? result.range : result)
        return { range, text: 'placeholder' in result && result.placeholder !== undefined ? result.placeholder : model.getValueInRange(range) }
      } catch (error) {
        return { ...fallback, rejectReason: '无法重命名：' + (error instanceof Error ? error.message : String(error)) }
      }
    }, async provideRenameEdits(model, position, newName, token) {
    const versions = new Map(monaco.editor.getModels().map((openModel) => [openModel.uri.toString(), openModel.getVersionId()]))
    const generation = sessionGeneration
    try {
      const result = await lspRequest<unknown>('textDocument/rename', { ...positionParams(model, position), newName }, token)
      if (model.isDisposed() || model.getVersionId() !== versions.get(model.uri.toString())) return { edits: [], rejectReason: '文件在重命名期间发生变化，请重新执行重命名' }
      return result ? mapWorkspaceEdit(result, versions, token, generation) : null
    } catch (error) { return { edits: [], rejectReason: `重命名失败：${error instanceof Error ? error.message : String(error)}` } }
  } }))
  providersDisposed.push(monaco.languages.registerDocumentFormattingEditProvider(selector, { displayName: 'TypeScript 项目语言服务', async provideDocumentFormattingEdits(model, options, token) {
    try {
      const result = await lspRequest<Array<{ range: LspRange; newText: string }> | null>('textDocument/formatting', { textDocument: { uri: model.uri.toString() }, options }, token)
      return result?.map(mapEdit) ?? []
    } catch (error) {
      // Monaco may start a second formatting request while the first one is still
      // in flight. A cancelled provider call is expected during that handoff and
      // must resolve quietly instead of surfacing an uncaught page error.
      if (token.isCancellationRequested || (error instanceof Error && /cancel/i.test(error.message))) return []
      throw error
    }
  } }))
  providersDisposed.push(monaco.languages.registerDocumentRangeFormattingEditProvider(selector, { displayName: 'TypeScript 项目语言服务', async provideDocumentRangeFormattingEdits(model, range, options, token) {
    try {
      const result = await lspRequest<Array<{ range: LspRange; newText: string }> | null>('textDocument/rangeFormatting', { textDocument: { uri: model.uri.toString() }, range: { start: { line: range.startLineNumber - 1, character: range.startColumn - 1 }, end: { line: range.endLineNumber - 1, character: range.endColumn - 1 } }, options }, token)
      return result?.map(mapEdit) ?? []
    } catch (error) {
      if (token.isCancellationRequested || (error instanceof Error && /cancel/i.test(error.message))) return []
      throw error
    }
  } }))
  providersDisposed.push(monaco.languages.registerSignatureHelpProvider(selector, { signatureHelpTriggerCharacters: ['(', ',', '<'], signatureHelpRetriggerCharacters: [','], async provideSignatureHelp(model, position, token, context) { const result = await lspRequest<{ signatures?: Array<{ label: string; documentation?: unknown; parameters?: Array<{ label: string | [number, number]; documentation?: unknown }> }>; activeSignature?: number; activeParameter?: number } | null>('textDocument/signatureHelp', { ...positionParams(model, position), context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger } }, token).catch(() => null); if (!result?.signatures?.length) return null; return { value: { signatures: result.signatures.map((signature) => ({ label: signature.label, documentation: markdown(signature.documentation), parameters: (signature.parameters ?? []).map((parameter) => ({ label: parameter.label, documentation: markdown(parameter.documentation) })) })), activeSignature: result.activeSignature ?? 0, activeParameter: result.activeParameter ?? 0 }, dispose() {} } } }))
  providersDisposed.push(monaco.languages.registerDocumentSymbolProvider(selector, {
    provideDocumentSymbols: (model, token) => requestProjectDocumentSymbols(model, token).catch(() => null)
  }))
  providersDisposed.push(monaco.languages.registerDocumentHighlightProvider(selector, { async provideDocumentHighlights(model, position, token) { const result = await lspRequest<Array<{ range: LspRange; kind?: number }> | null>('textDocument/documentHighlight', positionParams(model, position), token).catch(() => null); return result?.map((item) => ({ range: toMonacoRange(item.range), kind: item.kind === 2 ? monaco.languages.DocumentHighlightKind.Read : item.kind === 3 ? monaco.languages.DocumentHighlightKind.Write : monaco.languages.DocumentHighlightKind.Text })) ?? null } }))
  providersDisposed.push(monaco.languages.registerCompletionItemProvider(selector, { triggerCharacters: ['.', '"', "'", '/', '@', '<'], async provideCompletionItems(model, position, context, token) { const result = await lspRequest<{ items?: Array<Record<string, unknown>>; isIncomplete?: boolean } | Array<Record<string, unknown>> | null>('textDocument/completion', { ...positionParams(model, position), context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter } }, token).catch(() => null); const items = Array.isArray(result) ? result : result?.items ?? []; const word = model.getWordUntilPosition(position); const defaultRange: monaco.IRange = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }; return { suggestions: items.map((item) => mapCompletionItem(item, defaultRange)), incomplete: !Array.isArray(result) && Boolean(result?.isIncomplete) } }, async resolveCompletionItem(item, token) { const raw = (item as monaco.languages.CompletionItem & { __lspItem?: Record<string, unknown> }).__lspItem; if (!raw) return item; const resolved = await lspRequest<Record<string, unknown>>('completionItem/resolve', raw, token).catch(() => null); if (!resolved) return item; return mapCompletionItem({ ...raw, ...resolved }, item.range) } }))
}
function mapCompletionItem(item: Record<string, unknown>, defaultRange: monaco.languages.CompletionItem['range']): monaco.languages.CompletionItem { const textEdit = item.textEdit as { range?: LspRange; newText?: string; insert?: LspRange; replace?: LspRange } | undefined; const range = textEdit?.range ? toMonacoRange(textEdit.range) : textEdit?.insert && textEdit.replace ? { insert: toMonacoRange(textEdit.insert), replace: toMonacoRange(textEdit.replace) } : defaultRange; const mapped: monaco.languages.CompletionItem & { __lspItem?: Record<string, unknown> } = { label: typeof item.label === 'object' ? item.label as monaco.languages.CompletionItemLabel : String(item.label ?? ''), kind: mapKind(item.kind), detail: typeof item.detail === 'string' ? item.detail : undefined, documentation: markdown(item.documentation), insertText: textEdit?.newText ?? String(item.insertText ?? item.label ?? ''), range, sortText: typeof item.sortText === 'string' ? item.sortText : undefined, filterText: typeof item.filterText === 'string' ? item.filterText : undefined, insertTextRules: Number(item.insertTextFormat) === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined, tags: item.deprecated === true ? [monaco.languages.CompletionItemTag.Deprecated] : undefined, commitCharacters: Array.isArray(item.commitCharacters) ? item.commitCharacters.filter((v): v is string => typeof v === 'string') : undefined, command: workspaceActions?.completionCommand(item.command) }; const additional = Array.isArray(item.additionalTextEdits) ? item.additionalTextEdits as Array<{ range: LspRange; newText: string }> : []; mapped.additionalTextEdits = additional.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText })); Object.defineProperty(mapped, '__lspItem', { value: item, enumerable: false }); return mapped }

let running = false; let activeRoot: string | null = null; let lifecycleChain: Promise<unknown> = Promise.resolve()
function enqueue<T>(operation: () => Promise<T>): Promise<T> { const next = lifecycleChain.then(operation, operation); lifecycleChain = next.catch(() => undefined); return next }
async function startInternal(rootPath: string, serverEntry: string): Promise<boolean> { if (running && activeRoot === rootPath) return true; if (running) await stopInternal(); const generation = ++sessionGeneration; const rootUri = monaco.Uri.file(rootPath).toString(); let started: { ok: boolean }; try { started = await window.aether.lsp.start({ rootUri, serverEntry }) } catch { setBuiltinTsFeatures(false); return false }; if (!started.ok || generation !== sessionGeneration) { setBuiltinTsFeatures(false); return false }; disposeMessageListener = window.aether.lsp.onMessage((message) => handleMessage(message, generation)); disposeExitListener = window.aether.lsp.onExit(() => { if (generation !== sessionGeneration) return; running = false; activeRoot = null; notifyServiceChanged(); rejectPending(new Error('LSP server exited')); disposeProviders(); disposeModelListeners(); setBuiltinTsFeatures(false); for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []); for (const filePath of tsProblemFiles) clearFileProblems(filePath, 'tsserver'); tsProblemFiles.clear(); disposeMessageListener?.(); disposeExitListener?.(); disposeMessageListener = null; disposeExitListener = null }); try { const initialized = await lspRequest<{ capabilities?: { executeCommandProvider?: { commands?: string[] }; codeActionProvider?: boolean | { resolveProvider?: boolean } } }>('initialize', { processId: null, rootUri, initializationOptions: { locale: 'zh-CN' }, capabilities: { workspace: { applyEdit: true, workspaceEdit: { documentChanges: true, failureHandling: 'abort' } }, textDocument: { publishDiagnostics: { relatedInformation: true, versionSupport: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true }, hover: { contentFormat: ['markdown', 'plaintext'] }, completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits', 'textEdit', 'command'] } } }, codeAction: { dataSupport: true, disabledSupport: true, isPreferredSupport: true, resolveSupport: { properties: ['edit', 'command'] }, codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } } }, definition: { linkSupport: true }, rename: { prepareSupport: true }, signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } }, documentSymbol: { hierarchicalDocumentSymbolSupport: true } } }, workspaceFolders: [{ uri: rootUri, name: rootPath.split(/[\\/]/).pop() ?? rootPath }] }, undefined, INITIALIZE_TIMEOUT_MS); serverCommands = initialized.capabilities?.executeCommandProvider?.commands ? new Set(initialized.capabilities.executeCommandProvider.commands) : null; const codeAction = initialized.capabilities?.codeActionProvider; codeActionResolveSupported = typeof codeAction === 'object' && codeAction.resolveProvider === true; lspNotify('initialized', {}) } catch { await stopInternal(); setBuiltinTsFeatures(false); return false }; if (generation !== sessionGeneration) { await stopInternal(); return false }; running = true; activeRoot = rootPath; setBuiltinTsFeatures(true); registerProviders(); syncAllModels(); notifyServiceChanged(); createModelSubscription = monaco.editor.onDidCreateModel((model) => { if (running) attachModel(model) }); disposeModelSubscription = monaco.editor.onWillDisposeModel((model) => { if (running) detachModel(model) }); return true }
export function startTsLsp(rootPath: string, serverEntry: string): Promise<boolean> { return enqueue(() => startInternal(rootPath, serverEntry)) }
async function stopInternal(): Promise<void> { const wasRunning = running; ++sessionGeneration; running = false; activeRoot = null; notifyServiceChanged(); disposeProviders(); if (wasRunning) { await lspRequest('shutdown', undefined, undefined, 2_000).catch(() => undefined); lspNotify('exit') }; rejectPending(new Error('LSP stopped')); disposeModelListeners(); for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []); for (const filePath of tsProblemFiles) clearFileProblems(filePath, 'tsserver'); tsProblemFiles.clear(); disposeMessageListener?.(); disposeExitListener?.(); disposeMessageListener = null; disposeExitListener = null; try { await window.aether.lsp.stop() } finally { setBuiltinTsFeatures(false) } }
export function stopTsLsp(): Promise<void> { return enqueue(stopInternal) }
export function isTsLspRunning(): boolean { return running }

/** Share the same real project query with Monaco navigation, outline and breadcrumbs. */
export async function requestProjectDocumentSymbols(model: monaco.editor.ITextModel, token?: monaco.CancellationToken): Promise<monaco.languages.DocumentSymbol[]> {
  if (!running) throw new Error('项目语言服务尚未就绪')
  if (!supportsProjectSymbols(model)) throw new Error('当前语言尚未接入项目符号服务')
  const result = await lspRequest<unknown[] | null>('textDocument/documentSymbol', { textDocument: { uri: model.uri.toString() } }, token)
  const mapSymbol = (value: unknown): monaco.languages.DocumentSymbol => {
    const item = value as { name: string; detail?: string; kind?: number; tags?: number[]; range?: LspRange; selectionRange?: LspRange; children?: unknown[]; location?: { range: LspRange } }
    const range = item.range ?? item.location?.range
    if (!range) throw new Error('语言服务返回了无效的符号位置')
    return { name: item.name, detail: item.detail ?? '', kind: mapSymbolKind(item.kind), tags: item.tags?.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : [], range: toMonacoRange(range), selectionRange: toMonacoRange(item.selectionRange ?? range), children: item.children?.map(mapSymbol) }
  }
  return (result ?? []).map(mapSymbol)
}

async function prepareLocations(value: unknown, source: monaco.editor.ITextModel, token: monaco.CancellationToken): Promise<monaco.languages.Location[]> {
  const generation = sessionGeneration
  const locations = (Array.isArray(value) ? value : [value]).flatMap((location) => {
    if (!location || typeof location !== 'object') return []
    const item = location as { uri?: string; range?: LspRange; targetUri?: string; targetRange?: LspRange; targetSelectionRange?: LspRange }
    const uri = item.targetUri ?? item.uri
    const range = item.targetSelectionRange ?? item.targetRange ?? item.range
    return uri && range ? [{ uri: monaco.Uri.parse(uri), range: toMonacoRange(range) }] : []
  })
  referenceModels = await import('../editor/reference-models')
  if (token.isCancellationRequested || generation !== sessionGeneration) return []
  return referenceModels.prepareReferenceLocations(source, locations, token)
}
