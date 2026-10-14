import type { EngineRequestInput } from '@shared/ipc'
import { request, requestOrThrow } from '../engine/client'
import type { GitResult } from '@shared/git-types'
import {
  assertEngineSource,
  getEngineSource,
  getExpectedEngine,
  isRemoteEngine
} from '../engine/source'
import {
  assertWorkspaceTarget,
  captureWorkspaceTarget,
  type WorkspaceTarget
} from '../workspace/connection'
import { remoteWorkspaceContext, remoteWorkspaceRelativePath } from '../workspace/fs-client'
import { utilityChat, type UtilityChatInput } from '../engine/utility-chat'

type EngineIdentity = NonNullable<EngineRequestInput['expectedEngine']>
export interface GitTarget {
  readonly source: number
  readonly expectedEngine: Readonly<EngineIdentity>
  readonly sessionId: string
  readonly root: string
  readonly bindingEpoch: string
  readonly cwd: string
  readonly route: 'local' | 'session'
  readonly key: string
}
const owned = new WeakMap<GitTarget, { code?: WorkspaceTarget }>()
const changed = (): Error => new Error('Git 连接或任务已变化，请在当前任务重试')

/** Non-200 business envelopes retain their typed replay disposition. */
export class GitRequestError extends Error {
  constructor(readonly failure: Readonly<GitResult>) { super(failure.error || 'Git 请求失败'); this.name = 'GitRequestError' }
}
export function gitFailure(value: unknown, message = 'Git 操作失败'): GitResult {
  if (value instanceof GitRequestError) return { ...value.failure }
  const item = value && typeof value === 'object' ? value as Partial<GitResult> : undefined
  const codes: ReadonlyArray<GitResult['errorCode']> = ['ssh-passphrase', 'divergent', 'clone-cancelled', 'git-busy', 'git-orphan', 'git-quarantined']
  return { success: false, error: typeof item?.error === 'string' ? item.error : value instanceof Error ? value.message : message,
    ...(item?.executionDisposition === 'not_started' || item?.executionDisposition === 'may_have_effects'
      ? { executionDisposition: item.executionDisposition } : {}),
    ...(item?.errorCode && codes.includes(item.errorCode) ? { errorCode: item.errorCode } : {}) }
}

function capture(): { source: number; expectedEngine: Readonly<EngineIdentity> } {
  return { source: getEngineSource(), expectedEngine: Object.freeze({ ...getExpectedEngine() }) }
}
function register(value: Omit<GitTarget, 'key'>, code?: WorkspaceTarget): GitTarget {
  const target = Object.freeze({
    ...value,
    key: JSON.stringify([
      value.source,
      value.expectedEngine,
      value.route,
      value.sessionId,
      value.root,
      value.bindingEpoch,
      value.cwd
    ])
  })
  owned.set(target, { code })
  return target
}
export function assertGitTarget(target: GitTarget): void {
  const owner = owned.get(target)
  if (
    !owner ||
    target.source !== getEngineSource() ||
    JSON.stringify(target.expectedEngine) !== JSON.stringify(getExpectedEngine())
  )
    throw changed()
  // Embedded Code Git works before the AI engine is ready; its authorization
  // still belongs to the main process allow-list, never to this renderer object.
  if (target.route === 'session') assertEngineSource(target.source)
  if (owner.code) assertWorkspaceTarget(owner.code)
}
function relative(root: string, path: string, rootAllowed = false): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const candidate = path.replace(/\\/g, '/')
  const windows = /^(?:[A-Za-z]:\/|\/\/)/.test(base)
  const compare = (value: string): string => (windows ? value.toLowerCase() : value)
  let result = candidate
  if (compare(candidate) === compare(base) || compare(candidate).startsWith(`${compare(base)}/`))
    result = candidate.slice(base.length).replace(/^\/+/, '')
  else if (/^(?:[A-Za-z]:|\/)/.test(candidate)) throw new Error('Git 目录不属于当前任务工作区')
  if (!result && rootAllowed) return '.'
  if (
    !result ||
    result
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f:]/.test(part))
  )
    throw new Error('Git 路径无效')
  return result
}
export function gitFilePath(path: string): string {
  const candidate = path.replace(/\\/g, '/')
  if (
    /^(?:[A-Za-z]:|\/)/.test(candidate) ||
    !candidate ||
    candidate
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f:]/.test(part))
  )
    throw new Error('Git 文件必须是工作区内相对路径')
  return candidate
}
async function binding(sessionId: string, identity: ReturnType<typeof capture>): Promise<{ root: string; epoch: string }> {
  assertEngineSource(identity.source)
  const result = await requestOrThrow<{ root: string; epoch: string; contractVersion: number; mutationRequiresBinding: boolean }>({
    method: 'GET',
    path: '/git/binding',
    query: { sessionId },
    expectedEngine: identity.expectedEngine,
    toolProfile: 'general'
  })
  assertEngineSource(identity.source)
  const root = result?.root
  if (
    typeof root !== 'string' ||
    !/^(?:\/|\\\\|[A-Za-z]:[\\/])/.test(root) ||
    /[\u0000-\u001f\u007f]/.test(root) ||
    root
      .replace(/\\/g, '/')
      .split('/')
      .some((part) => part === '.' || part === '..')
  )
    throw new Error('引擎未提供有效任务工作区')
  if (result.contractVersion !== 2 || result.mutationRequiresBinding !== true || typeof result.epoch !== 'string' || !result.epoch || result.epoch.length > 128)
    throw new Error('引擎尚不支持安全 Git 工作区绑定，请升级引擎后重试')
  return { root, epoch: result.epoch }
}
/** Work always uses the engine's authenticated session resolver, including
 * generated embedded scratch roots outside the local IDE allow-list. */
export async function captureSessionGitTarget(sessionId: string, cwd: string): Promise<GitTarget> {
  const identity = capture()
  const id = sessionId.trim()
  if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id))
    throw new Error('Git 任务会话无效')
  const { root, epoch } = await binding(id, identity)
  const target = register({
    ...identity,
    sessionId: id,
    root,
    bindingEpoch: epoch,
    cwd: relative(root, cwd, true),
    route: 'session'
  })
  assertGitTarget(target)
  return target
}
/** Compatibility adapter for Code's existing API. No Work global override. */
export async function captureCodeGitTarget(cwd?: string): Promise<GitTarget> {
  const identity = capture()
  if (!isRemoteEngine()) {
    if (!cwd) throw new Error('本地 Git 目录无效')
    return register({ ...identity, sessionId: '', root: '', bindingEpoch: '', cwd, route: 'local' })
  }
  const code = captureWorkspaceTarget()
  const context = await remoteWorkspaceContext()
  const snapshot = await binding(code.sessionId, identity)
  if (snapshot.root !== context.root) throw new Error('Code Git 工作区已变化，请刷新后重试')
  assertWorkspaceTarget(code)
  const target = register(
    {
      ...identity,
      sessionId: code.sessionId,
      root: context.root,
      bindingEpoch: snapshot.epoch,
      cwd: remoteWorkspaceRelativePath(context, cwd ?? context.root) || '.',
      route: 'session'
    },
    code
  )
  assertGitTarget(target)
  return target
}
async function verifyBinding(target: GitTarget): Promise<void> {
  assertGitTarget(target)
  if (target.route === 'session') {
    const snapshot = await binding(target.sessionId, target)
    if (snapshot.root !== target.root || snapshot.epoch !== target.bindingEpoch)
      throw new Error('任务 Git 工作区已重新绑定，请重新打开面板')
  }
  assertGitTarget(target)
}
async function scopedRequest<T>(target: GitTarget, input: EngineRequestInput): Promise<T> {
  await verifyBinding(target)
  const result = await request<T>({
    ...input,
    expectedEngine: target.expectedEngine,
    toolProfile: owned.get(target)?.code ? 'code' : 'general'
  })
  await verifyBinding(target)
  if (!result.ok) throw new GitRequestError(Object.freeze(gitFailure(result.data, result.message || 'Git 请求失败')))
  return result.data as T
}
export function gitRead<T>(
  target: GitTarget,
  op: string,
  query: Record<string, string | undefined> = {}
): Promise<T> {
  return scopedRequest<T>(target, {
    method: 'GET',
    path: `/git/${op}`,
    query: { ...query, sessionId: target.sessionId, cwd: target.cwd, expectedRoot: target.root, bindingEpoch: target.bindingEpoch }
  })
}
export function gitAction<T>(
  target: GitTarget,
  op: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const normalized = { ...payload }
  if (typeof normalized.path === 'string') normalized.path = gitFilePath(normalized.path)
  if (Array.isArray(normalized.paths))
    normalized.paths = normalized.paths.map((value) => gitFilePath(String(value)))
  return scopedRequest<T>(target, {
    method: 'POST',
    path: '/git/action',
    body: { ...normalized, sessionId: target.sessionId, cwd: target.cwd, expectedRoot: target.root, bindingEpoch: target.bindingEpoch, op }
  })
}
export async function gitLocal<T>(
  target: GitTarget,
  action: (git: Window['aether']['git']) => Promise<T>
): Promise<T> {
  assertGitTarget(target)
  if (target.route !== 'local') throw new Error('任务 Git 不可使用本地 IPC')
  if (!window.aether) throw new Error('IPC 桥未就绪：preload 未加载')
  const result = await action(window.aether.git)
  assertGitTarget(target)
  return result
}
export async function gitUtilityChat(
  target: GitTarget,
  input: UtilityChatInput
): Promise<{ text: string }> {
  await verifyBinding(target)
  const result = await utilityChat({ ...input, expectedEngine: target.expectedEngine })
  await verifyBinding(target)
  return result
}
