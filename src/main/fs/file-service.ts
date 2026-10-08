/**
 * 文件系统服务（主进程）
 *
 * IDE 的资源管理器与编辑器直接读写真实文件系统 —— 引擎的 workspace API
 * 只能操作它自己的沙箱目录，无法承载"打开任意文件夹"这个需求。
 *
 * 安全边界：只允许访问「已打开的工作区根目录」内的路径。
 * 渲染进程虽然是我们自己的代码，但一旦出现 XSS 或依赖投毒，通用 fs 访问
 * 会变成任意文件写入。用根目录白名单把影响面收敛到用户显式打开的项目内。
 */
import { shell, dialog } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { markGitignored } from './gitignore-matcher'
import { ATTACHMENTS_DIRECTORY } from '../../shared/attachments'
import type {
  CopyIntoWorkspaceInput,
  CopyIntoWorkspaceResult,
  FsEntry,
  FsFileContent,
  FsStat
} from '../../shared/ipc'

/** 文本文件读取上限：再大 Monaco 也会卡，提前截断并告知用户 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024

/**
 * Windows 文件观察器、索引器或杀毒软件可能在原子替换的瞬间短暂持有目标文件。
 * 只对这些瞬时错误重试，保留 rename 的原子写入语义并让真正的权限错误继续上抛。
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function renameWithRetry(source: string, destination: string): Promise<void> {
  const attempts = 8
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fsp.rename(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt === attempts - 1) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}

/** 快速打开的文件清单上限：超出按目录序截断（正常项目远达不到） */
const MAX_LIST_FILES = 20000

/** 快速打开跳过的目录（依赖与构建产物，列它们只会干扰搜索） */
const LIST_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'release',
  '.vite',
  'coverage'
])

/**
 * 递归列出工作区全部文件（相对路径，/ 分隔）。供 Ctrl+P 快速打开。
 * 上限截断而不是报错：万级文件的项目里用户靠文件名过滤，不需要全量。
 */
export async function listAllFiles(root: string): Promise<string[]> {
  const safeRoot = assertAllowed(root)
  const files: string[] = []

  const walk = async (relative: string): Promise<void> => {
    if (files.length >= MAX_LIST_FILES) return
    const entries = await fsp.readdir(path.join(safeRoot, relative), { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_LIST_FILES) return
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!LIST_SKIP_DIRS.has(entry.name)) await walk(rel)
      } else if (entry.isFile()) {
        files.push(rel)
      }
    }
  }

  await walk('')
  return files
}

/** 判定二进制时采样的字节数 */
const BINARY_SAMPLE_BYTES = 8192

/**
 * 二进制预览上限。
 *
 * base64 会把整份文件读进内存并膨胀约 4/3，一个几百 MB 的视频足以让主进程
 * OOM。超限时明确拒绝预览（UI 会告知大小），而不是试图硬读。
 */
const MAX_BINARY_BYTES = 32 * 1024 * 1024

/** 已授权的工作区根目录（规范化后，小写用于比较） */
const allowedRoots = new Set<string>()

/**
 * 同一批根目录的**真实大小写**路径。
 *
 * allowedRoots 为比较而小写化了，不能拿去拼路径（Linux 大小写敏感，Windows 上
 * 也会让显示与实际不符）。这里留一份原文，供「判断某个目录属于哪个工作区根」
 * 这类需要真实路径的场景使用。
 */
const allowedRootPaths = new Set<string>()

function canonicalExistingTarget(target: string): string {
  const resolved = path.resolve(target); let probe = resolved; const suffix: string[] = []
  while (!existsSync(probe)) { const parent = path.dirname(probe); if (parent === probe) return resolved; suffix.unshift(path.basename(probe)); probe = parent }
  return path.resolve(realpathSync(probe), ...suffix)
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 授权一个目录作为工作区根 */
export function allowRoot(root: string): void {
  const resolved = path.resolve(root)
  const real = realpathSync(resolved)
  allowedRoots.add(normalizeForCompare(real))
  allowedRootPaths.add(real)
}

export function getAllowedRoots(): string[] {
  return [...allowedRoots]
}

/**
 * 目录所属的工作区根（真实路径）；不在任何根下时返回 null。
 *
 * 取**最长**的一段前缀：嵌套工作区（把子目录也打开成一个根）时，.gitignore 的
 * 查找必须止于离目录最近的那个根，否则会读到外层项目、与本工作区无关的规则。
 */
function workspaceRootOf(dir: string): string | null {
  const resolved = path.resolve(dir)
  let best: string | null = null
  for (const root of allowedRootPaths) {
    if (resolved === root) return root
    const rel = path.relative(root, resolved)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    if (!best || root.length > best.length) best = root
  }
  return best
}

/** 校验路径位于任一已授权根目录内，否则抛错 */
export function assertAllowed(target: string): string {
  const resolved = path.resolve(target)
  const normalized = normalizeForCompare(canonicalExistingTarget(resolved))
  for (const root of allowedRoots) {
    if (normalized === root) return resolved
    const rel = path.relative(root, normalized)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return resolved
  }
  throw new Error('拒绝访问工作区之外的路径。请先通过「打开文件夹」授权该目录。')
}

/** 弹出系统目录选择框，选中后自动授权 */
export async function pickFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '打开文件夹',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const picked = path.resolve(result.filePaths[0])
  allowRoot(picked)
  return picked
}

/** 读取目录（不递归，按需展开），目录在前、同类按名称排序 */
export async function readDirectory(dir: string): Promise<FsEntry[]> {
  const safeDir = assertAllowed(dir)

  const dirents = await fsp.readdir(safeDir, { withFileTypes: true })
  const entries: FsEntry[] = []

  for (const dirent of dirents) {
    const fullPath = path.join(safeDir, dirent.name)
    let isDirectory = dirent.isDirectory()
    let size = 0
    let mtimeMs = 0

    try {
      // 符号链接：用 stat 跟随，指向目录时按目录处理
      const stat = dirent.isSymbolicLink() ? await fsp.stat(fullPath) : await fsp.lstat(fullPath)
      isDirectory = stat.isDirectory()
      size = stat.size
      mtimeMs = stat.mtimeMs
    } catch {
      // 权限不足或链接失效：仍然列出，但元数据留空，避免整个目录读取失败
    }

    entries.push({ name: dirent.name, path: fullPath, isDirectory, size, mtimeMs })
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  // 标记被 .gitignore 忽略的项（资源管理器据此置灰）；不在工作区内时自动跳过
  const root = workspaceRootOf(safeDir)
  if (root) await markGitignored(entries, safeDir, root)

  return entries
}

/** 读取文件内容；二进制返回 base64，文本超限则截断 */
export async function readFile(filePath: string): Promise<FsFileContent> {
  const safePath = assertAllowed(filePath)

  const handle = await fsp.open(safePath, 'r')
  try {
    const stat = await handle.stat()
    const sampleSize = Math.min(BINARY_SAMPLE_BYTES, stat.size)
    const sample = Buffer.alloc(sampleSize)
    if (sampleSize > 0) await handle.read(sample, 0, sampleSize, 0)

    const isBinary = sample.includes(0)

    if (isBinary) {
      // 超限不读：见 MAX_BINARY_BYTES 的说明
      if (stat.size > MAX_BINARY_BYTES) {
        return {
          path: safePath,
          content: '',
          isBinary: true,
          size: stat.size,
          truncated: false,
          tooLarge: true
        }
      }

      const buffer = await fsp.readFile(safePath)
      return {
        path: safePath,
        content: '',
        base64: buffer.toString('base64'),
        isBinary: true,
        size: stat.size,
        truncated: false
      }
    }

    const truncated = stat.size > MAX_TEXT_BYTES
    const readSize = truncated ? MAX_TEXT_BYTES : stat.size
    const buffer = Buffer.alloc(readSize)
    if (readSize > 0) await handle.read(buffer, 0, readSize, 0)

    let content = buffer.toString('utf-8')
    // 去掉 UTF-8 BOM，否则 Monaco 会在首行显示一个不可见字符
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)

    return {
      path: safePath,
      content,
      isBinary: false,
      size: stat.size,
      truncated
    }
  } finally {
    await handle.close()
  }
}

/** 系统文件管理器只接受授权工作区路径，不能由渲染进程绕过文件访问边界。 */
export async function revealPath(target: string): Promise<void> {
  const safePath = assertAllowed(target)
  // shell 的 void 返回值无法报告缺失文件；先检查，避免给用户一个无响应的菜单动作。
  await fsp.access(safePath)
  shell.showItemInFolder(safePath)
}

/** 写入文本内容，自动创建父目录 */
export async function writeFile(filePath: string, content: string): Promise<FsStat> {
  const safePath = assertAllowed(filePath)
  await fsp.mkdir(path.dirname(safePath), { recursive: true })
  // Write beside the destination and replace it only after the complete
  // payload is on disk. A direct writeFile truncates first, so readers such as
  // the editor's file watcher can briefly observe an empty/partial file and
  // reload that transient state while a save is in progress.
  const temporary = `${safePath}.aether-write-${randomUUID()}.tmp`
  try {
    await fsp.writeFile(temporary, content, 'utf-8')
    await renameWithRetry(temporary, safePath)
  } finally {
    // A failed rename must not leave an unbounded set of hidden temp files.
    try { await fsp.rm(temporary, { force: true }) } catch { /* best effort cleanup */ }
  }
  return statPath(safePath)
}

/** 文件名里不能出现的字符（Windows 限制 + 路径穿越） */
function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
  return base || 'file'
}

/**
 * 把本地文件的字节流落盘到工作区，返回相对根目录的路径。
 *
 * 为什么需要它：聊天里的 File 对象拿不到真实磁盘路径（浏览器安全模型），
 * 只能把字节流传到主进程。落盘后交给引擎的 /workspace/upload 读取 ——
 * 引擎的路径白名单只认它自己的沙箱/工作区，所以必须有一份在工作区内。
 *
 * 重名时自动加序号，避免覆盖用户已有附件。
 */
export async function copyIntoWorkspace(
  input: CopyIntoWorkspaceInput
): Promise<CopyIntoWorkspaceResult> {
  const safeRoot = assertAllowed(input.root)
  const dir = assertAllowed(path.join(safeRoot, ATTACHMENTS_DIRECTORY))
  await fsp.mkdir(dir, { recursive: true })

  const safeName = sanitizeFileName(input.fileName)
  const ext = path.extname(safeName)
  const stem = path.basename(safeName, ext)

  let target = path.join(dir, safeName)
  for (let i = 1; existsSync(target); i += 1) {
    target = path.join(dir, `${stem}-${i}${ext}`)
  }

  const buffer = Buffer.from(input.data)
  await fsp.writeFile(target, buffer)

  return {
    path: target,
    relativePath: path.relative(safeRoot, target).split(path.sep).join('/'),
    size: buffer.length
  }
}

export async function createFile(filePath: string): Promise<void> {
  const safePath = assertAllowed(filePath)
  if (existsSync(safePath)) throw new Error('同名文件已存在')
  await fsp.mkdir(path.dirname(safePath), { recursive: true })
  await fsp.writeFile(safePath, '', 'utf-8')
}

export async function createFolder(folderPath: string): Promise<void> {
  const safePath = assertAllowed(folderPath)
  if (existsSync(safePath)) throw new Error('同名文件夹已存在')
  await fsp.mkdir(safePath, { recursive: true })
}

/** 重命名 / 移动 */
export async function renamePath(srcPath: string, destPath: string): Promise<void> {
  const safeSrc = assertAllowed(srcPath)
  const safeDest = assertAllowed(destPath)
  if (existsSync(safeDest)) throw new Error('目标已存在')
  await fsp.mkdir(path.dirname(safeDest), { recursive: true })
  await fsp.rename(safeSrc, safeDest)
}

/**
 * 复制文件或目录到新位置。
 *
 * 用 `fsp.cp` 的 recursive 而不是自己写递归遍历：Node 已内置处理
 * 目录树、符号链接与权限位，手写版本在这些边界上更容易出错。
 * 与 renamePath 一致地拒绝覆盖已存在目标 —— 用户更可能想要"改名保留两份"
 * 而不是"悄悄覆盖掉一份"，覆盖造成的损失不可逆。
 */
export async function copyPath(srcPath: string, destPath: string): Promise<void> {
  const safeSrc = assertAllowed(srcPath)
  const safeDest = assertAllowed(destPath)
  if (existsSync(safeDest)) throw new Error('目标已存在')
  await fsp.mkdir(path.dirname(safeDest), { recursive: true })
  await fsp.cp(safeSrc, safeDest, { recursive: true })
}

/**
 * 移入系统回收站。
 *
 * 刻意不做"失败就永久删除"的降级：那会让用户以为文件可恢复。
 * 回收站不可用时直接报错，由用户决定下一步。
 */
export async function trashPath(targetPath: string): Promise<void> {
  const safePath = assertAllowed(targetPath)
  await shell.trashItem(safePath)
}

export async function statPath(targetPath: string): Promise<FsStat> {
  const safePath = assertAllowed(targetPath)
  const stat = await fsp.stat(safePath)
  return {
    path: safePath,
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  }
}
