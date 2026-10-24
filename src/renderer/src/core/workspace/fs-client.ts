/**
 * Same document contract for local IPC and session-scoped remote workspace HTTP.
 * No operation may silently cross an engine/session boundary.
 */
import type { CopyIntoWorkspaceInput, CopyIntoWorkspaceResult, EngineRequestInput, FsEntry, FsFileContent, FsStat } from '@shared/ipc'
import { ATTACHMENTS_DIRECTORY } from '@shared/attachments'
import { requestOrThrow } from '../engine/client'
import { assertEngineSource, getEngineSource, getExpectedEngine, isRemoteEngine } from '../engine/source'
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

/**
 * Resolve the server-side workspace owned by a chat session.
 *
 * Work tasks created by the embedded engine use a generated workspace under
 * the engine data directory. That path is intentionally outside the IDE's
 * local allow-list, so passing it to the normal `fs:read-file` bridge causes
 * a misleading "打开文件夹" error. The workspace HTTP API is already
 * session-scoped; use it to obtain the exact root before reading or opening a
 * Work artifact.
 */
export interface SessionWorkspaceContext {
  sessionId: string
  root: string
}

/**
 * Work's workspace and Git panels can mount at the same time. The engine
 * keeps a single lease per session, so two identical bind requests racing
 * during panel startup would make one of them fail with WORKSPACE_LEASE_BUSY.
 * Keep the in-flight operation scoped to the complete engine identity and
 * request arguments; completed operations are removed so a later explicit
 * rebind still reaches the engine.
 */
const sessionBindingRequests = new Map<string, Promise<SessionWorkspaceContext>>()

/**
 * Resolve the workspace owned by a Work session. A newly admitted local Work
 * run starts with a private scratch directory in the engine. The task root is
 * carried separately as a local recovery hint; merely viewing a receipt must
 * never mutate the server binding. A binding is established when the task is
 * admitted or when the user explicitly selects a workspace.
 */
export async function sessionWorkspaceContext(sessionId: string, workspaceRoot?: string | null): Promise<SessionWorkspaceContext> {
  const target = { source: getEngineSource(), expectedEngine: getExpectedEngine() }
  return readSessionWorkspaceContext(sessionId, target, workspaceRoot)
}

/**
 * Bind a Work session to the directory the user explicitly selected.
 *
 * The authenticated engine deliberately falls back to a private scratch root
 * when a session has no binding; merely reading a persisted workspace hint must
 * not change that binding.  Work's folder picker and the active task scope call
 * this explicit operation before displaying files or invoking Git, so every
 * panel follows the same session workspace instead of silently showing the
 * engine's generated `work-home-*` directory.
 */
export async function bindSessionWorkspace(sessionId: string, workspaceRoot: string): Promise<SessionWorkspaceContext> {
  const target = { source: getEngineSource(), expectedEngine: getExpectedEngine() }
  const id = sessionId.trim()
  const root = workspaceRoot.trim()
  if (!id) throw new Error('工作区会话无效')
  if (!root || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(root)) throw new Error('工作区目录无效')
  const key = JSON.stringify([target.source, target.expectedEngine, id, root])
  const existing = sessionBindingRequests.get(key)
  if (existing) return existing

  const operation = (async (): Promise<SessionWorkspaceContext> => {
    await sessionRequest(id, target, {
      method: 'POST',
      path: '/workspace/bind',
      body: { sessionId: id, workspaceRoot: root }
    })
    assertEngineSource(target.source)
    return readSessionWorkspaceContext(id, target, root)
  })()
  sessionBindingRequests.set(key, operation)
  try {
    return await operation
  } finally {
    if (sessionBindingRequests.get(key) === operation) sessionBindingRequests.delete(key)
  }
}

interface SessionRequestTarget {
  readonly source: number
  readonly expectedEngine: EngineRequestInput['expectedEngine']
}

/** A document owns this session binding; the Code selection must never replace it. */
export interface SessionFileTarget extends SessionRequestTarget {
  readonly sessionId: string
  readonly root: string
  readonly key: string
}

export function assertSessionFileTarget(target: SessionFileTarget): void {
  assertEngineSource(target.source)
  if (JSON.stringify(target.expectedEngine) !== JSON.stringify(getExpectedEngine())) throw new Error('引擎连接已变化，请在当前会话重试')
}

async function sessionRequest<T>(sessionId: string, target: SessionRequestTarget, input: EngineRequestInput): Promise<T> {
  assertEngineSource(target.source)
  const result = await requestOrThrow<T>({ ...input, expectedEngine: target.expectedEngine,
    toolProfile: sessionId.startsWith('work-') ? 'general' : input.toolProfile })
  assertEngineSource(target.source)
  return result
}

async function readSessionWorkspaceContext(sessionId: string, target: SessionRequestTarget, workspaceRoot?: string | null): Promise<SessionWorkspaceContext> {
  assertEngineSource(target.source)
  const id = sessionId.trim()
  if (!id) throw new Error('工作区会话无效')
  // `workspaceRoot` is intentionally not sent to /workspace/bind here. It is
  // a desktop task hint and may be stale after a restart; binding while merely
  // previewing would silently move a session to the wrong root.
  void workspaceRoot
  const result = await sessionRequest<DirectoryResponse>(id, target, {
    method: 'GET', path: '/workspace/directory', query: { sessionId: id, path: '.' }
  })
  assertEngineSource(target.source)
  const root = result?.root
  const isAbsoluteRoot = typeof root === 'string' &&
    (root.startsWith('/') || root.startsWith('\\\\') ||
      (/^[A-Za-z]:/.test(root) && (root[2] === '/' || root[2] === '\\')))
  if (!root || !isAbsoluteRoot || /[\u0000-\u001f\u007f]/.test(root) || root.replace(/\\/g, '/').split('/').some(part => part === '.' || part === '..')) {
    throw new Error('引擎未提供任务工作区，请重试')
  }
  return { sessionId: id, root }
}

function sessionRelativePath(root: string, candidate: string, allowDirectoryRoot = false): string {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = candidate.replace(/\\/g, '/')
  const windows = /^(?:[A-Za-z]:(?:\/|$)|\/\/)/.test(normalizedRoot)
  const rootForCompare = windows ? normalizedRoot.toLowerCase() : normalizedRoot
  const candidateForCompare = windows ? normalized.toLowerCase() : normalized
  let relative = normalized
  if (candidateForCompare === rootForCompare || candidateForCompare.startsWith(`${rootForCompare}/`)) {
    relative = normalized.slice(normalizedRoot.length).replace(/^\/+/, '')
  } else if (/^(?:[A-Za-z]:|\/)/.test(normalized)) throw new Error('文件不属于当前任务工作区')
  if (!relative && allowDirectoryRoot) return ''
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f:]/.test(part))) {
    throw new Error('任务文件路径无效')
  }
  return relative
}

function sessionRelativePathsForHint(root: string, candidate: string, workspaceRoot?: string | null): string[] {
  let firstError: unknown
  const relative: string[] = []
  const seen = new Set<string>()
  const add = (value: string): void => {
    try {
      const next = sessionRelativePath(root, value)
      const key = /^(?:[A-Za-z]:(?:\/|$)|\/\/)/.test(root.replace(/\\/g, '/')) ? next.toLowerCase() : next
      if (!seen.has(key)) {
        seen.add(key)
        relative.push(next)
      }
    } catch (error) {
      firstError ??= error
    }
  }

  // Keep the receipt's original path first.  Recovery aliases are only
  // considered when the session root rejects it, and every alias is checked
  // against that same authenticated root before it can reach the server.
  add(candidate)
  if (workspaceRoot) {
    for (const recovered of workspaceRecoveryCandidates(candidate, workspaceRoot)) add(recovered)
  }
  if (relative.length === 0) throw firstError instanceof Error ? firstError : new Error('任务文件路径无效')
  return relative
}

function sessionRelativePathForHint(root: string, candidate: string, workspaceRoot?: string | null): string {
  return sessionRelativePathsForHint(root, candidate, workspaceRoot)[0]!
}

function isMissingSessionFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:404|not[\s_-]*found|no such file|不存在|文件不存在)/i.test(message)
}

function sessionAbsolutePath(root: string, relative: string): string {
  return `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/${relative}`
}

/** Both embedded scratch and remote files remain under the engine's session allow-list. */
export async function resolveSessionFilePath(sessionId: string, candidate: string, workspaceRoot?: string | null): Promise<{ path: string; root: string; target: SessionFileTarget }> {
  const target = { source: getEngineSource(), expectedEngine: getExpectedEngine() }
  const context = await readSessionWorkspaceContext(sessionId, target, workspaceRoot)
  const relative = sessionRelativePathForHint(context.root, candidate, workspaceRoot)
  assertEngineSource(target.source)
  const owner: SessionFileTarget = Object.freeze({ ...target, ...context,
    key: JSON.stringify([target.source, target.expectedEngine, context.sessionId, context.root]) })
  return { path: sessionAbsolutePath(context.root, relative), root: context.root, target: owner }
}

/**
 * Capture the authenticated file target for a Work task without reading a
 * file.  Work's workspace browser uses this to list directories through the
 * session-scoped endpoint; it must never fall back to the Code workspace
 * bridge, even when the task has a stale local workspace hint.
 */
export async function captureSessionFileTarget(sessionId: string, workspaceRoot?: string | null): Promise<SessionFileTarget> {
  const target = { source: getEngineSource(), expectedEngine: getExpectedEngine() }
  const context = await readSessionWorkspaceContext(sessionId, target, workspaceRoot)
  assertEngineSource(target.source)
  return Object.freeze({
    ...target,
    ...context,
    key: JSON.stringify([target.source, target.expectedEngine, context.sessionId, context.root])
  })
}

async function verifySessionBinding(target: SessionFileTarget): Promise<void> {
  assertSessionFileTarget(target)
  const context = await readSessionWorkspaceContext(target.sessionId, target)
  if (context.root !== target.root) throw new Error('任务工作区已变化，请关闭旧文档后重新打开')
}

interface SessionContentResponse { content: string; isBinary: boolean; totalSize: number; originalLength?: number; truncated?: boolean; tooLarge?: boolean }
function sessionFileContent(path: string, result: SessionContentResponse): FsFileContent {
  return { path, content: result.isBinary ? '' : result.content,
    ...(result.isBinary ? { base64: result.content } : {}), isBinary: result.isBinary,
    size: result.totalSize, tooLarge: result.tooLarge,
    truncated: result.truncated ?? (typeof result.originalLength === 'number' && result.originalLength > 500 * 1024) }
}

export async function readSessionFile(sessionId: string, candidate: string, workspaceRoot?: string | null): Promise<FsFileContent> {
  // Resolving a root and reading its bytes must use the same endpoint identity.
  // A connection change between the two requests cannot authorize the new one.
  const target = { source: getEngineSource(), expectedEngine: getExpectedEngine() }
  const context = await readSessionWorkspaceContext(sessionId, target, workspaceRoot)
  const relatives = sessionRelativePathsForHint(context.root, candidate, workspaceRoot)
  let lastError: unknown
  for (let index = 0; index < relatives.length; index += 1) {
    const relative = relatives[index]!
    try {
      const result = await sessionRequest<SessionContentResponse>(context.sessionId, target, {
        method: 'GET', path: '/workspace/file/content',
        query: { sessionId: context.sessionId, path: relative }, expectedEngine: target.expectedEngine
      })
      assertEngineSource(target.source)
      return sessionFileContent(sessionAbsolutePath(context.root, relative), result)
    } catch (error) {
      lastError = error
      // A stale receipt can produce several syntactically valid aliases. Only
      // continue on an explicit missing-file response; permission, transport,
      // engine-generation and protocol failures must remain visible.
      if (!isMissingSessionFileError(error) || index === relatives.length - 1) throw error
    }
  }
  throw lastError ?? new Error('任务文件读取失败')
}

/** Original binary bytes bypass renderer text previews and retain this session's
 * binding across the save dialog and the complete authenticated transfer. */
export async function saveSessionFile(sessionId: string, candidate: string, workspaceRoot?: string | null): Promise<import('@shared/ipc').EngineFileSaveResult> {
  const target = { source: getEngineSource(), expectedEngine: getExpectedEngine() }
  const context = await readSessionWorkspaceContext(sessionId, target, workspaceRoot)
  const relatives = sessionRelativePathsForHint(context.root, candidate, workspaceRoot)
  let lastError: unknown
  for (let index = 0; index < relatives.length; index += 1) {
    const relative = relatives[index]!
    try {
      assertEngineSource(target.source)
      const result = await bridge().engine.saveWorkspaceFile({ sessionId: context.sessionId, path: relative,
        workspaceRoot: context.root, expectedEngine: target.expectedEngine })
      assertEngineSource(target.source)
      return result
    } catch (error) {
      lastError = error
      if (!isMissingSessionFileError(error) || index === relatives.length - 1) throw error
    }
  }
  throw lastError ?? new Error('任务文件保存失败')
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
  if (!path || path === '.') return ''
  const from = context.root.replace(/\\/g, '/').replace(/\/+$/, '')
  const to = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const windows = /^(?:[A-Za-z]:(?:\/|$)|\/\/)/.test(from)
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

export async function readDir(dir: string, target?: SessionFileTarget): Promise<FsEntry[]> {
  if (target) {
    const relative = sessionRelativePath(target.root, dir, true)
    await verifySessionBinding(target)
    const result = await sessionRequest<DirectoryResponse>(target.sessionId, target, { method: 'GET', path: '/workspace/directory',
      query: { sessionId: target.sessionId, path: relative || '.' }, expectedEngine: target.expectedEngine })
    assertSessionFileTarget(target)
    if (!Array.isArray(result?.entries)) throw new Error('任务目录响应无效，请升级引擎')
    return result.entries.map(entry => ({ ...entry, path: sessionAbsolutePath(target.root, sessionRelativePath(target.root, entry.path)) }))
  }
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

export async function readFile(path: string, target?: SessionFileTarget): Promise<FsFileContent> {
  if (target) {
    const relative = sessionRelativePath(target.root, path)
    await verifySessionBinding(target)
    const result = await sessionRequest<SessionContentResponse>(target.sessionId, target, { method: 'GET', path: '/workspace/file/content',
      query: { sessionId: target.sessionId, path: relative }, expectedEngine: target.expectedEngine })
    assertSessionFileTarget(target)
    return sessionFileContent(path, result)
  }
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

/**
 * Read-only local preview for a file explicitly selected by the user (native
 * picker or OS drag-and-drop).  It deliberately bypasses workspace/session
 * routing and exposes no write capability; remote engine files continue to
 * use readFile/readSessionFile with their authenticated scope.
 */
export function readExternalFile(path: string): Promise<FsFileContent> {
  if (isRemoteEngine()) return Promise.reject(new Error('远端引擎不能读取本机外部文件，请先下载后打开'))
  return bridge().fs.readExternalFile(path)
}

/**
 * Read a candidate produced by workspaceRecoveryCandidates.  Existing
 * windows may still have a preload without the newer external-file channel,
 * while the normal workspace bridge already knows how to read an opened
 * company root.  Prefer that bridge and use the explicit read-only external
 * channel only for a fresh window or a root outside the current grant.
 */
export async function readLocalRecoveryFile(path: string): Promise<FsFileContent> {
  if (isRemoteEngine()) throw new Error('远端引擎不能读取本机恢复文件')
  try {
    return await bridge().fs.readFile(path)
  } catch (workspaceError) {
    try {
      return await bridge().fs.readExternalFile(path)
    } catch {
      throw workspaceError
    }
  }
}

function windowsPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
}

/** Windows paths compare case-insensitively; POSIX recovery paths do not. */
function recoveryPathContains(parent: string, child: string): boolean {
  const from = parent.replace(/\\/g, '/').replace(/\/+$/, '')
  const to = child.replace(/\\/g, '/')
  const left = windowsPath(from) ? from.toLowerCase() : from
  const right = windowsPath(from) ? to.toLowerCase() : to
  return right === left || right.startsWith(`${left}/`)
}

function recoveryPathEqual(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\\/g, '/')
  const normalizedRight = right.replace(/\\/g, '/')
  return windowsPath(normalizedLeft)
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function filesystemRoot(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized === '' || normalized === '/' || /^[A-Za-z]:$/.test(normalized) || /^\/\/[^/]+$/.test(normalized)
}

/**
 * Return the small set of local roots that may be used to recover a Work
 * receipt after its engine session has been restored.  A Work run owns one
 * directory with `company/` outputs and `scratch/<tenant>/<session>/` engine
 * sandboxes.  The renderer may compare/read those roots only; it must never
 * turn a model supplied absolute path into an arbitrary local file grant.
 */
export function workspaceRecoveryRoots(root: string): string[] {
  const clean = root.replace(/\\/g, '/').replace(/\/+$/, '')
  // A relative root would resolve against the renderer cwd and could turn a
  // model-provided path into an arbitrary local file grant.
  if (!clean || !absolutePath(clean) || /[\u0000-\u001f\u007f]/.test(clean)) return []
  if (clean.split('/').some((part, index) => part === '.' || part === '..' || (part.includes(':') && !(index === 0 && /^[A-Za-z]:$/.test(part))))) return []
  const roots: string[] = [clean]
  const parent = paths.dirname(clean)
  // Never broaden a recovery hint to a drive/share/POSIX filesystem root.
  if (parent && parent !== clean && !filesystemRoot(parent)) roots.push(parent)

  const parts = clean.split('/').filter(Boolean)
  const scratchIndex = parts.findIndex(part => part.toLowerCase() === 'scratch')
  if (scratchIndex > 0 && scratchIndex < parts.length - 1) {
    const runRoot = parts.slice(0, scratchIndex).join('/')
    const prefix = clean.startsWith('//') ? `//${runRoot}` : clean.startsWith('/') ? `/${runRoot}` : runRoot
    roots.push(`${prefix.replace(/\\/g, '/').replace(/\/+$/, '')}/company`)
  } else {
    const companyIndex = parts.findIndex(part => part.toLowerCase() === 'company')
    if (companyIndex > 0) {
      const company = parts.slice(0, companyIndex + 1).join('/')
      roots.push(clean.startsWith('//') ? `//${company}` : clean.startsWith('/') ? `/${company}` : company)
    }
  }

  const seen = new Set<string>()
  return roots.filter(value => {
    const key = /^[A-Za-z]:/.test(value) || value.startsWith('//') ? value.toLowerCase() : value
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function absolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)
}

/**
 * Build bounded local candidates for a receipt path.  Besides the task root
 * and its parent, map `<run>/scratch/<tenant>/<session>/<file>` to
 * `<run>/company/<file>` by dropping at most three sandbox components.  The
 * fixed bound matches the engine's current scratch shape and keeps this
 * operation a read-only recovery hint rather than a filesystem search.
 */
export function workspaceRecoveryCandidates(filePath: string, workspaceRoot?: string | null): string[] {
  const clean = filePath.replace(/^path:/i, '').replace(/\\/g, '/')
  const parts = clean.split('/')
  if (!clean || /[\u0000-\u001f\u007f]/.test(clean) || parts.some((part, index) => part === '.' || part === '..' || (part.includes(':') && !(index === 0 && /^[A-Za-z]:$/.test(part))))) return []
  if (!workspaceRoot) return absolutePath(clean) ? [] : [clean]
  const roots = workspaceRecoveryRoots(workspaceRoot)
  const candidates: string[] = []
  const add = (value: string): void => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!normalized || candidates.some(existing => recoveryPathEqual(existing, normalized))) return
    candidates.push(normalized)
  }
  if (!absolutePath(clean)) {
    for (const root of roots) {
      // `paths.join('/', value)` intentionally trims the root's separator;
      // preserve it here so a POSIX parent root never yields a cwd-relative
      // recovery candidate.
      add(root === '/' ? `/${clean.replace(/^\/+/, '')}` : paths.join(root, clean))
    }
    return candidates
  }

  for (const root of roots) {
    if (recoveryPathContains(root, clean)) add(clean)
  }

  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const rootParts = normalizedRoot.split('/').filter(Boolean)
  const scratchIndex = rootParts.findIndex(part => part.toLowerCase() === 'scratch')
  if (scratchIndex > 0) {
    const runRoot = rootParts.slice(0, scratchIndex).join('/')
    const runPrefix = (normalizedRoot.startsWith('//') ? `//${runRoot}` : normalizedRoot.startsWith('/') ? `/${runRoot}` : runRoot).replace(/\/+$/, '')
    const scratchRoot = `${runPrefix}/scratch`
    if (recoveryPathContains(scratchRoot, clean)) {
      const suffix = clean.slice(scratchRoot.length).replace(/^\/+/, '').split('/').filter(Boolean)
      const companyRoot = `${runPrefix}/company`
      // Prefer the depth encoded by the persisted scratch hint.  Restored
      // Work runs may include an extra `work-home` sandbox component.
      const hintSuffix = normalizedRoot.slice(scratchRoot.length).replace(/^\/+/, '').split('/').filter(Boolean)
      const drops = hintSuffix.length >= 3 || /^work-home$/i.test(suffix[2] ?? '') ? [3, 2, 1] : [2, 1, 3]
      for (const drop of drops) {
        if (drop > Math.min(3, suffix.length - 1)) continue
        add(paths.join(companyRoot, suffix.slice(drop).join('/')))
      }
    }
  } else {
    const companyRoot = roots.find(value => /(?:^|\/)company$/i.test(value))
    const runRoot = companyRoot ? paths.dirname(companyRoot) : ''
    const scratchRoot = runRoot ? paths.join(runRoot, 'scratch') : ''
    if (scratchRoot && recoveryPathContains(scratchRoot, clean)) {
      const suffix = clean.slice(scratchRoot.length).replace(/^\/+/, '').split('/').filter(Boolean)
      const drops = /^work-home$/i.test(suffix[2] ?? '') ? [3, 2, 1] : [2, 1, 3]
      for (const drop of drops) {
        if (drop > Math.min(3, suffix.length - 1)) continue
        add(paths.join(companyRoot!, suffix.slice(drop).join('/')))
      }
    }
  }
  return candidates
}

export function isWorkspaceRecoveryPath(filePath: string, workspaceRoot?: string | null): boolean {
  if (!workspaceRoot) return false
  const clean = filePath.replace(/^path:/i, '').replace(/\\/g, '/')
  return workspaceRecoveryCandidates(clean, workspaceRoot).some(candidate => recoveryPathEqual(candidate, clean))
}

export function pickExternalFile(): Promise<string | null> {
  if (isRemoteEngine()) return Promise.reject(new Error('远端引擎不能选择本机文件'))
  return bridge().fs.pickFile()
}

async function remoteStat(context: RemoteWorkspaceContext, path: string): Promise<FsStat> {
  const result = await remoteRequest<{ isDirectory: boolean; size: number; mtime?: number; mtimeMs?: number }>(context.target, {
    method: 'GET', path: '/workspace/file/info',
    query: { ...scope(context.target), path: remoteWorkspaceRelativePath(context, path) || '.' }
  })
  if (typeof result.isDirectory !== 'boolean') throw new Error('远端文件元数据协议不兼容，请升级远端引擎')
  return { path, isDirectory: result.isDirectory, size: result.size, mtimeMs: result.mtimeMs ?? result.mtime ?? 0 }
}

export async function stat(path: string, target?: SessionFileTarget): Promise<FsStat> {
  if (target) {
    const relative = sessionRelativePath(target.root, path)
    await verifySessionBinding(target)
    const result = await sessionRequest<{ isDirectory: boolean; size: number; mtime?: number; mtimeMs?: number }>(target.sessionId, target, {
      method: 'GET', path: '/workspace/file/info', query: { sessionId: target.sessionId, path: relative }, expectedEngine: target.expectedEngine })
    assertSessionFileTarget(target)
    if (typeof result.isDirectory !== 'boolean') throw new Error('任务文件元数据协议不兼容，请升级引擎')
    return { path, isDirectory: result.isDirectory, size: result.size, mtimeMs: result.mtimeMs ?? result.mtime ?? 0 }
  }
  if (!isRemoteEngine()) return bridge().fs.stat(path)
  return remoteStat(await remoteWorkspaceContext(), path)
}
export async function writeFile(path: string, content: string, target?: SessionFileTarget): Promise<FsStat> {
  if (target) {
    const relative = sessionRelativePath(target.root, path)
    await verifySessionBinding(target)
    await sessionRequest(target.sessionId, target, { method: 'POST', path: '/workspace/file',
      body: { sessionId: target.sessionId, path: relative, content }, expectedEngine: target.expectedEngine })
    assertSessionFileTarget(target)
    const result = await sessionRequest<{ isDirectory: boolean; size: number; mtime?: number; mtimeMs?: number }>(target.sessionId, target, {
      method: 'GET', path: '/workspace/file/info', query: { sessionId: target.sessionId, path: relative }, expectedEngine: target.expectedEngine })
    assertSessionFileTarget(target)
    if (typeof result.isDirectory !== 'boolean') throw new Error('任务文件元数据协议不兼容，请升级引擎')
    return { path, isDirectory: result.isDirectory, size: result.size, mtimeMs: result.mtimeMs ?? result.mtime ?? 0 }
  }
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
  let relative = `${ATTACHMENTS_DIRECTORY}/${safeName}`

  // Keep the same no-overwrite contract as the local attachment bridge. A
  // failed existence probe is only treated as "missing" for the server's
  // explicit not-found response; connection/protocol errors must surface.
  for (let index = 1; index <= 1000; index += 1) {
    try {
      await remoteStat(context, paths.join(context.root, relative))
      relative = `${ATTACHMENTS_DIRECTORY}/${stem}-${index}${extension}`
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
    // Windows paths are case-insensitive even when the engine serializes
    // one side with a different casing.  Keep POSIX comparisons strict.
    const windows = /^(?:[A-Za-z]:(?:\/|$)|\/\/)/.test(from)
    const a = windows ? from.toLowerCase() : from
    const b = windows ? to.toLowerCase() : to
    return b === a || b.startsWith(`${a}/`)
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
