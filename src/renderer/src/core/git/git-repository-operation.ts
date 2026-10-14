import type { GitLeaseState, GitResult } from '@shared/git-types'
import { createGitClient, type ScopedGitClient } from './git-client'
import { assertGitTarget, gitFailure, type GitTarget } from './git-target'

export interface GitRepositorySnapshot {
  readonly label: string
  readonly phase: 'running' | 'failed' | 'succeeded'
  readonly pending: 'run' | 'check' | 'recover' | 'retry' | null
  readonly failure?: Readonly<GitResult>
  readonly lease?: Readonly<GitLeaseState>
  readonly actionError?: string
  readonly recovered: boolean
  readonly retryAllowed: boolean
}
export interface GitRepositoryOperation {
  readonly target: GitTarget
  getSnapshot(): GitRepositorySnapshot
  subscribe(listener: () => void): () => void
  start(): Promise<GitResult>
  inspect(): Promise<void>
  recover(): Promise<void>
  retry(): Promise<GitResult>
}

/** The original target and command are captured once. Recovery proves closure,
 * while only an explicit not_started result can authorise replay of that command. */
export function createRepositoryOperation(input: {
  target: GitTarget
  label: string
  run(client: ScopedGitClient): Promise<GitResult>
  assertCurrent?: () => void
  onSuccess?: () => void | Promise<void>
}): GitRepositoryOperation {
  const { target, label, run, assertCurrent, onSuccess } = input
  const client = createGitClient(target), listeners = new Set<() => void>()
  let started = false
  let state: GitRepositorySnapshot = Object.freeze({ label, phase: 'running', pending: null, recovered: false, retryAllowed: false })
  const current = (): void => { assertGitTarget(target); assertCurrent?.() }
  const update = (patch: Partial<GitRepositorySnapshot>): void => {
    const next = { ...state, ...patch }
    next.retryAllowed = next.phase === 'failed' && !next.pending && next.failure?.executionDisposition === 'not_started'
      && next.lease?.busy === false && !next.actionError
    state = Object.freeze(next)
    for (const listener of listeners) { try { listener() } catch { /* Rendering cannot own the operation. */ } }
  }
  const leaseOf = (value: GitLeaseState | undefined): Readonly<GitLeaseState> => {
    if (!value || typeof value.busy !== 'boolean' || typeof value.recoverable !== 'boolean'
      || value.recoverable && (!value.busy || typeof value.generation !== 'string' || !value.generation))
      throw new Error('未获得可验证的 Git 占用状态，请重新核对')
    return Object.freeze({ busy: value.busy, recoverable: value.recoverable,
      ...(typeof value.generation === 'string' ? { generation: value.generation } : {}),
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) })
  }
  const inspect = async (): Promise<void> => {
    if (state.pending || state.phase !== 'failed') return
    update({ pending: 'check', actionError: undefined })
    try {
      current(); const result = await client.gitLeaseStatus(); current()
      if (!result.success) throw new Error(result.error || '核对 Git 占用失败')
      update({ lease: leaseOf(result.lease) })
    } catch (error) { update({ lease: undefined, actionError: gitFailure(error).error }) }
    finally { update({ pending: null }) }
  }
  const execute = async (pending: 'run' | 'retry'): Promise<GitResult> => {
    update({ pending, actionError: undefined, lease: undefined })
    let result: GitResult
    try {
      current(); result = await run(client); current()
      if (!result || typeof result !== 'object' || typeof result.success !== 'boolean')
        throw new Error('Git 返回了无效结果，请核对仓库状态')
    }
    catch (error) { result = gitFailure(error) }
    if (result.success) {
      update({ phase: 'succeeded', failure: undefined, recovered: false })
      // A failed refresh does not make the already completed mutation replay-safe.
      try { current(); await onSuccess?.() }
      catch (error) { update({ actionError: '操作已完成，刷新失败：' + (gitFailure(error).error || '') }) }
    } else update({ phase: 'failed', failure: Object.freeze(gitFailure(result)), recovered: false })
    update({ pending: null })
    if (!result.success) await inspect()
    return result
  }
  const operation: GitRepositoryOperation = {
    target, getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: async () => {
      if (started) return gitFailure(undefined, '这项操作已经执行过，请核对结果')
      started = true; return execute('run')
    },
    inspect,
    recover: async () => {
      const generation = state.lease?.generation
      if (state.pending || state.phase !== 'failed' || !state.lease?.recoverable || !generation) return
      update({ pending: 'recover', actionError: undefined })
      try {
        current(); const result = await client.gitRecoverLease(generation); current()
        if (!result.success) throw new Error(result.error || '恢复中断占用失败')
        const lease = leaseOf(result.lease)
        if (lease.busy) throw new Error('Git 占用尚未解除，请重新核对')
        update({ lease, recovered: true })
      } catch (error) { update({ lease: undefined, actionError: gitFailure(error).error }) }
      finally { update({ pending: null }) }
    },
    retry: async () => {
      if (!state.retryAllowed) return gitFailure(undefined, '尚未确认操作未开始，不能重复执行')
      await inspect()
      if (!state.retryAllowed) return gitFailure(undefined, 'Git 状态已变化，请重新核对')
      return execute('retry')
    },
  }
  return Object.freeze(operation)
}

/** All current scoped Git methods return a Result. Clone argument values before
 * queueing so a retry never reads a later draft, selection, or mutable path list. */
export function captureGitCommand<K extends keyof ScopedGitClient>(method: K, ...args: Parameters<ScopedGitClient[K]>): (client: ScopedGitClient) => Promise<GitResult> {
  const captured = structuredClone(args)
  return client => {
    const run = client[method] as (...parameters: Parameters<ScopedGitClient[K]>) => Promise<GitResult>
    return run(...structuredClone(captured))
  }
}
