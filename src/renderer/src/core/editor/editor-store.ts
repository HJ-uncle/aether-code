/**
 * 编辑器文档状态
 *
 * 管理已打开的文件（多标签）。关键设计：
 *   - content 与 savedContent 分离，脏标记由两者比较得出，不额外维护 boolean
 *     （避免「保存后忘记复位」「撤销回原样仍显示脏」这类经典 bug）
 *   - 二进制文件不进入可编辑路径，只保留 base64 供预览使用
 *
 * 「哪个标签是激活的」由 layout-state 统一持有，本模块只负责文档本身。
 */
import { useSyncExternalStore } from 'react'
import { ipcErrorMessage } from '../ipc-error'
import { refreshGit } from '../git/git-store'
import { diagnoseDocument, clearDocumentDiagnostics } from '../lsp/diagnostics'
import { rememberRecent } from './recent-files'
import { paths, readFile, writeFile } from '../workspace/fs-client'
import { getWorkspaceState } from '../workspace/workspace-store'
import { activateDocument } from './editor-activation'
import { fileIdentity } from './file-identity'
import { getActiveEditor } from './active-editor'
import { workspaceConnectionKey } from '../workspace/connection'

export interface OpenDocument {
  path: string
  name: string
  content: string
  /** 最近一次与磁盘一致的内容，用于计算脏标记 */
  savedContent: string
  isBinary: boolean
  base64: string | null
  truncated: boolean
  /** 二进制文件超过预览上限（主进程未返回内容） */
  tooLarge: boolean
  /** 磁盘上的字节数（二进制预览与状态栏展示用） */
  size: number
  loading: boolean
  error: string | null
  externalChange?: 'modified' | 'deleted'
  diskContent?: string
  /** Connection/session identity that owns this document buffer. */
  workspaceKey: string
}

export interface EditorState {
  docs: Map<string, OpenDocument>
  /** 标签顺序（文件绝对路径） */
  order: string[]
  saving: Set<string>
  /**
   * 待执行的跳行请求：filePath → { 行号, 序号 }；seq 让同一文件多次跳转都能触发 effect。
   * column/length 来自全局搜索命中，用于选中并高亮匹配片段（缺省只定位行首）。
   */
  reveals: Record<string, { line: number; column?: number; length?: number; seq: number }>
  /** 目前激活的文件绝对路径；无文件标签时为 null（供非组件代码读「当前文件」） */
  activePath: string | null
  /**
   * 最近一次从 Monaco 读回的光标位置（1-based），状态栏/文档 footer 展示用。
   * 连同所属文件一起存：切标签时旧文件的位置读数必须作废，
   * 但「作废」只能靠「光标属于谁」来判断，不能靠切标签时机（见 setCursor）。
   */
  cursor: { filePath: string; line: number; column: number } | null
}

let state: EditorState = {
  docs: new Map(),
  order: [],
  saving: new Set(),
  reveals: {},
  activePath: null,
  cursor: null
}

let revealSeq = 0

export interface DocumentIdentity {
  readonly instance: number
  readonly revision: number
}
let nextDocumentInstance = 1
const documentIdentities = new Map<string, DocumentIdentity>()

/** 内容相同也可能是关闭后重新打开的新文档，异步回包不能只靠路径和字符串认领。 */
export function getDocumentIdentity(filePath: string): DocumentIdentity | undefined {
  return documentIdentities.get(resolveDocumentPath(filePath))
}

function sameDocument(filePath: string, expected: DocumentIdentity | undefined, includeRevision = true): boolean {
  const current = documentIdentities.get(filePath)
  return Boolean(expected && current?.instance === expected.instance && (!includeRevision || current.revision === expected.revision))
}

function markDocumentEdited(filePath: string): void {
  const identity = documentIdentities.get(filePath)
  if (identity) documentIdentities.set(filePath, { ...identity, revision: identity.revision + 1 })
}

/**
 * 光标/滚动位置的暂存区。
 *
 * 本来想靠「切换标签不重建编辑器实例、只换 model」自然保住视图状态，
 * 但那是错的：Monaco 的 viewState 属于**编辑器实例**而非 model，
 * 换 model 会把光标与滚动位置按新 model 重置。所以必须自己存取 ——
 * 见 MonacoEditor 的 onDidChangeModel 与「换 model 前后」两处。
 *
 * 不放进 EditorState：它不是渲染数据（没有任何组件订阅它），
 * 放进去会让每次光标移动都触发全量重渲染。也不随文件关闭删除：
 * 关闭再打开应当回到原位（与 VS Code 一致），上限兜内存。
 */
const viewStates = new Map<string, unknown>()
const VIEW_STATE_LIMIT = 50

/**
 * 已关闭的文件栈（VS Code 的「重新打开已关闭的编辑器」）。
 * 只记文件不记固定视图 —— 固定视图走 closedEditorViews，两者语义不同。
 */
const closedFiles: string[] = []
const CLOSED_FILES_LIMIT = 20

export function rememberViewState(filePath: string, viewState: unknown): void {
  filePath = resolveDocumentPath(filePath)
  if (viewState == null) return
  // 重新插入让它成为「最近使用」，淘汰最旧的一条
  viewStates.delete(filePath)
  viewStates.set(filePath, viewState)
  if (viewStates.size > VIEW_STATE_LIMIT) {
    const oldest = viewStates.keys().next()
    if (!oldest.done) viewStates.delete(oldest.value)
  }
}

export function takeViewState(filePath: string): unknown {
  filePath = resolveDocumentPath(filePath)
  const viewState = viewStates.get(filePath)
  // 取出即消费：viewState 只该被「切回这个文件」的那一次恢复使用。
  // 留着不删，换个路径重建编辑器（组件 remount）时会拿旧状态覆盖掉
  // 用户刚建立的光标位置 —— 表现为「切走再切回，光标莫名跳到别处」
  if (viewState !== undefined) viewStates.delete(filePath)
  return viewState
}

/**
 * 激活文件变化（EditorArea 是唯一的调用方，它才知道哪个标签是激活的）。
 *
 * 刻意**不**在这里清空 cursor：清空看似把「旧文件的读数」抹掉了，但副作用
 * 更大 —— 本函数在父组件 EditorArea 的 effect 里跑，而 Monaco 换 model /
 * 恢复 viewState 并上报新位置是在子组件 MonacoEditor 的 effect 里跑的，
 * 子 effect 先于父 effect。于是「先上报新位置、再被清成 null」，
 * 光标读数会直接消失（且此后没有光标移动事件，永远不会再被填回来）。
 * 旧文件读数由 setCursor 按 filePath 归属自然作废，无需在这里动手。
 */
export function setActiveDocument(filePath: string | null): void {
  if (filePath !== null) filePath = resolveDocumentPath(filePath)
  if (state.activePath === filePath) return
  setState({ activePath: filePath })
}

/** 编辑器上报光标位置；同位置不触发广播，避免光标移动刷爆订阅者 */
export function setCursor(filePath: string, line: number, column: number): void {
  filePath = resolveDocumentPath(filePath)
  const current = state.cursor
  if (
    current &&
    current.filePath === filePath &&
    current.line === line &&
    current.column === column
  ) {
    return
  }
  setState({ cursor: { filePath, line, column } })
}

const listeners = new Set<() => void>()
const renameListeners = new Set<(oldPath: string, newPath: string) => void>()

export function onDocumentRenamed(listener: (oldPath: string, newPath: string) => void): () => void {
  renameListeners.add(listener)
  return () => renameListeners.delete(listener)
}

function setState(patch: Partial<EditorState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function getEditorState(): EditorState {
  return state
}

export function onEditorChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 标签键：与静态视图 ID（chat / models）区分开 */
export function documentKey(filePath: string): string {
  return `doc:${resolveDocumentPath(filePath)}`
}

/** Reuse the first document's path, buffer and saved baseline for filesystem aliases. */
export function resolveDocumentPath(filePath: string): string {
  if (state.docs.has(filePath)) return filePath
  const identity = fileIdentity(filePath)
  return [...state.docs.keys()].find((path) => fileIdentity(path) === identity) ?? filePath
}

export function isDirty(doc: OpenDocument): boolean {
  return !doc.isBinary && doc.content !== doc.savedContent
}

export function getDocument(filePath: string): OpenDocument | undefined {
  return state.docs.get(resolveDocumentPath(filePath))
}

/** 登记跳行请求（全局搜索点击结果时用）；行号非法则忽略 */
function requestReveal(filePath: string, line?: number, column?: number, length?: number): void {
  if (!line || line < 1) return
  revealSeq += 1
  setState({
    reveals: {
      ...state.reveals,
      [filePath]: { line, column, length, seq: revealSeq }
    }
  })
}

/** 打开文件（已打开则直接复用，不重复读盘）；line/column 用于打开后定位到匹配片段 */
export async function openFile(
  filePath: string,
  line?: number,
  column?: number,
  length?: number
): Promise<void> {
  filePath = resolveDocumentPath(filePath)
  if (state.docs.has(filePath)) {
    if (state.docs.get(filePath)?.workspaceKey !== workspaceConnectionKey()) {
      throw new Error('工作区连接或会话已经切换，请关闭旧文档后重新打开。')
    }
    requestReveal(filePath, line, column, length)
    return
  }

  const placeholder: OpenDocument = {
    path: filePath,
    name: paths.basename(filePath),
    content: '',
    savedContent: '',
    isBinary: false,
    base64: null,
    truncated: false,
    tooLarge: false,
    size: 0,
    loading: true,
    error: null
    ,workspaceKey: workspaceConnectionKey()
  }

  const nextDocs = new Map(state.docs)
  nextDocs.set(filePath, placeholder)
  documentIdentities.set(filePath, { instance: nextDocumentInstance++, revision: 0 })
  setState({ docs: nextDocs, order: [...state.order, filePath] })

  try {
    const file = await readFile(filePath)
    if (state.docs.get(filePath) !== placeholder) return
    if (placeholder.workspaceKey !== workspaceConnectionKey()) throw new Error('工作区连接或会话已切换，已取消打开')
    const loaded: OpenDocument = {
      // 保持调用方传入的路径：docs/order 的 key 都是它。
      // 主进程返回的 path 经 resolve 规范化，分隔符可能与调用方不一致，
      // 若用它做 doc.path，reveals 等按路径索引的状态会对不上号
      path: filePath,
      name: paths.basename(filePath),
      content: file.content,
      savedContent: file.content,
      isBinary: file.isBinary,
      base64: file.base64 ?? null,
      truncated: file.truncated,
      tooLarge: Boolean(file.tooLarge),
      size: file.size,
      loading: false,
      error: null,
      workspaceKey: placeholder.workspaceKey
    }
    const withLoaded = new Map(state.docs)
    withLoaded.set(filePath, loaded)
    setState({ docs: withLoaded })
    rememberRecent(filePath) // 成功打开即记入「最近打开」（快速打开 MRU 数据源）
    requestReveal(filePath, line, column, length)
  } catch (err) {
    if (state.docs.get(filePath) !== placeholder) return
    const failed: OpenDocument = { ...placeholder, loading: false, error: ipcErrorMessage(err) }
    const withError = new Map(state.docs)
    withError.set(filePath, failed)
    setState({ docs: withError })
  }
}

/** 关闭文件；有未保存改动时由调用方先确认 */
export function closeFile(filePath: string): void {
  filePath = resolveDocumentPath(filePath)
  documentIdentities.delete(filePath)
  clearDocumentDiagnostics(filePath)
  const nextDocs = new Map(state.docs)
  nextDocs.delete(filePath)
  setState({
    docs: nextDocs,
    order: state.order.filter((item) => item !== filePath)
  })
  // 关闭过的文件进「重新打开」栈，且必须是最近的栈顶：
  // 同一个文件可能被关了又开、再关 —— 若因为旧记录还在栈里就跳过，
  // 栈顶会停在一个更早关闭的别的文件上，Ctrl+Shift+T 就会捞错东西。
  const existing = closedFiles.indexOf(filePath)
  if (existing >= 0) closedFiles.splice(existing, 1)
  closedFiles.push(filePath)
  if (closedFiles.length > CLOSED_FILES_LIMIT) closedFiles.shift()
}

/**
 * 重新打开最近关闭的文件。
 *
 * 弹出栈顶时跳过已经打开的文件 —— 否则「关闭 A、又手动开回 A、再重开」
 * 会变成一个看似无响应的操作（因为 A 本来就开着）。
 * 返回是否真的打开了某个文件，供调用方决定要不要提示。
 */
export async function reopenLastClosedFile(): Promise<boolean> {
  while (closedFiles.length > 0) {
    const filePath = closedFiles.pop()
    if (filePath && !getDocument(filePath)) {
      await openFile(filePath)
      // 重开的文件要切到前台：VS Code 的 Ctrl+Shift+T 会把它激活。
      // 只打开不激活的话它只是后台标签，文档槽不会渲染 Monaco，
      // 上次的光标位置也就无从恢复。
      activateDocument(filePath)
      return true
    }
  }
  return false
}

/** 更新内容（编辑器输入时调用） */
export function setDocumentContent(filePath: string, content: string): void {
  filePath = resolveDocumentPath(filePath)
  const doc = state.docs.get(filePath)
  if (!doc || doc.isBinary) return
  if (doc.content === content) return

  const nextDocs = new Map(state.docs)
  nextDocs.set(filePath, { ...doc, content })
  markDocumentEdited(filePath)
  setState({ docs: nextDocs })
}

/** 保存到磁盘 */
const saveQueues = new Map<string, Promise<void>>()

export function saveDocument(filePath: string): Promise<void> {
  filePath = resolveDocumentPath(filePath)
  const identity = getDocumentIdentity(filePath)
  if (!identity) return Promise.resolve()
  const previous = saveQueues.get(filePath) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(() => saveDocumentNow(filePath, identity))
  saveQueues.set(filePath, operation)
  void operation.finally(() => {
    if (saveQueues.get(filePath) === operation) saveQueues.delete(filePath)
  }).catch(() => undefined)
  return operation
}

async function saveDocumentNow(filePath: string, identity: DocumentIdentity | undefined): Promise<void> {
  if (identity && !sameDocument(filePath, identity, false)) throw new Error('文件已关闭或路径已更改，本次保存已取消。')
  const doc = state.docs.get(filePath)
  if (!doc || doc.isBinary || doc.loading) return
  if (doc.workspaceKey !== workspaceConnectionKey()) throw new Error('工作区连接或会话已经切换，本次保存已取消。')
  if (doc.truncated) throw new Error('当前只载入文件的部分内容，已阻止覆盖保存。请使用完整文件编辑器处理。')

  setState({ saving: new Set(state.saving).add(filePath) })

  try {
    // Another workbench or the AI may have edited this file since it was opened.
    // Preserve the user's buffer instead of silently overwriting newer disk contents.
    const disk = await readFile(filePath)
    if (!sameDocument(filePath, identity, false) || doc.workspaceKey !== workspaceConnectionKey()) throw new Error('工作区连接或会话已经切换，本次保存已取消。')
    if (disk.truncated || disk.isBinary || (disk.content !== doc.savedContent && disk.content !== doc.content)) {
      throw new Error('文件已在其他编辑器或工具中修改，未覆盖磁盘内容。请先保留当前修改并重新加载文件。')
    }
    await writeFile(filePath, doc.content)
    // 以「已写入的内容」而非当前编辑器内容为准：
    // 保存期间用户可能继续输入，那部分应保持为未保存状态
    const latest = sameDocument(filePath, identity, false) ? state.docs.get(filePath) : undefined
    const nextDocs = new Map(state.docs)
    if (latest) nextDocs.set(filePath, { ...latest, savedContent: doc.content, error: null, externalChange: undefined, diskContent: undefined })
    const nextSaving = new Set(state.saving)
    nextSaving.delete(filePath)
    setState({ docs: nextDocs, saving: nextSaving })
    // 落盘成功意味着 git 工作区可能变了，自动刷新状态栏/版本控制视图
    void refreshGit(getWorkspaceState().root)
    // 保存后跑引擎诊断（失败静默，不影响保存流程），结果进 Problems 面板与编辑器波浪线
    if (latest) void diagnoseDocument(filePath, doc.content)
  } catch (err) {
    const latest = sameDocument(filePath, identity, false) ? state.docs.get(filePath) : undefined
    const nextDocs = new Map(state.docs)
    if (latest) nextDocs.set(filePath, { ...latest, error: ipcErrorMessage(err) })
    const nextSaving = new Set(state.saving)
    nextSaving.delete(filePath)
    setState({ docs: nextDocs, saving: nextSaving })
    throw err
  }
}

/** 保存当前激活的文档 */
export async function saveActiveDocument(): Promise<void> {
  const model = getActiveEditor()?.getModel()
  const active = model
    ? model.uri.scheme === 'file' ? getDocument(model.uri.fsPath) : undefined
    : state.activePath ? state.docs.get(state.activePath) : undefined
  if (active && isDirty(active)) {
    await saveDocument(active.path)
    return
  }
  // 没有活动文档或当前文档已保存时，不应写入另一组无关的未保存文件。
}

/**
 * 保存全部脏文档。
 *
 * 逐个 await 而非 Promise.all：写盘要经过主进程，并发写同一目录下的多个文件
 * 在 Windows 上更容易撞上瞬时占用；顺序写慢一点但结果可预期。
 * 有文档写失败时不中断后面的 —— 用户要的是「能存的都存了」，
 * 失败的文档已在自身状态里带 error，会照常显示。
 */
export async function saveAllDocuments(): Promise<void> {
  for (const doc of [...state.docs.values()]) {
    if (isDirty(doc)) {
      try { await saveDocument(doc.path) } catch { /* The document retains its buffer and visible error. */ }
    }
  }
}

/**
 * 从磁盘重载已打开的文档（全局替换后调用）。
 * 有未保存修改的文档跳过 —— 不能拿磁盘内容盖掉用户正在编辑的内容。
 */
export async function reloadDocuments(filePaths: string[]): Promise<void> {
  for (const requestedPath of filePaths) {
    const filePath = resolveDocumentPath(requestedPath)
    const doc = state.docs.get(filePath)
    if (!doc || doc.isBinary || doc.loading || state.saving.has(filePath) || doc.workspaceKey !== workspaceConnectionKey()) continue
    const identity = getDocumentIdentity(filePath)
    try {
      const file = await readFile(filePath)
      const latest = state.docs.get(filePath)
      if (!latest || !sameDocument(filePath, identity) || latest.content !== doc.content || latest.savedContent !== doc.savedContent || state.saving.has(filePath)) continue
      const nextDocs = new Map(state.docs)
      if (isDirty(latest) && file.content !== latest.content) {
        if (file.content === latest.savedContent && !file.isBinary && !file.truncated) {
          if (!latest.externalChange) continue
          nextDocs.set(filePath, { ...latest, externalChange: undefined, diskContent: undefined })
        } else {
          nextDocs.set(filePath, { ...latest, externalChange: 'modified', diskContent: file.isBinary || file.truncated ? undefined : file.content })
        }
        setState({ docs: nextDocs })
        continue
      }
      if (file.content === latest.content && file.content === latest.savedContent && !latest.externalChange && file.truncated === latest.truncated) continue
      nextDocs.set(filePath, {
        ...latest,
        content: file.content,
        savedContent: file.content,
        isBinary: file.isBinary,
        base64: file.base64 ?? null,
        tooLarge: Boolean(file.tooLarge),
        truncated: file.truncated,
        size: file.size,
        externalChange: undefined,
        diskContent: undefined,
        error: null
      })
      setState({ docs: nextDocs })
    } catch (error) {
      const latest = state.docs.get(filePath)
      if (!latest || !sameDocument(filePath, identity)) continue
      const missing = /ENOENT|不存在|no such file/i.test(ipcErrorMessage(error))
      const nextDocs = new Map(state.docs)
      nextDocs.set(filePath, { ...latest, ...(missing ? { externalChange: 'deleted' as const } : { error: ipcErrorMessage(error) }) })
      setState({ docs: nextDocs })
    }
  }
}

/** 用户明确选择磁盘版本后调用；读取期间出现新输入则拒绝覆盖。 */
export async function reloadDocumentFromDisk(filePath: string): Promise<void> {
  const doc = getDocument(filePath)
  if (!doc) return
  const identity = getDocumentIdentity(doc.path)
  if (state.saving.has(doc.path)) throw new Error('文件正在保存，请保存完成后重试。')
  const file = await readFile(doc.path)
  const latest = getDocument(doc.path)
  if (!latest || !sameDocument(doc.path, identity) || latest.content !== doc.content || latest.savedContent !== doc.savedContent || state.saving.has(doc.path)) throw new Error('读取期间文档已修改或重新打开，请重新选择要保留的版本。')
  const docs = new Map(state.docs)
  docs.set(doc.path, { ...latest, content: file.content, savedContent: file.content,
    isBinary: file.isBinary, base64: file.base64 ?? null, truncated: file.truncated,
    tooLarge: Boolean(file.tooLarge), size: file.size, externalChange: undefined, diskContent: undefined, error: null })
  markDocumentEdited(doc.path)
  setState({ docs })
}

/** 恢复草稿仍保留原磁盘基线；重启期间改盘时展示冲突而不是悄悄认领新版本。 */
export function restoreDocumentDraft(filePath: string, content: string, savedContent: string, expected: DocumentIdentity): void {
  const doc = getDocument(filePath)
  if (!doc || !sameDocument(doc.path, expected) || doc.isBinary || doc.truncated || doc.loading) return
  const diskContent = doc.content
  const missing = Boolean(doc.error && /ENOENT|不存在|no such file/i.test(doc.error))
  if (doc.error && !missing) return
  const docs = new Map(state.docs)
  docs.set(doc.path, { ...doc, content, savedContent, error: null,
    externalChange: missing ? 'deleted' : diskContent !== savedContent && diskContent !== content ? 'modified' : undefined,
    diskContent: !missing && diskContent !== savedContent ? diskContent : undefined })
  markDocumentEdited(doc.path)
  setState({ docs })
}

/** 文件名变化后（重命名）同步内存中的路径 */
export function renameDocument(oldPath: string, newPath: string): void {
  oldPath = resolveDocumentPath(oldPath)
  const doc = state.docs.get(oldPath)
  if (!doc) return

  // 旧路径的诊断结果随路径失效，直接清掉；下次保存会自动重新诊断
  clearDocumentDiagnostics(oldPath)

  const nextDocs = new Map(state.docs)
  nextDocs.delete(oldPath)
  nextDocs.set(newPath, { ...doc, path: newPath, name: paths.basename(newPath) })
  const identity = documentIdentities.get(oldPath)
  documentIdentities.delete(oldPath)
  if (identity) documentIdentities.set(newPath, identity)

  // 先迁移各视图的路径归属，再广播普通变更，避免左右组把重命名误当作删除后另开文件。
  state = { ...state,
    docs: nextDocs,
    order: state.order.map((item) => (item === oldPath ? newPath : item)),
    activePath: state.activePath === oldPath ? newPath : state.activePath,
    cursor: state.cursor?.filePath === oldPath ? { ...state.cursor, filePath: newPath } : state.cursor
  }
  for (const listener of renameListeners) listener(oldPath, newPath)
  for (const listener of listeners) listener()
}

/** 订阅编辑器状态（store 内部整体替换 state，引用稳定可作快照） */
export function useEditor(): EditorState {
  return useSyncExternalStore(onEditorChanged, getEditorState)
}
