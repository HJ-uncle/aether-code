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
import { existsSync } from 'node:fs'
import type {
  CopyIntoWorkspaceInput,
  CopyIntoWorkspaceResult,
  FsEntry,
  FsFileContent,
  FsStat
} from '../../shared/ipc'

/** 文本文件读取上限：再大 Monaco 也会卡，提前截断并告知用户 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024

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

/** 已授权的工作区根目录（绝对路径，小写用于比较） */
const allowedRoots = new Set<string>()

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 授权一个目录作为工作区根 */
export function allowRoot(root: string): void {
  allowedRoots.add(normalizeForCompare(root))
}

export function getAllowedRoots(): string[] {
  return [...allowedRoots]
}

/** 校验路径位于任一已授权根目录内，否则抛错 */
export function assertAllowed(target: string): string {
  const resolved = path.resolve(target)
  const normalized = normalizeForCompare(resolved)

  for (const root of allowedRoots) {
    if (normalized === root) return resolved
    // 用 relative 判断而不是 startsWith，避免 /foo 命中 /foobar
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

/** 写入文本内容，自动创建父目录 */
export async function writeFile(filePath: string, content: string): Promise<FsStat> {
  const safePath = assertAllowed(filePath)
  await fsp.mkdir(path.dirname(safePath), { recursive: true })
  await fsp.writeFile(safePath, content, 'utf-8')
  return statPath(safePath)
}

/** 附件在工作区内的落盘目录（相对根）；用点目录避免污染用户项目 */
const ATTACHMENT_DIR = path.join('.aether', 'attachments')

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
  const dir = assertAllowed(path.join(safeRoot, ATTACHMENT_DIR))
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
