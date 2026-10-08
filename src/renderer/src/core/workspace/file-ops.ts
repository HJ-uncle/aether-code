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
import { copy, createFile, createFolder, paths, rename, stat, trash } from './fs-client'
import {
  clearClipboard,
  expandDirectory,
  getClipboard,
  getSelection,
  getWorkspaceState,
  onWorkspaceChanged,
  removeEntriesFromWorkspace,
  refreshDirectory,
  setSelection,
  setSelectionAnchor
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
 * 把 paths 工具拼出来的路径（正斜杠）换成与工作区缓存一致的写法。
 *
 * 缓存键、selection、expanded 全部来自主进程的 readDir，在 Windows 上是
 * 反斜杠 + 盘符原始大小写；而 paths.join / paths.dirname 产出的永远是
 * 正斜杠。两者混用会让 Map.get / Set.has 静默落空（刷新被跳过、树上查不到
 * 行），且不报任何错。这里统一转成 root 的那套写法：
 *   - 分隔符：按 root 用 `\` 还是 `/`，整体替换
 *   - 盘符大小写：按 root 的盘符形态改写（Windows 上 `d:` 与 `D:` 是同一个盘）
 * root 为空（未打开工作区）时退回原值。
 */
export function toCacheKey(target: string): string {
  const root = getWorkspaceState().root
  if (!root) return target

  const rootUseBackslash = root.includes('\\')
  let result = rootUseBackslash ? target.replace(/\//g, '\\') : target.replace(/\\/g, '/')

  // 盘符大小写对齐：C:\ 与 c:\ 指向同一个位置，但作为 Map 键并不相等
  if (/^[a-zA-Z]:/.test(root) && /^[a-zA-Z]:/.test(result)) {
    result = root.slice(0, 1) + result.slice(1)
  }

  return result
}

/**
 * 取回 rename 之后主进程实际使用的真实路径。
 *
 * paths.join 产出的是正斜杠（如 `D:\ws/sub/a.txt`），主进程 resolve 后是
 * 反斜杠。工作区缓存、编辑器文档、撤销记录统一用反斜杠那一套，这里必须
 * 换成真实路径，否则同一次移动在后续各环节是「两个不同的文件」。
 * stat 失败（极少见）时退回原值，不因取路径而中断整个移动。
 */
async function canonicalizeRename(from: string, to: string): Promise<{ from: string; to: string }> {
  try {
    const info = await stat(to)
    return { from, to: info.path }
  } catch {
    return { from, to }
  }
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

  // 落盘后换回主进程的真实路径：destPath 是正斜杠，缓存 / 文档 / 撤销
  // 用的都是反斜杠那一套，返回正斜杠会让调用方拿着一个"查不到"的路径。
  const parentKey = toCacheKey(parent)
  await rename(targetPath, destPath)
  const actualDest = (await canonicalizeRename(targetPath, destPath)).to
  await refreshDirectory(parentKey)
  syncDocumentsAfterRename(targetPath, actualDest)

  pushUndo({
    label: `重命名 ${paths.basename(targetPath)}`,
    revert: async () => {
      await rename(actualDest, targetPath)
      await refreshDirectory(parentKey)
      syncDocumentsAfterRename(actualDest, targetPath)
    }
  })

  return actualDest
}

/**
 * 把若干条目移入目标目录（拖拽落点）。
 * 返回实际移动的数量：0 表示不需要移动（例如本来就在该目录里）。
 */
export async function moveEntries(sourcePaths: string[], targetDir: string): Promise<number> {
  const planned = planMoves(sourcePaths, targetDir)
  if (planned.length === 0) return 0

  // 落盘后拿到主进程规范化过的真实路径（Windows 上是反斜杠）。
  // planMoves 里 paths.join 产出的是正斜杠，直接用它做后续 refresh /
  // 文档同步 / 撤销，会出现同一文件两套写法，查表全部落空。
  const moves: { from: string; to: string }[] = []
  for (const move of planned) {
    await rename(move.from, move.to)
    const actual = await canonicalizeRename(move.from, move.to)
    moves.push(actual)
    syncDocumentsAfterRename(actual.from, actual.to)
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
      // Windows shell.trashItem may resolve before the source directory stops
      // reporting the item. Refresh only after the path disappears, otherwise
      // the just-deleted entry is read back into the explorer cache.
      await waitForPathGone(target)
      closeDocumentsInside(target)
    } catch (err) {
      if (firstError === null) firstError = err
    }
  }

  // 先更新树的内存快照，避免系统回收站的异步目录通知让旧行留在界面上。
  removeEntriesFromWorkspace(targetPaths)

  // paths.dirname 统一产出正斜杠，而 Windows 工作区缓存的 key 来自
  // readDir，使用的是反斜杠；不归一化会让 refreshDirectory 静默跳过，
  // 删除虽已落盘，树上却一直残留被删行。优先从当前缓存里找同路径的
  // 原始 key，兼容历史会话里混用分隔符的缓存。
  for (const rawDir of new Set(targetPaths.map((item) => paths.dirname(item)))) {
    const wanted = normalizeForCompare(rawDir)
    const cached = [...getWorkspaceState().children.keys()].find(
      (key) => normalizeForCompare(key) === wanted
    )
    await refreshDirectory(cached ?? toCacheKey(rawDir))
  }

  // A platform watcher or a slow recycle-bin move can finish between the
  // first in-memory removal and the directory read above. Apply the removal
  // once more so a stale read cannot resurrect a row the user just deleted.
  removeEntriesFromWorkspace(targetPaths)

  clearUndo()

  if (firstError !== null) throw firstError
}

async function waitForPathGone(target: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await stat(target)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * 把若干条目复制到目标目录（粘贴）。
 * 返回实际落盘的路径，调用方据此选中新副本。
 *
 * 与「移动」的关键差异：复制不改变源的文档状态，因此只刷新目标目录、
 * 不碰 syncDocumentsAfterRename —— 复制出来的副本默认不打开。
 * 撤销用回收站删掉副本，而不是再一次重命名。
 */
export async function copyEntries(sourcePaths: string[], targetDir: string): Promise<string[]> {
  const copies = planCopies(sourcePaths, targetDir)
  if (copies.length === 0) return []

  // 落盘后取回主进程的真实路径：planCopies 的 to 是 paths.join 产出的
  // 正斜杠，而缓存 / 选区 / 树都用反斜杠那一套，不换回来就会出现
  // "复制成功但副本不出现、也不被选中"。
  const created: string[] = []
  for (const item of copies) {
    await copy(item.from, item.to)
    created.push((await canonicalizeRename(item.from, item.to)).to)
  }

  const targetKey = toCacheKey(targetDir)
  await expandDirectory(targetKey)
  await refreshDirectory(targetKey)

  pushUndo({
    label: `复制 ${created.length} 项`,
    revert: async () => {
      for (const target of created) {
        await trash(target)
        closeDocumentsInside(target)
      }
      await refreshDirectory(targetKey)
    }
  })

  return created
}

/**
 * 粘贴落点的提供者。
 *
 * 由资源管理器视图注册：只有它知道"光标停在哪一行"，而命令与快捷键在 core 层，
 * 不能反过来依赖某个视图。视图卸载时注销，此时粘贴命令因取不到落点而自然失效。
 */
let pasteTargetProvider: (() => string | null) | null = null

export function setPasteTargetProvider(provider: (() => string | null) | null): void {
  pasteTargetProvider = provider
}

/**
 * 执行粘贴（命令与快捷键的入口）。
 *
 * 剪贴板为空或无落点时静默返回：调用方（命令面板）已用 when 条件隐藏了入口，
 * 这里再兜一次是为了避免视图未挂载时光标落点为空导致对 undefined 报错。
 */
export async function pasteFromClipboard(): Promise<void> {
  const clip = getClipboard()
  const targetDir = pasteTargetProvider?.() ?? null
  if (!clip || !targetDir) return

  if (clip.mode === 'cut') {
    // 只有真的搬动了才清剪贴板：剪切后粘贴到"它自己所在的目录"时 planMoves 会
    // 跳过（返回 0），此时若清空，用户就白白丢了剪贴板 —— 而"贴错地方了，
    // 换个目录再贴"恰恰是剪切后最常见的补救动作。
    const moved = await moveEntries(clip.paths, targetDir)
    if (moved > 0) clearClipboard()
    return
  }

  const created = await copyEntries(clip.paths, targetDir)
  if (created.length > 0) {
    setSelection(created)
    setSelectionAnchor(created[0])
  }
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

/**
 * 计算实际要执行的复制。
 *
 * 与 planMoves 的差异在于「复制到同一目录」是合法的 —— 那正是"原地复制一份"
 * 的常见用法。因此这里不剔除同目录项，改为在重名时生成副本名，
 * 否则主进程会因为"目标已存在"直接报错。
 */
function planCopies(sourcePaths: string[], targetDir: string): { from: string; to: string }[] {
  const unique = [...new Set(sourcePaths)]

  // 选区里同时有目录和它的子项时只复制目录：否则会在同一目标下写出两份内容
  const roots = unique.filter(
    (candidate) => !unique.some((other) => other !== candidate && paths.contains(other, candidate))
  )

  const copies: { from: string; to: string }[] = []
  // 记录本次已占用的目标名，避免「复制两个同名文件（来自不同目录）」时互相撞名
  // 注意 children 的键是主进程的反斜杠路径，targetDir 是正斜杠，必须换键
  const taken = new Set(
    (getWorkspaceState().children.get(toCacheKey(targetDir)) ?? []).map((entry) =>
      entry.name.toLowerCase()
    )
  )

  for (const source of roots) {
    // 目标在源内部：等于把目录复制进它自己，递归下去会无限膨胀
    if (paths.contains(source, targetDir)) continue

    const name = paths.basename(source)
    const to = paths.join(targetDir, name)

    // 同目录原地复制不走"目标已存在"报错，而是取一个不冲突的副本名
    const base = paths.basename(name)
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''

    let finalName = base
    let candidate = to
    let index = 1
    while (taken.has(finalName.toLowerCase())) {
      finalName = `${stem} copy${index > 1 ? ` ${index}` : ''}${ext}`
      candidate = paths.join(targetDir, finalName)
      index += 1
    }

    taken.add(finalName.toLowerCase())
    copies.push({ from: source, to: candidate })
  }

  return copies
}

/** 移动后刷新源目录（可能多个）并展开目标目录，让用户看得见结果 */
async function refreshAfterMove(
  moves: { from: string; to: string }[],
  targetDir: string
): Promise<void> {
  // 刷新只重读「缓存里已有键」的目录。planMoves 里的目标目录由 paths.join
  // 拼成（正斜杠），而缓存键是主进程返回的反斜杠路径，直接拿去 has() 会
  // 查不到 —— 于是刷新被静默跳过，界面停在"移动前"的旧内容上。
  // 统一走 toCacheKey 换成缓存那套写法再查。
  const targetKey = toCacheKey(targetDir)
  for (const dir of new Set(moves.map((move) => paths.dirname(move.from)))) {
    await refreshDirectory(toCacheKey(dir))
  }
  // 目标目录也要重读：它很可能已经因为"点进去看过"而缓存着旧内容，
  // 只 expand 不 refresh 的话，搬进去的文件会一直不出现（expandDirectory
  // 见缓存已存在就不再读盘）。
  await refreshDirectory(targetKey)
  await expandDirectory(targetKey)
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
