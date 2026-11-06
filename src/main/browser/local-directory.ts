import { constants, type BigIntStats } from 'node:fs'
import { access, lstat, opendir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BrowserLocalDirectoryContent, BrowserLocalDirectoryEntry } from '../../shared/browser'

const MAX_ENTRIES = 2000
const ENTRY_BATCH_SIZE = 32

export interface LocalDirectoryGrant {
  root: string
  dev: bigint
  ino: bigint
}

export interface LocalDirectoryTarget {
  path: string
  name: string
  kind: 'directory' | 'file'
  size: number
  modifiedAt: number
}

interface ResolvedEntry {
  selectedPath: string
  canonicalPath: string
  stat: BigIntStats
}

class DirectoryAccessError extends Error {}

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

function selectedPath(grant: LocalDirectoryGrant, path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new DirectoryAccessError('本地路径无效')
  }
  const selected = resolve(path)
  if (!within(grant.root, selected)) throw new DirectoryAccessError('此项目不在已授权目录内')
  return selected
}

async function assertRoot(grant: LocalDirectoryGrant): Promise<void> {
  if (await realpath(grant.root) !== grant.root) {
    throw new DirectoryAccessError('已授权目录的路径已变化，请重新选择目录')
  }
  const stat = await lstat(grant.root, { bigint: true })
  if (!stat.isDirectory() || stat.dev !== grant.dev || stat.ino !== grant.ino) {
    throw new DirectoryAccessError('已授权目录已被替换，请重新选择目录')
  }
}

async function verifyEntry(entry: ResolvedEntry): Promise<void> {
  if (await realpath(entry.selectedPath) !== entry.canonicalPath
    || await realpath(entry.canonicalPath) !== entry.canonicalPath) {
    throw new DirectoryAccessError('项目的路径已变化，请刷新后重试')
  }
  const current = await lstat(entry.canonicalPath, { bigint: true })
  if (current.dev !== entry.stat.dev || current.ino !== entry.stat.ino
    || current.isDirectory() !== entry.stat.isDirectory() || current.isFile() !== entry.stat.isFile()) {
    throw new DirectoryAccessError('项目已被替换，请刷新后重试')
  }
}

async function resolveEntry(grant: LocalDirectoryGrant, path: string): Promise<ResolvedEntry> {
  const selected = selectedPath(grant, path)
  const canonical = await realpath(selected)
  if (!within(grant.root, canonical)) throw new DirectoryAccessError('链接目标位于已授权目录之外')
  const stat = await lstat(canonical, { bigint: true })
  if (!stat.isDirectory() && !stat.isFile()) throw new DirectoryAccessError('不支持预览设备或特殊文件')
  // Permission checks do not open or read a file; content is inspected only after an explicit selection.
  await access(canonical, constants.R_OK | (stat.isDirectory() ? constants.X_OK : 0))
  const entry = { selectedPath: selected, canonicalPath: canonical, stat }
  await verifyEntry(entry)
  return entry
}

function presentTarget(entry: ResolvedEntry): LocalDirectoryTarget {
  const size = entry.stat.isFile() ? Number(entry.stat.size) : 0
  if (!Number.isSafeInteger(size)) throw new DirectoryAccessError('文件大小超出可预览范围')
  return {
    path: entry.canonicalPath,
    name: basename(entry.selectedPath) || entry.selectedPath,
    kind: entry.stat.isDirectory() ? 'directory' : 'file',
    size,
    modifiedAt: Number(entry.stat.mtimeMs)
  }
}

function unavailableMessage(error: unknown): string {
  if (error instanceof DirectoryAccessError) return error.message
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') return '没有读取权限'
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return '文件或链接目标不可用'
  return '无法读取此项目'
}

export async function authorizeLocalDirectory(canonicalPath: string): Promise<LocalDirectoryGrant> {
  if (typeof canonicalPath !== 'string' || !isAbsolute(canonicalPath) || canonicalPath.includes('\0')
    || await realpath(canonicalPath) !== canonicalPath) {
    throw new DirectoryAccessError('请选择规范化的本地目录路径')
  }
  const stat = await lstat(canonicalPath, { bigint: true })
  if (!stat.isDirectory()) throw new DirectoryAccessError('请选择目录')
  await access(canonicalPath, constants.R_OK | constants.X_OK)
  const grant = { root: canonicalPath, dev: stat.dev, ino: stat.ino }
  await assertRoot(grant)
  return grant
}

/** Metadata only: the returned canonical file still needs the caller's single-file preview checks. */
export async function inspectLocalDirectoryEntry(grant: LocalDirectoryGrant, path: string): Promise<LocalDirectoryTarget> {
  await assertRoot(grant)
  const entry = await resolveEntry(grant, path)
  await assertRoot(grant)
  return presentTarget(entry)
}

export async function readLocalDirectory(grant: LocalDirectoryGrant, path: string): Promise<BrowserLocalDirectoryContent> {
  await assertRoot(grant)
  const directory = await resolveEntry(grant, path)
  if (!directory.stat.isDirectory()) throw new DirectoryAccessError('此项目不是目录')
  const handle = await opendir(directory.canonicalPath)
  const entries: BrowserLocalDirectoryEntry[] = []
  let truncated = false
  try {
    // Check the authorization again after opening, before exposing any names from the directory handle.
    await assertRoot(grant)
    await verifyEntry(directory)
    let exhausted = false
    while (!exhausted) {
      const names: string[] = []
      while (names.length < ENTRY_BATCH_SIZE) {
        const next = await handle.read()
        if (!next) { exhausted = true; break }
        if (entries.length + names.length === MAX_ENTRIES) {
          truncated = true
          exhausted = true
          break
        }
        names.push(next.name)
      }
      const batch = await Promise.all(names.map(async (name): Promise<BrowserLocalDirectoryEntry> => {
        const path = join(directory.canonicalPath, name)
        try {
          const target = presentTarget(await resolveEntry(grant, path))
          // Retain the selected link path so navigation always revalidates its current destination.
          return { ...target, name, path }
        } catch (error) {
          return { name, path, kind: 'unavailable', message: unavailableMessage(error) }
        }
      }))
      entries.push(...batch)
      await assertRoot(grant)
      await verifyEntry(directory)
    }
  } finally {
    await handle.close()
  }
  await assertRoot(grant)
  await verifyEntry(directory)
  entries.sort((left, right) => {
    if (left.kind === 'directory' && right.kind !== 'directory') return -1
    if (left.kind !== 'directory' && right.kind === 'directory') return 1
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  const parent = directory.canonicalPath === grant.root ? null : dirname(directory.canonicalPath)
  return {
    kind: 'directory', path: directory.canonicalPath, root: grant.root,
    parent: parent && within(grant.root, parent) ? parent : null,
    entries, truncated
  }
}
