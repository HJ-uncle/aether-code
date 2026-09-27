/**
 * 资源管理器的文件操作
 *
 * 从视图里抽出来的理由：一次「重命名」不只是调一次 fs，还要同步三处状态 ——
 * 磁盘、已打开的文档（否则标签会指向旧路径）、以及当前激活标签。
 * 漏掉任何一处都会留下"标签打不开"或"保存到已删除文件"这类难查的问题，
 * 因此把这些联动放在一处、由视图只负责收集用户输入与展示错误。
 *
 * 撤销栈同理放在这里：可逆操作必须知道自己的逆操作，而逆操作要动到的正是
 * 上面这些状态，散在视图里必然漏同步。
 */
import { closeFile, getEditorState, renameDocument } from '../editor/editor-store'
import { setContextKey } from '../platform/context-keys'
import { getLayout, setLayout } from '../platform/layout-state'
import { createFile, createFolder, paths, rename, trash } from './fs-client'
import {
  expandDirectory,
  getSelection,
  getWorkspaceState,
  onWorkspaceChanged,
  refreshDirectory,
  setSelection
} from './workspace-store'

/**
 * 名称合法性校验：返回错误文案，合法返回 null。
 *
 * 刻意不允许带路径分隔符：允许 "a/b" 会悄悄多建一层目录，
 * 用户输入出错时很难意识到自己建在了哪里。要分层就分两次建。
 */
export function validateEntryName(name: string): string | null {
  if (!name) return '名称不能为空'
  if (/[\\/]/.test(name)) return '名称不能包含路径分隔符（/ 或 \\）'
  if (name === '.' || name === '..') return '名称不合法'
  // Windows 保留字符：这些名字在 Windows 上根本无法创建
  if (/[<>:"|?*]/.test(name)) return '名称不能包含 < > : " | ? * 这些字符'
  return null
}

// ==================== 撤销栈 ====================

/** 一个可撤销的操作：label 用于菜单文案（如「撤销 新建 a.txt」） */
interface UndoEntry {
  label: string
  revert: () => Promise<void>
}

/** 栈上限：文件操作是低频行为，留太多只会让"撤销"点到很久以前的操作上 */
const MAX_UNDO = 50

let undoStack: UndoEntry[] = []
const undoListeners = new Set<() => void>()

function notifyUndoChanged(): void {
  for (const listener of undoListeners) listener()
}

function pushUndo(entry: UndoEntry): void {
  undoStack = [...undoStack, entry].slice(-MAX_UNDO)
  notifyUndoChanged()
}

/**
 * 清空撤销历史。
 *
 * 删除（进系统回收站）之后必须调用：恢复回收站内容需要平台私有接口，
 * 我们做不到，所以不能让用户跨过这次删除去撤销更早的操作 —— 那会出现
 * 「把一个刚被删掉的目录里的文件重命名回去」这类难以理解的结果。
 */
function clearUndo(): void {
  if (undoStack.length === 0) return
  undoStack = []
  notifyUndoChanged()
}

export function onUndoStackChanged(listener: () => void): () => void {
  undoListeners.add(listener)
  return () => undoListeners.delete(listener)
}

/**
 * 把「是否有可撤销的操作」同步到上下文键。
 *
 * 放在这里而不是视图里：Ctrl+Z 是全局键位，而资源管理器随时可能被切换掉，
 * 视图卸载后上下文键必须仍然正确，否则快捷键会对着一个空栈反复触发。
 */
onUndoStackChanged(() => {
  setContextKey('fileOpUndoable', undoStack.length > 0)
})

/** 栈顶操作的描述；无可撤销时返回 null（供菜单文案与禁用态） */
export function peekUndoLabel(): string | null {
  return undoStack.length > 0 ? undoStack[undoStack.length - 1].label : null
}

/**
 * 撤销最近一次操作；无可撤销时返回 false。
 * 撤销失败说明磁盘状态已与栈不一致，把条目放回栈让用户看到错误并可重试。
 */
export async function undoLastFileOp(): Promise<boolean> {
  const entry = undoStack[undoStack.length - 1]
  if (!entry) return false

  undoStack = undoStack.slice(0, -1)
  notifyUndoChanged()

  try {
    await entry.revert()
  } catch (err) {
    undoStack = [...undoStack, entry]
    notifyUndoChanged()
    throw err
  }

  return true
}

// ==================== 路径工具 ====================

/**
 * 路径归一化用于比较。
 *
 * 主进程给回的是 Windows 反斜杠，而 paths.join 拼出来的是正斜杠，
 * 直接 === 永远不相等 —— 会导致"改名成同一个名字"被判成需要移动。
 */
function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b)
}

/**
 * 目录刷新后清掉选区里已不存在的路径。
 *
 * 删除、移动、外部改动都会让选中项消失；若不清，选区会一直留着幽灵路径，
 * 之后拖拽或删除时又会对一个不存在的目标报错（错误来自主进程，用户看不出原因）。
 * 判断依据是「父目录已加载但列表里没有它」——父目录未加载说明只是没看到，
 * 不能当成不存在。
 */
onWorkspaceChanged(() => {
  const selection = getSelection()
  if (selection.size === 0) return

  const { children } = getWorkspaceState()
  const alive = new Set<string>()

  for (const path of selection) {
    const parent = paths.dirname(path)
    const siblings = children.get(parent)
    if (!siblings) {
      alive.add(path)
      continue
    }
    if (siblings.some((entry) => samePath(entry.path, path))) alive.add(path)
  }

  if (alive.size !== selection.size) setSelection(alive)
})

// ==================== 基本操作 ====================

export async function createFileIn(dirPath: string, name: string): Promise<void> {
  const target = paths.join(dirPath, name)
  await createFile(target)
  await refreshDirectory(dirPath)

  // 撤销"新建"用回收站而不是直接 unlink：新建的文件可能已经被写了内容并保存，
  // 永久删除会真的丢数据
  pushUndo({ label: `新建 ${name}`, revert: () => removeEntry(target, dirPath) })
}

export async function createFolderIn(dirPath: string, name: string): Promise<void> {
  const target = paths.join(dirPath, name)
  await createFolder(target)
  await refreshDirectory(dirPath)
  pushUndo({ label: `新建 ${name}`, revert: () => removeEntry(target, dirPath) })
}

/**
 * 重命名 / 移动（同目录改名）。
 * 返回新路径，方便调用方继续操作（例如打开改名后的文件）。
 */
export async function renameEntry(targetPath: string, nextName: string): Promise<string> {
  const parent = paths.dirname(targetPath)
  const destPath = paths.join(parent, nextName)
  if (samePath(destPath, targetPath)) return targetPath

  await rename(targetPath, destPath)
  await refreshDirectory(parent)
  syncDocumentsAfterRename(targetPath, destPath)

  pushUndo({
    label: `重命名 ${paths.basename(targetPath)}`,
    revert: async () => {
      await rename(destPath, targetPath)
      await refreshDirectory(parent)
      syncDocumentsAfterRename(destPath, targetPath)
    }
  })

  return destPath
}

/**
 * 把若干条目移入目标目录（拖拽落点）。
 * 返回实际移动的数量：0 表示不需要移动（例如本来就在该目录里）。
 */
export async function moveEntries(sourcePaths: string[], targetDir: string): Promise<number> {
  const moves = planMoves(sourcePaths, targetDir)
  if (moves.length === 0) return 0

  for (const move of moves) {
    await rename(move.from, move.to)
    syncDocumentsAfterRename(move.from, move.to)
  }
  await refreshAfterMove(moves, targetDir)

  pushUndo({
    label: `移动 ${moves.length} 项`,
    revert: async () => {
      for (const move of moves) {
        await rename(move.to, move.from)
        syncDocumentsAfterRename(move.to, move.from)
      }
      await refreshAfterMove(moves, targetDir)
    }
  })

  return moves.length
}

/**
 * 移入系统回收站，并关闭指向它的所有标签。
 *
 * 批量删除时逐个执行并收集首个错误：中途失败不该让其余条目留在原地而不刷新
 * —— 那样界面显示的是一份已经不存在于磁盘的目录树。
 */
export async function trashEntries(targetPaths: string[]): Promise<void> {
  let firstError: unknown = null

  for (const target of targetPaths) {
    try {
      await trash(target)
      closeDocumentsInside(target)
    } catch (err) {
      if (firstError === null) firstError = err
    }
  }

  for (const dir of new Set(targetPaths.map((item) => paths.dirname(item)))) {
    await refreshDirectory(dir)
  }

  clearUndo()

  if (firstError !== null) throw firstError
}

// ==================== 内部实现 ====================

/** 移入回收站并同步视图状态（"新建"的逆操作） */
async function removeEntry(targetPath: string, parentDir: string): Promise<void> {
  await trash(targetPath)
  await refreshDirectory(parentDir)
  closeDocumentsInside(targetPath)
}

/** 计算实际要执行的移动，剔除三类无意义请求 */
function planMoves(sourcePaths: string[], targetDir: string): { from: string; to: string }[] {
  const unique = [...new Set(sourcePaths)]

  // 选区里同时有目录和它的子项时只搬目录：父目录已经搬走，再单独搬子项必然失败
  const roots = unique.filter(
    (candidate) => !unique.some((other) => other !== candidate && paths.contains(other, candidate))
  )

  const moves: { from: string; to: string }[] = []
  for (const source of roots) {
    // 目标在源内部：等于把自己搬进自己
    if (paths.contains(source, targetDir)) continue
    // 已经在目标目录里，不需要移动（否则会撞上"目标已存在"）
    if (samePath(paths.dirname(source), targetDir)) continue
    moves.push({ from: source, to: paths.join(targetDir, paths.basename(source)) })
  }

  return moves
}

/** 移动后刷新源目录（可能多个）并展开目标目录，让用户看得见结果 */
async function refreshAfterMove(
  moves: { from: string; to: string }[],
  targetDir: string
): Promise<void> {
  for (const dir of new Set(moves.map((move) => paths.dirname(move.from)))) {
    await refreshDirectory(dir)
  }
  await expandDirectory(targetDir)
}

/** 把受影响的已打开文档改到新路径（目录重命名时其下所有文档都要改） */
function syncDocumentsAfterRename(oldPath: string, newPath: string): void {
  const activeKey = getLayout().activeEditorView

  for (const doc of [...getEditorState().docs.values()]) {
    if (!paths.contains(oldPath, doc.path)) continue

    const relocated = `${newPath}${doc.path.slice(oldPath.length)}`
    renameDocument(doc.path, relocated)

    // 激活标签跟着走，否则重命名后当前标签会立刻变成"文件已关闭"
    if (activeKey === `doc:${doc.path}`) {
      setLayout({ activeEditorView: `doc:${relocated}` })
    }
  }
}

/** 关闭位于目标路径之内的所有标签；若当前激活标签在其中则切回对话 */
function closeDocumentsInside(targetPath: string): void {
  const activeKey = getLayout().activeEditorView
  let activeWasClosed = false

  for (const doc of [...getEditorState().docs.values()]) {
    if (!paths.contains(targetPath, doc.path)) continue

    if (activeKey === `doc:${doc.path}`) activeWasClosed = true
    closeFile(doc.path)
  }

  if (activeWasClosed) setLayout({ activeEditorView: 'chat' })
}
