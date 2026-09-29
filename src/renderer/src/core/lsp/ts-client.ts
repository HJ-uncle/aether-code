/**
 * TS 语言服务客户端（渲染进程）
 *
 * 与 typescript-language-server 走 LSP 协议，提供真实诊断（读 tsconfig、
 * node_modules 的 .d.ts），替代 Monaco 内置 TS worker 的纯内存猜测。
 *
 * 职责：
 *   - 生命周期：start 启动服务器 + initialize 握手 + 注册 provider；
 *     stop 退出并恢复内置 worker 兜底
 *   - 文档同步：didOpen / didChange（全量）/ didClose 跟随 Monaco model
 *   - 诊断渲染：publishDiagnostics → monaco.editor.setModelMarkers
 *   - 语言功能：hover / 跳定义 / 引用 / 补全 / 签名 经 LSP 请求转成 Monaco provider
 *
 * 单实例：一个工作区根配一个服务器进程，重复 start 先 stop 旧的。
 * 关闭内置 worker 只在 LSP 就绪后进行；LSP 挂了会恢复内置，保证有兜底。
 */
import * as monaco from 'monaco-editor'

// ==================== 协议常量 ====================

const MARKER_OWNER = 'tsserver'

/** 只对这些语言启用 LSP（诊断 + 语言功能） */
const LSP_LANGUAGES = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact'])

// ==================== 内置 worker 开关 ====================

/**
 * 关掉 Monaco 内置 TS worker 的全部可见功能。
 *
 * 内置 worker 不读 tsconfig、不认 paths 别名、没有 node_modules 的 .d.ts，
 * 会对 import 'electron' / '@renderer/...' 误报 Cannot find module。
 * LSP 接管后必须把它关掉，否则两套诊断叠在一起、错误码互相矛盾。
 */
export function setBuiltinTsFeatures(disabled: boolean): void {
  // Monaco 0.56 将语言服务移到顶层导出，旧 languages.typescript 在运行时已不存在。
  const ts = monaco.typescript
  const defaultsList = [ts.typescriptDefaults, ts.javascriptDefaults]
  for (const defaults of defaultsList) {
    defaults.setDiagnosticsOptions({
      noSemanticValidation: disabled,
      noSyntaxValidation: disabled,
      noSuggestionDiagnostics: disabled
    })
    defaults.setModeConfiguration({
      completionItems: !disabled,
      hovers: !disabled,
      definitions: !disabled,
      references: !disabled,
      documentHighlights: !disabled,
      documentSymbols: !disabled,
      rename: !disabled,
      signatureHelp: !disabled,
      diagnostics: !disabled
    })
  }
  if (disabled) {
    // 关掉后清掉内置 worker 已落的 marker（owner 是 'typescript'/'javascript'）
    for (const model of monaco.editor.getModels()) {
      monaco.editor.setModelMarkers(model, 'typescript', [])
      monaco.editor.setModelMarkers(model, 'javascript', [])
    }
  }
}

// ==================== JSON-RPC 通道 ====================

let nextId = 1
const pendingRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
>()
let disposeMessageListener: (() => void) | null = null
let disposeExitListener: (() => void) | null = null

/** 发请求并等响应 */
function lspRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject
    })
    void window.aether.lsp.send({ jsonrpc: '2.0', id, method, params })
  })
}

/** 发通知（无响应） */
function lspNotify(method: string, params?: unknown): void {
  void window.aether.lsp.send({ jsonrpc: '2.0', method, params })
}

/** 服务器推来的消息：按有无 id 区分响应与通知 */
function handleMessage(message: Record<string, unknown>): void {
  const id = message.id
  if (typeof id === 'number' && (message.result !== undefined || message.error !== undefined)) {
    const pending = pendingRequests.get(id)
    if (!pending) return
    pendingRequests.delete(id)
    if (message.error) {
      const err = message.error as { message?: string }
      pending.reject(new Error(err.message ?? 'LSP request failed'))
    } else {
      pending.resolve(message.result)
    }
    return
  }
  // 服务器通知
  if (message.method === 'textDocument/publishDiagnostics') {
    applyDiagnostics(message.params as PublishDiagnosticsParams)
  }
}

// ==================== 诊断渲染 ====================

interface LspRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

interface LspDiagnostic {
  range: LspRange
  severity?: number
  code?: string | number
  codeDescription?: { href?: string }
  source?: string
  message: string
  tags?: number[]
  relatedInformation?: Array<{
    location: { uri: string; range: LspRange }
    message: string
  }>
}

interface PublishDiagnosticsParams {
  uri: string
  diagnostics: LspDiagnostic[]
}

function toSeverity(severity: number | undefined): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error
    case 2:
      return monaco.MarkerSeverity.Warning
    case 3:
      return monaco.MarkerSeverity.Info
    case 4:
      return monaco.MarkerSeverity.Hint
    default:
      return monaco.MarkerSeverity.Error
  }
}

function toTags(tags: number[] | undefined): monaco.MarkerTag[] | undefined {
  if (!tags || tags.length === 0) return undefined
  const out: monaco.MarkerTag[] = []
  for (const tag of tags) {
    if (tag === 1) out.push(monaco.MarkerTag.Unnecessary)
    if (tag === 2) out.push(monaco.MarkerTag.Deprecated)
  }
  return out.length > 0 ? out : undefined
}

/** LSP range 0 基 → Monaco 1 基 */
function toMonacoRange(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

function applyDiagnostics(params: PublishDiagnosticsParams): void {
  const uri = monaco.Uri.parse(params.uri)
  const model = monaco.editor.getModel(uri)
  if (!model) return
  const markers: monaco.editor.IMarkerData[] = params.diagnostics.map((diagnostic) => {
    const marker: monaco.editor.IMarkerData = {
      severity: toSeverity(diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source,
      startLineNumber: toMonacoRange(diagnostic.range).startLineNumber,
      startColumn: toMonacoRange(diagnostic.range).startColumn,
      endLineNumber: toMonacoRange(diagnostic.range).endLineNumber,
      endColumn: toMonacoRange(diagnostic.range).endColumn,
      tags: toTags(diagnostic.tags)
    }
    if (diagnostic.code !== undefined) {
      marker.code = diagnostic.codeDescription?.href
        ? { value: String(diagnostic.code), target: monaco.Uri.parse(diagnostic.codeDescription.href) }
        : String(diagnostic.code)
    }
    if (diagnostic.relatedInformation && diagnostic.relatedInformation.length > 0) {
      marker.relatedInformation = diagnostic.relatedInformation.map((info) => ({
        resource: monaco.Uri.parse(info.location.uri),
        message: info.message,
        startLineNumber: toMonacoRange(info.location.range).startLineNumber,
        startColumn: toMonacoRange(info.location.range).startColumn,
        endLineNumber: toMonacoRange(info.location.range).endLineNumber,
        endColumn: toMonacoRange(info.location.range).endColumn
      }))
    }
    return marker
  })
  monaco.editor.setModelMarkers(model, MARKER_OWNER, markers)
}

// ==================== 文档同步 ====================

const syncedModels = new Set<string>()

function isLspLanguage(languageId: string): boolean {
  return LSP_LANGUAGES.has(languageId)
}

function attachModel(model: monaco.editor.ITextModel): void {
  const uri = model.uri.toString()
  if (syncedModels.has(uri) || !isLspLanguage(model.getLanguageId())) return
  syncedModels.add(uri)
  lspNotify('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: model.getLanguageId(),
      version: 1,
      text: model.getValue()
    }
  })
  model.onDidChangeContent(() => {
    // 全量同步：简单可靠，代价是大文件每次全发 —— 与 wuzu-client 一致
    lspNotify('textDocument/didChange', {
      textDocument: { uri, version: model.getVersionId() },
      contentChanges: [{ text: model.getValue() }]
    })
  })
}

function detachModel(model: monaco.editor.ITextModel): void {
  const uri = model.uri.toString()
  if (!syncedModels.delete(uri)) return
  lspNotify('textDocument/didClose', { textDocument: { uri } })
}

function syncAllModels(): void {
  for (const model of monaco.editor.getModels()) attachModel(model)
}

// ==================== Provider 注册 ====================

let providersDisposed: monaco.IDisposable[] = []

function docSelector(): monaco.languages.LanguageSelector {
  return [...LSP_LANGUAGES]
}

function registerProviders(): void {
  disposeProviders()
  const selector = docSelector()

  providersDisposed.push(
    monaco.languages.registerHoverProvider(selector, {
      async provideHover(model, position) {
        const result = await lspRequest<{
          contents?: { kind?: string; value?: string } | Array<{ value?: string } | string>
          range?: LspRange
        } | null>('textDocument/hover', {
          textDocument: { uri: model.uri.toString() },
          position: { line: position.lineNumber - 1, character: position.column - 1 }
        }).catch(() => null)
        if (!result || !result.contents) return null
        const value = Array.isArray(result.contents)
          ? result.contents
              .map((c) => (typeof c === 'string' ? c : (c.value ?? '')))
              .filter(Boolean)
              .join('\n\n')
          : (result.contents.value ?? '')
        if (!value) return null
        return {
          range: result.range ? toMonacoRange(result.range) : undefined,
          contents: [{ value }]
        }
      }
    })
  )

  providersDisposed.push(
    monaco.languages.registerDefinitionProvider(selector, {
      async provideDefinition(model, position) {
        const result = await lspRequest<
          | { uri: string; range: LspRange }
          | Array<{ uri: string; range: LspRange }>
          | Array<{ targetUri: string; targetRange: LspRange }>
          | null
        >('textDocument/definition', {
          textDocument: { uri: model.uri.toString() },
          position: { line: position.lineNumber - 1, character: position.column - 1 }
        }).catch(() => null)
        if (!result) return null
        const locations = Array.isArray(result) ? result : [result]
        return locations.map((loc) => {
          // LocationLink 形式带 targetUri/targetRange，Location 形式带 uri/range
          const uri = 'targetUri' in loc ? loc.targetUri : loc.uri
          const range = 'targetRange' in loc ? loc.targetRange : loc.range
          return { uri: monaco.Uri.parse(uri), range: toMonacoRange(range) }
        })
      }
    })
  )

  providersDisposed.push(
    monaco.languages.registerReferenceProvider(selector, {
      async provideReferences(model, position, context) {
        const result = await lspRequest<Array<{ uri: string; range: LspRange }> | null>(
          'textDocument/references',
          {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            context: { includeDeclaration: context.includeDeclaration }
          }
        ).catch(() => null)
        if (!result) return null
        return result.map((loc) => ({
          uri: monaco.Uri.parse(loc.uri),
          range: toMonacoRange(loc.range)
        }))
      }
    })
  )

  providersDisposed.push(
    monaco.languages.registerCompletionItemProvider(selector, {
      triggerCharacters: ['.', '"', "'", '/', '@', '<'],
      async provideCompletionItems(model, position) {
        const result = await lspRequest<
          | { items?: Array<Record<string, unknown>> }
          | Array<Record<string, unknown>>
          | null
        >('textDocument/completion', {
          textDocument: { uri: model.uri.toString() },
          position: { line: position.lineNumber - 1, character: position.column - 1 }
        }).catch(() => null)
        const items = Array.isArray(result) ? result : (result?.items ?? [])
        const word = model.getWordUntilPosition(position)
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        }
        const suggestions = items.map((item) => mapCompletionItem(item, range))
        const listResult = result as { isIncomplete?: boolean } | null
        return { suggestions, incomplete: !Array.isArray(result) && Boolean(listResult?.isIncomplete) }
      }
    })
  )
}

function mapCompletionItem(
  item: Record<string, unknown>,
  range: monaco.IRange
): monaco.languages.CompletionItem {
  const kindMap: Record<number, monaco.languages.CompletionItemKind> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    21: monaco.languages.CompletionItemKind.Constant,
    25: monaco.languages.CompletionItemKind.Keyword
  }
  return {
    label: String(item.label ?? ''),
    kind: kindMap[Number(item.kind)] ?? monaco.languages.CompletionItemKind.Text,
    detail: typeof item.detail === 'string' ? item.detail : undefined,
    documentation: undefined,
    insertText: String(item.insertText ?? item.label ?? ''),
    range,
    sortText: typeof item.sortText === 'string' ? item.sortText : undefined,
    filterText: typeof item.filterText === 'string' ? item.filterText : undefined
  }
}

function disposeProviders(): void {
  for (const disposable of providersDisposed) disposable.dispose()
  providersDisposed = []
}

// ==================== 生命周期 ====================

let running = false
/** 当前服务器绑定的工作区根；换根要停旧起新 */
let activeRoot: string | null = null

/**
 * 启动语言服务并就绪。重复调用同根是幂等；换根会先停旧的再启动。
 *
 * 成功：关内置 worker、注册 LSP provider、同步全部已打开 model。
 * 失败：恢复内置 worker 兜底（比没有任何诊断强）。
 */
export async function startTsLsp(rootPath: string, serverEntry: string): Promise<boolean> {
  if (running && activeRoot === rootPath) return true
  if (running) await stopTsLsp()

  const rootUri = monaco.Uri.file(rootPath).toString()
  const started = await window.aether.lsp.start({ rootUri, serverEntry })
  if (!started.ok) {
    setBuiltinTsFeatures(false)
    return false
  }

  // 接消息：先挂监听器再 initialize，避免漏掉早期通知
  disposeMessageListener = window.aether.lsp.onMessage(handleMessage)
  disposeExitListener = window.aether.lsp.onExit(() => {
    running = false
    disposeProviders()
    setBuiltinTsFeatures(false) // 服务器挂了：恢复内置兜底
    syncedModels.clear()
  })

  try {
    await lspRequest('initialize', {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [1, 2] },
            codeDescriptionSupport: true
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: false } },
          definition: { linkSupport: true }
        }
      },
      workspaceFolders: [{ uri: rootUri, name: rootPath.split(/[\\/]/).pop() ?? rootPath }]
    })
    lspNotify('initialized', {})
  } catch {
    running = false
    setBuiltinTsFeatures(false)
    return false
  }

  running = true
  activeRoot = rootPath
  setBuiltinTsFeatures(true)
  registerProviders()
  syncAllModels()

  // 新打开的 model 也要同步；关闭的要 didClose
  monaco.editor.onDidCreateModel((model) => {
    if (running) attachModel(model)
  })
  monaco.editor.onWillDisposeModel((model) => {
    if (running) detachModel(model)
  })

  return true
}

/** 停止语言服务并恢复内置 worker */
export async function stopTsLsp(): Promise<void> {
  if (!running) return
  running = false
  activeRoot = null
  try {
    await lspRequest('shutdown').catch(() => undefined)
    lspNotify('exit')
  } finally {
    await window.aether.lsp.stop()
    disposeMessageListener?.()
    disposeExitListener?.()
    disposeMessageListener = null
    disposeExitListener = null
    disposeProviders()
    syncedModels.clear()
    setBuiltinTsFeatures(false)
  }
}

/** 是否有 LSP 在跑（决定是否信任其诊断） */
export function isTsLspRunning(): boolean {
  return running
}
