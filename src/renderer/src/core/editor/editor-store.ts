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
}

let state: EditorState = { docs: new Map(), order: [], saving: new Set(), reveals: {} }

let revealSeq = 0

const listeners = new Set<() => void>()

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
  return `doc:${filePath}`
}

export function isDirty(doc: OpenDocument): boolean {
  return !doc.isBinary && doc.content !== doc.savedContent
}

export function getDocument(filePath: string): OpenDocument | undefined {
  return state.docs.get(filePath)
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
  if (state.docs.has(filePath)) {
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
  }

  const nextDocs = new Map(state.docs)
  nextDocs.set(filePath, placeholder)
  setState({ docs: nextDocs, order: [...state.order, filePath] })

  try {
    const file = await readFile(filePath)
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
      error: null
    }
    const withLoaded = new Map(state.docs)
    withLoaded.set(filePath, loaded)
    setState({ docs: withLoaded })
    rememberRecent(filePath) // 成功打开即记入「最近打开」（快速打开 MRU 数据源）
    requestReveal(filePath, line, column, length)
  } catch (err) {
    const failed: OpenDocument = { ...placeholder, loading: false, error: ipcErrorMessage(err) }
    const withError = new Map(state.docs)
    withError.set(filePath, failed)
    setState({ docs: withError })
  }
}

/** 关闭文件；有未保存改动时由调用方先确认 */
export function closeFile(filePath: string): void {
  clearDocumentDiagnostics(filePath)
  const nextDocs = new Map(state.docs)
  nextDocs.delete(filePath)
  setState({
    docs: nextDocs,
    order: state.order.filter((item) => item !== filePath)
  })
}

/** 更新内容（编辑器输入时调用） */
export function setDocumentContent(filePath: string, content: string): void {
  const doc = state.docs.get(filePath)
  if (!doc || doc.isBinary) return
  if (doc.content === content) return

  const nextDocs = new Map(state.docs)
  nextDocs.set(filePath, { ...doc, content })
  setState({ docs: nextDocs })
}

/** 保存到磁盘 */
export async function saveDocument(filePath: string): Promise<void> {
  const doc = state.docs.get(filePath)
  if (!doc || doc.isBinary || doc.loading) return

  setState({ saving: new Set(state.saving).add(filePath) })

  try {
    await writeFile(filePath, doc.content)
    // 以「已写入的内容」而非当前编辑器内容为准：
    // 保存期间用户可能继续输入，那部分应保持为未保存状态
    const latest = state.docs.get(filePath)
    const nextDocs = new Map(state.docs)
    if (latest) nextDocs.set(filePath, { ...latest, savedContent: doc.content, error: null })
    const nextSaving = new Set(state.saving)
    nextSaving.delete(filePath)
    setState({ docs: nextDocs, saving: nextSaving })
    // 落盘成功意味着 git 工作区可能变了，自动刷新状态栏/版本控制视图
    void refreshGit(getWorkspaceState().root)
    // 保存后跑引擎诊断（失败静默，不影响保存流程），结果进 Problems 面板与编辑器波浪线
    void diagnoseDocument(filePath, doc.content)
  } catch (err) {
    const latest = state.docs.get(filePath)
    const nextDocs = new Map(state.docs)
    if (latest) nextDocs.set(filePath, { ...latest, error: ipcErrorMessage(err) })
    const nextSaving = new Set(state.saving)
    nextSaving.delete(filePath)
    setState({ docs: nextDocs, saving: nextSaving })
  }
}

/** 保存当前激活的文档 */
export async function saveActiveDocument(): Promise<void> {
  for (const doc of state.docs.values()) {
    if (isDirty(doc)) {
      await saveDocument(doc.path)
      return
    }
  }
}

/**
 * 从磁盘重载已打开的文档（全局替换后调用）。
 * 有未保存修改的文档跳过 —— 不能拿磁盘内容盖掉用户正在编辑的内容。
 */
export async function reloadDocuments(filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    const doc = state.docs.get(filePath)
    if (!doc || doc.isBinary || doc.loading || isDirty(doc)) continue
    try {
      const file = await readFile(filePath)
      const latest = state.docs.get(filePath)
      if (!latest) continue
      const nextDocs = new Map(state.docs)
      nextDocs.set(filePath, {
        ...latest,
        content: file.content,
        savedContent: file.content,
        truncated: file.truncated,
        size: file.size
      })
      setState({ docs: nextDocs })
    } catch {
      // 文件可能已被删除：保持内存内容不动，等用户保存时自行暴露冲突
    }
  }
}

/** 文件名变化后（重命名）同步内存中的路径 */
export function renameDocument(oldPath: string, newPath: string): void {
  const doc = state.docs.get(oldPath)
  if (!doc) return

  // 旧路径的诊断结果随路径失效，直接清掉；下次保存会自动重新诊断
  clearDocumentDiagnostics(oldPath)

  const nextDocs = new Map(state.docs)
  nextDocs.delete(oldPath)
  nextDocs.set(newPath, { ...doc, path: newPath, name: paths.basename(newPath) })

  setState({
    docs: nextDocs,
    order: state.order.map((item) => (item === oldPath ? newPath : item))
  })
}

/** 订阅编辑器状态（store 内部整体替换 state，引用稳定可作快照） */
export function useEditor(): EditorState {
  return useSyncExternalStore(onEditorChanged, getEditorState)
}
