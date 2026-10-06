/**
 * Same document contract for local IPC and session-scoped remote workspace HTTP.
 * No operation may silently cross an engine/session boundary.
 */
import type { CopyIntoWorkspaceInput, CopyIntoWorkspaceResult, EngineRequestInput, FsEntry, FsFileContent, FsStat } from '@shared/ipc'
import { requestOrThrow } from '../engine/client'
import { isRemoteEngine } from '../engine/source'
import { assertWorkspaceTarget, captureWorkspaceTarget, type WorkspaceTarget } from './connection'

function bridge(): Window['aether'] {
  if (!window.aether) throw new Error('IPC 桥未就绪：preload 未加载')
  return window.aether
}

export interface RemoteWorkspaceContext {
  sessionId: string
  /** Actual server root, returned by the server's session binding resolver. */
  root: string
  target: WorkspaceTarget
}

interface DirectoryResponse { root: string; entries: FsEntry[] }
let remoteContextCache: { key: string; promise: Promise<RemoteWorkspaceContext> } | null = null

function scope(target: WorkspaceTarget): { sessionId: string; workspaceRoot?: string } {
  return { sessionId: target.sessionId, ...(target.workspaceRoot ? { workspaceRoot: target.workspaceRoot } : {}) }
}

/** Both preflight and completion are pinned to the originally captured target. */
async function remoteRequest<T>(target: WorkspaceTarget, input: EngineRequestInput): Promise<T> {
  assertWorkspaceTarget(target)
  const result = await requestOrThrow<T>({ ...input, expectedEngine: target.expectedEngine })
  assertWorkspaceTarget(target)
  return result
}

export async function remoteWorkspaceContext(): Promise<RemoteWorkspaceContext> {
  if (!isRemoteEngine()) throw new Error('当前不是远端引擎')
  const target = captureWorkspaceTarget()
  const key = JSON.stringify([target.key, target.generation])
  if (remoteContextCache?.key === key) return remoteContextCache.promise
  const promise = (async (): Promise<RemoteWorkspaceContext> => {
    if (target.workspaceRoot) {
      await remoteRequest(target, {
        method: 'POST', path: '/workspace/bind', body: { sessionId: target.sessionId, workspaceRoot: target.workspaceRoot }
      })
    }
    const result = await remoteRequest<DirectoryResponse>(target, {
      method: 'GET', path: '/workspace/directory', query: { ...scope(target), path: '.' }
    })
    if (!result || !Array.isArray(result.entries) || typeof result.root !== 'string' ||
        !/^(?:\/|[A-Za-z]:[\\/])/.test(result.root)) {
      throw new Error('远端引擎未提供工作区目录协议，请升级远端引擎')
    }
    return { sessionId: target.sessionId, root: result.root, target }
  })().catch((error: unknown) => {
    if (remoteContextCache?.key === key) remoteContextCache = null
    throw error
  })
  remoteContextCache = { key, promise }
  return promise
}

export function remoteWorkspaceRelativePath(context: Pick<RemoteWorkspaceContext, 'root'>, path: string): string {
  const from = context.root.replace(/\\/g, '/').replace(/\/+$/, '')
  const to = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const windows = /^(?:[A-Za-z]:\/|\/\/)/.test(from)
  const a = windows ? from.toLowerCase() : from
  const b = windows ? to.toLowerCase() : to
  if (b !== a && !b.startsWith(a + '/')) throw new Error('远程路径超出当前工作区')
  const relative = to.slice(from.length).replace(/^\/+/, '')
  if (relative.split('/').some(part => part === '..' || part === '.') || /[\u0000-\u001f\u007f:]/.test(relative)) {
    throw new Error('远程路径无效')
  }
  return relative
}

function remoteEntryPath(context: RemoteWorkspaceContext, relative: string): string {
  if (/^(?:\/|\\|[A-Za-z]:)/.test(relative) || relative.replace(/\\/g, '/').split('/').some(part => part === '..' || part === '.')) {
    throw new Error('远端引擎返回了工作区外路径')
  }
  return relative ? paths.join(context.root, relative) : context.root
}

/** Local-only operations reject remote mode before reaching the local bridge. */
export function allowRoot(root: string): Promise<void> {
  if (isRemoteEngine()) return Promise.reject(new Error('远端工作区不能授权本机目录'))
  return bridge().fs.allowRoot(root)
}
export function pickFolder(): Promise<string | null> {
  if (isRemoteEngine()) return Promise.reject(new Error('请在引擎设置中配置远端工作目录'))
  return bridge().fs.pickFolder()
}

export async function readDir(dir: string): Promise<FsEntry[]> {
  if (!isRemoteEngine()) return bridge().fs.readDir(dir)
  const context = await remoteWorkspaceContext()
  const result = await remoteRequest<DirectoryResponse>(context.target, {
    method: 'GET', path: '/workspace/directory',
    query: { ...scope(context.target), path: remoteWorkspaceRelativePath(context, dir) || '.' }
  })
  if (!Array.isArray(result?.entries)) throw new Error('远端目录响应无效，请升级远端引擎')
  return result.entries.map(entry => ({
    ...entry,
    name: entry.name,
    path: remoteEntryPath(context, entry.path),
    size: Number.isFinite(entry.size) ? entry.size : 0,
    mtimeMs: Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : 0
  }))
}

/**
 * Return the workspace file list used by Quick Open and @-file references.
 *
 * The local implementation is exposed by the main-process fs bridge.  A
 * remote workspace has no local grant, so calling that bridge with the
 * server-side root would always fail the local path allow-list check.  Walk
 * the already session-scoped remote directory API instead and keep the same
 * dependency/build-directory filtering and item cap as the local service.
 */
const LIST_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'release', '.vite', 'coverage'])
const MAX_LIST_FILES = 20_000

export async function listAllFiles(root: string): Promise<string[]> {
  if (!isRemoteEngine()) return bridge().fs.listAll(root)
  const context = await remoteWorkspaceContext()
  // The context is captured once so every directory request and relative path
  // conversion belongs to the same endpoint/session snapshot.
  if (remoteWorkspaceRelativePath(context, root) !== '') throw new Error('远端工作区根目录已变化')
  const files: string[] = []
  const pending: string[] = [root]
  while (pending.length > 0 && files.length < MAX_LIST_FILES) {
    const dir = pending.pop()!
    const entries = await readDir(dir)
    for (const entry of entries) {
      if (files.length >= MAX_LIST_FILES) break
      if (entry.isDirectory) {
        if (!LIST_SKIP_DIRS.has(entry.name)) pending.push(entry.path)
      } else {
        const relative = remoteWorkspaceRelativePath(context, entry.path)
        if (relative) files.push(relative.replace(/\\/g, '/'))
      }
    }
  }
  return files
}

export async function readFile(path: string): Promise<FsFileContent> {
  if (!isRemoteEngine()) return bridge().fs.readFile(path)
  const context = await remoteWorkspaceContext()
  const result = await remoteRequest<{ content: string; isBinary: boolean; totalSize: number; originalLength?: number; truncated?: boolean; tooLarge?: boolean }>(context.target, {
    method: 'GET', path: '/workspace/file/content',
    query: { ...scope(context.target), path: remoteWorkspaceRelativePath(context, path) }
  })
  return {
    path, content: result.isBinary ? '' : result.content,
    ...(result.isBinary ? { base64: result.content } : {}),
    isBinary: result.isBinary, size: result.totalSize, tooLarge: result.tooLarge,
    // Keep explicit truncation authoritative; older servers append a marker
    // whose length can exceed the omitted tail.
    truncated: result.truncated ?? (typeof result.originalLength === 'number' && result.originalLength > 500 * 1024)
  }
}

async function remoteStat(context: RemoteWorkspaceContext, path: string): Promise<FsStat> {
  const result = await remoteRequest<{ isDirectory: boolean; size: number; mtime?: number; mtimeMs?: number }>(context.target, {
    method: 'GET', path: '/workspace/file/info',
    query: { ...scope(context.target), path: remoteWorkspaceRelativePath(context, path) || '.' }
  })
  if (typeof result.isDirectory !== 'boolean') throw new Error('远端文件元数据协议不兼容，请升级远端引擎')
  return { path, isDirectory: result.isDirectory, size: result.size, mtimeMs: result.mtimeMs ?? result.mtime ?? 0 }
}

export async function stat(path: string): Promise<FsStat> {
  if (!isRemoteEngine()) return bridge().fs.stat(path)
  return remoteStat(await remoteWorkspaceContext(), path)
}
export async function writeFile(path: string, content: string): Promise<FsStat> {
  if (!isRemoteEngine()) return bridge().fs.writeFile(path, content)
  const context = await remoteWorkspaceContext()
  await remoteRequest(context.target, {
    method: 'POST', path: '/workspace/file',
    body: { ...scope(context.target), path: remoteWorkspaceRelativePath(context, path), content }
  })
  return remoteStat(context, path)
}
async function mutate(path: string, route: string): Promise<void> {
  const context = await remoteWorkspaceContext()
  await remoteRequest(context.target, { method: 'POST', path: route,
    body: { ...scope(context.target), path: remoteWorkspaceRelativePath(context, path) } })
}
export function createFile(path: string): Promise<void> {
  return isRemoteEngine() ? mutate(path, '/workspace/file/create') : bridge().fs.createFile(path)
}
export function createFolder(path: string): Promise<void> {
  return isRemoteEngine() ? mutate(path, '/workspace/folder/create') : bridge().fs.createFolder(path)
}
export function trash(path: string): Promise<void> {
  return isRemoteEngine() ? mutate(path, '/workspace/file/trash') : bridge().fs.trash(path)
}
async function transfer(src: string, dest: string, route: string): Promise<void> {
  const context = await remoteWorkspaceContext()
  await remoteRequest(context.target, { method: 'POST', path: route, body: {
    ...scope(context.target), srcPath: remoteWorkspaceRelativePath(context, src), destPath: remoteWorkspaceRelativePath(context, dest)
  } })
}
export function rename(src: string, dest: string): Promise<void> {
  return isRemoteEngine() ? transfer(src, dest, '/workspace/file/move') : bridge().fs.rename(src, dest)
}
export function copy(src: string, dest: string): Promise<void> {
  // Server-side copy preserves all bytes, hidden children and metadata. Never
  // reconstruct a copied file from editor preview content.
  return isRemoteEngine() ? transfer(src, dest, '/workspace/file/copy') : bridge().fs.copy(src, dest)
}

function sanitizeAttachmentName(name: string): string {
  const base = paths.basename(name).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
  return base || 'file'
}

function encodeBase64(data: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

async function remoteCopyIntoWorkspace(input: CopyIntoWorkspaceInput): Promise<CopyIntoWorkspaceResult> {
  const context = await remoteWorkspaceContext()
  const safeName = sanitizeAttachmentName(input.fileName)
  const extension = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.')) : ''
  const stem = extension ? safeName.slice(0, -extension.length) : safeName
  let relative = `.aether/attachments/${safeName}`

  // Keep the same no-overwrite contract as the local attachment bridge. A
  // failed existence probe is only treated as "missing" for the server's
  // explicit not-found response; connection/protocol errors must surface.
  for (let index = 1; index <= 1000; index += 1) {
    try {
      await remoteStat(context, paths.join(context.root, relative))
      relative = `.aether/attachments/${stem}-${index}${extension}`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/(?:40400|not found|不存在|no such file)/i.test(message)) throw error
      break
    }
  }

  await remoteRequest(context.target, {
    method: 'POST', path: '/workspace/file',
    body: { ...scope(context.target), path: relative, content: encodeBase64(input.data), encoding: 'base64' }
  })
  return { path: paths.join(context.root, relative), relativePath: relative, size: input.data.byteLength }
}

export function copyIntoWorkspace(input: CopyIntoWorkspaceInput): Promise<CopyIntoWorkspaceResult> {
  if (isRemoteEngine()) return remoteCopyIntoWorkspace(input)
  return bridge().fs.copyIntoWorkspace(input)
}

/** 路径工具：不依赖 node:path（渲染进程没有 Node 能力） */
export const paths = {
  /** 取最后一段（文件名或目录名） */
  basename(p: string): string {
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
    return parts[parts.length - 1] ?? p
  },
  /** 取父目录 */
  dirname(p: string): string {
    const normalized = p.replace(/\\/g, '/')
    const index = normalized.lastIndexOf('/')
    if (index <= 0) return normalized.slice(0, index + 1) || normalized
    return normalized.slice(0, index)
  },
  /** 以 / 拼接（保持跨平台可读性；主进程会再 resolve 一次） */
  join(...segments: string[]): string {
    return segments
      .map((segment, index) =>
        index === 0 ? segment.replace(/[/\\]+$/, '') : segment.replace(/^[/\\]+|[/\\]+$/g, '')
      )
      .filter(Boolean)
      .join('/')
  },
  /**
   * child 是否位于 parent 之内（含自身）。
   *
   * 两种分隔符都归一化后比较：主进程给的路径是 Windows 反斜杠，
   * 而这里拼接出来的可能是正斜杠，直接 startsWith 会漏判。
   */
  contains(parent: string, child: string): boolean {
    const from = parent.replace(/\\/g, '/').replace(/\/+$/, '')
    const to = child.replace(/\\/g, '/')
    return to === from || to.startsWith(`${from}/`)
  },
  /**
   * 取 child 相对 parent 的路径，供 glob 匹配使用（分隔符统一成正斜杠）。
   *
   * 不在 parent 之内时原样返回 child 并单独剥掉前导分隔符 ——
   * 匹配器拿到的至少是个可用字符串，不会因相对化失败而整条规则失效。
   */
  relative(parent: string, child: string): string {
    const from = parent.replace(/\\/g, '/').replace(/\/+$/, '')
    const to = child.replace(/\\/g, '/').replace(/\/+$/, '')
    if (to === from) return ''
    if (to.startsWith(`${from}/`)) return to.slice(from.length + 1)
    return to.replace(/^\/+/, '')
  }
}
