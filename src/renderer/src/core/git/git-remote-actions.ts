/**
 * 远程操作编排（移植自 wuzu-client utils/gitRemoteActions.ts）
 *
 * 纯逻辑，不碰任何 UI：交互（SSH 口令、合并方式选择）经 RemoteDialogs 注入，
 * 由 UI 层（任务 3 的 GitView 等）提供实现。执行远程操作；交互重试前核对
 * 项目与分支，避免把后续命令发到新工作区。
 */
import type { GitResult } from '@shared/git-types'

export type GitRemoteAction = 'sync' | 'pull' | 'pullRebase' | 'push' | 'fetch' | 'publish'

/** 本模块消费的最小 git store 切面（aether 单例 git-store 的同名动作） */
export interface GitRemoteStore {
  cwd: string
  branch: string
  upstream: string | null
  sync: () => Promise<GitResult>
  pull: () => Promise<GitResult>
  pullRebase: () => Promise<GitResult>
  push: () => Promise<GitResult>
  publishBranch: () => Promise<GitResult>
  fetchRemote: () => Promise<GitResult>
  pullMerge: (remember: boolean) => Promise<GitResult>
  pullRebaseWithChoice: (remember: boolean) => Promise<GitResult>
  addSshKey: (passphrase: string) => Promise<GitResult>
}

interface RemoteDialogs {
  requestSshPassphrase: () => Promise<string | null>
  choosePullStrategy: () => Promise<'merge' | 'rebase' | null>
}

/** 执行远程操作；交互重试前核对项目与分支，避免把后续命令发到新工作区。 */
export async function runGitRemoteAction(
  store: GitRemoteStore,
  action: GitRemoteAction,
  dialogs: RemoteDialogs
): Promise<GitResult | null> {
  const cwd = store.cwd
  const branch = store.branch
  const isCurrent = (): boolean => store.cwd === cwd && store.branch === branch
  const contextChanged = (): GitResult => ({
    success: false,
    error: '当前项目或分支已切换，已停止后续 Git 操作'
  })

  const withSshRetry = async (run: () => Promise<GitResult>): Promise<GitResult | null> => {
    if (!isCurrent()) return contextChanged()
    const result = await run()
    if (result.success || result.errorCode !== 'ssh-passphrase') return result
    const passphrase = await dialogs.requestSshPassphrase()
    if (passphrase === null) return null
    if (!isCurrent()) return contextChanged()
    const loaded = await store.addSshKey(passphrase)
    if (!loaded.success) return loaded
    return isCurrent() ? run() : contextChanged()
  }

  // 首次发布显式设置上游，不依赖用户的 push.default 配置，也不先执行 pull。
  const commands: Record<GitRemoteAction, () => Promise<GitResult>> = {
    sync: () => (store.upstream ? store.sync() : store.publishBranch()),
    pull: () => store.pull(),
    pullRebase: () => store.pullRebase(),
    push: () => store.push(),
    fetch: () => store.fetchRemote(),
    publish: () => store.publishBranch()
  }
  const result = await withSshRetry(commands[action])
  if (
    !result ||
    result.success ||
    result.errorCode !== 'divergent' ||
    (action !== 'sync' && action !== 'pull')
  ) {
    return result
  }
  if (!isCurrent()) return contextChanged()
  const strategy = await dialogs.choosePullStrategy()
  if (!strategy) return null
  const pulled = await withSshRetry(() =>
    strategy === 'rebase' ? store.pullRebaseWithChoice(true) : store.pullMerge(true)
  )
  if (!pulled?.success || action === 'pull') return pulled
  // 同步在解决分叉后还需推送；失败或取消拉取时绝不继续推送。
  return withSshRetry(() => store.push())
}
