/** Shared task-scoped transport; legacy Code exports retain their signatures. */
import type {
  GitBlameResult,
  GitBranchInfoResult,
  GitBranchListResult,
  GitCloneOptions,
  GitCloneProgressPayload,
  GitCloneResult,
  GitCommitInfoResult,
  GitDiffResult,
  GitDivergenceResult,
  GitFileChange,
  GitFileDiff,
  GitFileHistoryResult,
  GitHeadFileResult,
  GitIgnoreCheckResult,
  GitLogQuery,
  GitLogResult,
  GitLeaseResult,
  GitRemoteBranchListResult,
  GitRemoteListResult,
  GitResult,
  GitStashListResult,
  GitStatusResult,
  GitSuggestMessageResult,
  GitTagListResult,
  GitUserListResult,
  GitUserResult
} from '@shared/git-types'
import { isRemoteEngine } from '../engine/source'
import {
  captureCodeGitTarget,
  gitRead,
  gitAction,
  gitLocal,
  gitFilePath,
  type GitTarget
} from './git-target'
const REMOTE_COMMIT_CONTEXT_LIMIT = 12_000
const REMOTE_COMMIT_FILE_DIFF_LIMIT = 2_000
const REMOTE_COMMIT_MAX_FILES = 80

function changeLabel(change: GitFileChange): string {
  if (change.stagedChange) return change.stagedChange
  return change.unstagedChange ?? change.changeType
}

function formatRemoteDiff(change: GitFileChange, diff: GitFileDiff | undefined): string {
  if (!diff) return ''
  if (diff.binary || change.binary) return `diff --binary ${change.path}`

  const lines: string[] = [`diff --git a/${change.path} b/${change.path}`]
  for (const hunk of diff.hunks) {
    const heading = hunk.heading ? ` ${hunk.heading}` : ''
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${heading}`
    )
    for (const line of hunk.lines) {
      const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '
      lines.push(`${prefix}${line.content}`)
    }
  }

  // An untracked file has no git hunk yet, but the remote endpoint still returns its
  // current contents. Include a short addition preview so a single new file does not
  // produce an empty-looking AI context.
  if (diff.hunks.length === 0 && changeLabel(change) === 'untracked' && diff.newContent) {
    lines.push(
      ...diff.newContent
        .split(/\r?\n/)
        .slice(0, 120)
        .map((line) => `+${line}`)
    )
  }
  return lines.join('\n').slice(0, REMOTE_COMMIT_FILE_DIFF_LIMIT)
}

/** Build a bounded, deterministic context for the commit-message utility model. */
export function buildRemoteCommitAiContext(
  files: GitFileChange[],
  diffs: Array<{ change: GitFileChange; diff?: GitFileDiff }>,
  staged: boolean
): string {
  const visibleFiles = files.slice(0, REMOTE_COMMIT_MAX_FILES)
  const status = visibleFiles.map((file) => `${changeLabel(file)}\t${file.path}`).join('\n')
  const stats = diffs
    .map(({ change, diff }) => {
      const additions =
        diff?.hunks.reduce(
          (total, hunk) => total + hunk.lines.filter((line) => line.type === 'add').length,
          0
        ) ?? change.additions
      const deletions =
        diff?.hunks.reduce(
          (total, hunk) => total + hunk.lines.filter((line) => line.type === 'delete').length,
          0
        ) ?? change.deletions
      return `${additions}\t${deletions}\t${change.path}`
    })
    .join('\n')
  const diffText = diffs
    .map(({ change, diff }) => formatRemoteDiff(change, diff))
    .filter(Boolean)
    .join('\n\n')

  const sections = [`${staged ? '【暂存区文件状态】' : '【文件状态】'}\n${status}`]
  if (stats) sections.push(`【逐文件行数】\n${stats}`)
  if (diffText) sections.push(`【diff 片段】\n${diffText}`)
  const context = sections.join('\n\n')
  if (context.length <= REMOTE_COMMIT_CONTEXT_LIMIT) return context
  const marker = '\n...（diff 中间片段已省略，完整范围见文件清单）...\n'
  const available = Math.max(0, REMOTE_COMMIT_CONTEXT_LIMIT - marker.length)
  const headLength = Math.ceil(available / 2)
  const tailLength = Math.floor(available / 2)
  return `${context.slice(0, headLength)}${marker}${context.slice(-tailLength)}`
}

export function createGitClient(target: GitTarget) {
  async function gitSuggestCommitMessage(): Promise<GitSuggestMessageResult> {
    if (target.route === 'local')
      return gitLocal(target, (api) => api.suggestCommitMessage(target.cwd))
    const result = await gitAction<GitSuggestMessageResult>(target, 'suggest-message')
    if (!result.success || result.aiContext?.trim()) return result
    // Every enrichment read belongs to this original target. Transport errors,
    // including source/root changes, must remain errors rather than a fallback.
    const status = await client.gitStatus()
    if (!status.success) throw new Error(status.error || '读取提交上下文失败')
    const stagedFiles = (status.files ?? []).filter((file) => Boolean(file.stagedChange))
    const staged = stagedFiles.length > 0
    const candidates = (staged ? stagedFiles : (status.files ?? [])).slice(
      0,
      REMOTE_COMMIT_MAX_FILES
    )
    const diffs: Array<{ change: GitFileChange; diff?: GitFileDiff }> = []
    // The server holds the task binding and physical index through each read;
    // bounded serial collection avoids launching dozens of queued leases.
    for (const change of candidates) {
        const diff = await client.gitDiff(change.path, staged)
        if (!diff.success) throw new Error(diff.error || '读取提交差异失败')
        diffs.push({ change, diff: diff.diff })
    }
    const aiContext = buildRemoteCommitAiContext(candidates, diffs, staged)
    return aiContext ? { ...result, aiContext } : result
  }

  const client = {
    gitLeaseStatus: (): Promise<GitLeaseResult> =>
      target.route === 'session'
        ? gitRead<GitLeaseResult>(target, 'lease')
        : gitLocal(target, api => api.leaseStatus(target.cwd)),
    gitRecoverLease: (generation: string): Promise<GitLeaseResult> =>
      target.route === 'session'
        ? gitAction<GitLeaseResult>(target, 'recover-lease', { generation })
        : gitLocal(target, api => api.recoverLease(target.cwd, generation)),
    gitInit: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'init')
        : gitLocal(target, (api) => api.init(target.cwd)),
    gitStatus: (): Promise<GitStatusResult> =>
      target.route === 'session'
        ? gitRead<GitStatusResult>(target, 'status')
        : gitLocal(target, (api) => api.status(target.cwd)),
    gitDiff: (path: string, staged: boolean, base?: 'index' | 'head'): Promise<GitDiffResult> =>
      target.route === 'session'
        ? gitRead<GitDiffResult>(target, 'diff', {
            path: gitFilePath(path),
            staged: String(staged),
            ...(base ? { base } : {})
          })
        : gitLocal(target, (api) => api.diff(target.cwd, path, staged, base)),
    gitBranchInfo: (): Promise<GitBranchInfoResult> =>
      target.route === 'session'
        ? gitRead<GitBranchInfoResult>(target, 'branch-info')
        : gitLocal(target, (api) => api.branchInfo(target.cwd)),
    gitStage: (path: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'stage', { path })
        : gitLocal(target, (api) => api.stage(target.cwd, path)),
    gitUnstage: (path: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'unstage', { path })
        : gitLocal(target, (api) => api.unstage(target.cwd, path)),
    gitDiscardFile: (path: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'discard-file', { path })
        : gitLocal(target, (api) => api.discardFile(target.cwd, path)),
    gitDiscardWorktree: (path: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'discard-worktree', { path })
        : gitLocal(target, (api) => api.discardWorktree(target.cwd, path)),
    gitDiscardWorktreeFiles: (paths: string[]): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'discard-worktree-files', { paths })
        : gitLocal(target, (api) => api.discardWorktreeFiles(target.cwd, paths)),
    gitStageFiles: (paths: string[]): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'stage-files', { paths })
        : gitLocal(target, (api) => api.stageFiles(target.cwd, paths)),
    gitCheckIgnored: (paths: string[]): Promise<GitIgnoreCheckResult> =>
      target.route === 'session'
        ? gitAction(target, 'check-ignored', { paths })
        : gitLocal(target, (api) => api.checkIgnored(target.cwd, paths)),
    gitUnstageFiles: (paths: string[]): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'unstage-files', { paths })
        : gitLocal(target, (api) => api.unstageFiles(target.cwd, paths)),
    gitDiscardFiles: (paths: string[]): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'discard-files', { paths })
        : gitLocal(target, (api) => api.discardFiles(target.cwd, paths)),
    gitDiscardHunk: (path: string, hunkId: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'discard-hunk', { path, hunkId })
        : gitLocal(target, (api) => api.discardHunk(target.cwd, path, hunkId)),
    gitHeadFile: (path: string): Promise<GitHeadFileResult> =>
      target.route === 'session'
        ? gitRead<GitHeadFileResult>(target, 'head-file', { path: gitFilePath(path) })
        : gitLocal(target, (api) => api.headFile(target.cwd, path)),
    gitGetHeadFile: (path: string): Promise<GitHeadFileResult> =>
      target.route === 'session'
        ? gitRead<GitHeadFileResult>(target, 'head-file-content', { path: gitFilePath(path) })
        : gitLocal(target, (api) => api.getHeadFile(target.cwd, path)),
    gitCommit: (message: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'commit', { message })
        : gitLocal(target, (api) => api.commit(target.cwd, message)),
    gitStageAllAndCommit: (message: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'stage-all-commit', { message })
        : gitLocal(target, (api) => api.stageAllAndCommit(target.cwd, message)),
    gitAppendGitignore: (path: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'append-gitignore', { path })
        : gitLocal(target, (api) => api.appendGitignore(target.cwd, path)),
    gitCommitAmend: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'commit-amend')
        : gitLocal(target, (api) => api.commitAmend(target.cwd)),
    gitCommitAmendWithMessage: (message: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'commit-amend-message', { message })
        : gitLocal(target, (api) => api.commitAmendWithMessage(target.cwd, message)),
    gitUndoCommit: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'undo-commit')
        : gitLocal(target, (api) => api.undoCommit(target.cwd)),
    gitCommitEmpty: (message: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'commit-empty', { message })
        : gitLocal(target, (api) => api.commitEmpty(target.cwd, message)),
    gitFetch: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'fetch')
        : gitLocal(target, (api) => api.fetch(target.cwd)),
    gitPull: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'pull')
        : gitLocal(target, (api) => api.pull(target.cwd)),
    gitPush: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'push')
        : gitLocal(target, (api) => api.push(target.cwd)),
    gitDivergence: (): Promise<GitDivergenceResult> =>
      target.route === 'session'
        ? gitRead<GitDivergenceResult>(target, 'divergence')
        : gitLocal(target, (api) => api.divergence(target.cwd)),
    gitPullMerge: (remember: boolean): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'pull-merge', { remember })
        : gitLocal(target, (api) => api.pullMerge(target.cwd, remember)),
    gitPullRebaseWithChoice: (remember: boolean): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'pull-rebase', { remember })
        : gitLocal(target, (api) => api.pullRebaseWithChoice(target.cwd, remember)),
    gitPullRebase: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'pull-rebase')
        : gitLocal(target, (api) => api.pullRebase(target.cwd)),
    gitSync: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'sync')
        : gitLocal(target, (api) => api.sync(target.cwd)),
    gitPushForce: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'push-force')
        : gitLocal(target, (api) => api.pushForce(target.cwd)),
    gitPushTags: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'push-tags')
        : gitLocal(target, (api) => api.pushTags(target.cwd)),
    gitPushTag: (name: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'push-tag', { name })
        : gitLocal(target, (api) => api.pushTag(target.cwd, name)),
    gitPullFrom: (remote: string, branch: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'pull-from', { remote, branch })
        : gitLocal(target, (api) => api.pullFrom(target.cwd, remote, branch)),
    gitPushTo: (remote: string, branch?: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'push-to', { remote, branch })
        : gitLocal(target, (api) => api.pushTo(target.cwd, remote, branch)),
    gitListRemoteBranches: (): Promise<GitRemoteBranchListResult> =>
      target.route === 'session'
        ? gitRead<GitRemoteBranchListResult>(target, 'list-remote-branches')
        : gitLocal(target, (api) => api.listRemoteBranches(target.cwd)),
    gitDeleteRemoteBranch: (remote: string, branch: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'delete-remote-branch', { remote, branch })
        : gitLocal(target, (api) => api.deleteRemoteBranch(target.cwd, remote, branch)),
    gitDeleteRemoteTag: (name: string, remote?: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'delete-remote-tag', { name, remote })
        : gitLocal(target, (api) => api.deleteRemoteTag(target.cwd, name, remote)),
    gitListRemotes: (): Promise<GitRemoteListResult> =>
      target.route === 'session'
        ? gitRead<GitRemoteListResult>(target, 'list-remotes')
        : gitLocal(target, (api) => api.listRemotes(target.cwd)),
    gitAddRemote: (name: string, url: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'add-remote', { name, url })
        : gitLocal(target, (api) => api.addRemote(target.cwd, name, url)),
    gitRemoveRemote: (name: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'remove-remote', { name })
        : gitLocal(target, (api) => api.removeRemote(target.cwd, name)),
    gitListBranches: (): Promise<GitBranchListResult> =>
      target.route === 'session'
        ? gitRead<GitBranchListResult>(target, 'list-branches')
        : gitLocal(target, (api) => api.listBranches(target.cwd)),
    gitCheckout: (branch: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'checkout', { branch })
        : gitLocal(target, (api) => api.checkout(target.cwd, branch)),
    gitCreateBranch: (name: string, startPoint?: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'create-branch', { branch: name, ref: startPoint })
        : gitLocal(target, (api) => api.createBranch(target.cwd, name, startPoint)),
    gitDeleteBranch: (name: string, force?: boolean): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'delete-branch', { branch: name, force })
        : gitLocal(target, (api) => api.deleteBranch(target.cwd, name, force)),
    gitRenameBranch: (oldName: string, newName: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'rename-branch', { oldName, newName })
        : gitLocal(target, (api) => api.renameBranch(target.cwd, oldName, newName)),
    gitPublishBranch: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'publish-branch')
        : gitLocal(target, (api) => api.publishBranch(target.cwd)),
    gitMerge: (ref: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'merge', { ref })
        : gitLocal(target, (api) => api.merge(target.cwd, ref)),
    gitMergeAbort: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'merge-abort')
        : gitLocal(target, (api) => api.mergeAbort(target.cwd)),
    gitRebase: (ref: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'rebase', { ref })
        : gitLocal(target, (api) => api.rebase(target.cwd, ref)),
    gitRebaseAbort: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'rebase-abort')
        : gitLocal(target, (api) => api.rebaseAbort(target.cwd)),
    gitCherryPick: (hash: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'cherry-pick', { hash })
        : gitLocal(target, (api) => api.cherryPick(target.cwd, hash)),
    gitCherryPickAbort: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'cherry-pick-abort')
        : gitLocal(target, (api) => api.cherryPickAbort(target.cwd)),
    gitRevertCommit: (hash: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'revert-commit', { hash })
        : gitLocal(target, (api) => api.revertCommit(target.cwd, hash)),
    gitListStashes: (): Promise<GitStashListResult> =>
      target.route === 'session'
        ? gitRead<GitStashListResult>(target, 'list-stashes')
        : gitLocal(target, (api) => api.listStashes(target.cwd)),
    gitStashPush: (message?: string, includeUntracked?: boolean): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'stash-push', { message, includeUntracked })
        : gitLocal(target, (api) => api.stashPush(target.cwd, message, includeUntracked)),
    gitStashPushStaged: (message?: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'stash-push-staged', { message })
        : gitLocal(target, (api) => api.stashPushStaged(target.cwd, message)),
    gitStashPop: (index?: number): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'stash-pop', { index })
        : gitLocal(target, (api) => api.stashPop(target.cwd, index)),
    gitStashApply: (index?: number): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'stash-apply', { index })
        : gitLocal(target, (api) => api.stashApply(target.cwd, index)),
    gitStashDrop: (index: number): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'stash-drop', { index })
        : gitLocal(target, (api) => api.stashDrop(target.cwd, index)),
    gitStashDropBatch: (indexes: number[]): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'stash-drop-batch', { indexes })
        : gitLocal(target, (api) => api.stashDropBatch(target.cwd, indexes)),
    gitStashClear: (): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'stash-clear')
        : gitLocal(target, (api) => api.stashClear(target.cwd)),
    gitStashShow: (index: number): Promise<GitHeadFileResult> =>
      target.route === 'session'
        ? gitRead<GitHeadFileResult>(target, 'stash-show', { index: String(index) })
        : gitLocal(target, (api) => api.stashShow(target.cwd, index)),
    gitStashShowFiles: (index: number): Promise<GitHeadFileResult> =>
      target.route === 'session'
        ? gitRead<GitHeadFileResult>(target, 'stash-show-files', { index: String(index) })
        : gitLocal(target, (api) => api.stashShowFiles(target.cwd, index)),
    gitListTags: (): Promise<GitTagListResult> =>
      target.route === 'session'
        ? gitRead<GitTagListResult>(target, 'list-tags')
        : gitLocal(target, (api) => api.listTags(target.cwd)),
    gitCreateTag: (name: string, message?: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'create-tag', { name, message })
        : gitLocal(target, (api) => api.createTag(target.cwd, name, message)),
    gitDeleteTag: (name: string): Promise<GitResult> =>
      target.route === 'session'
        ? gitAction(target, 'delete-tag', { name })
        : gitLocal(target, (api) => api.deleteTag(target.cwd, name)),
    gitLog: (limit?: number, skip?: number, query?: GitLogQuery): Promise<GitLogResult> =>
      target.route === 'session'
        ? gitRead<GitLogResult>(target, 'log', {
            limit: limit === undefined ? undefined : String(limit),
            skip: skip === undefined ? undefined : String(skip),
            search: query?.search,
            author: query?.author,
            refs:
              query?.refs?.length === 1
                ? query.refs[0]
                : query?.refs?.includes('all')
                  ? 'all'
                  : undefined
          })
        : gitLocal(target, (api) => api.log(target.cwd, limit, skip, query)),
    gitIncoming: (limit?: number): Promise<GitLogResult> =>
      target.route === 'session'
        ? gitRead<GitLogResult>(target, 'incoming', {
            limit: limit === undefined ? undefined : String(limit)
          })
        : gitLocal(target, (api) => api.incoming(target.cwd, limit)),
    gitCommitShow: (hash: string): Promise<GitCommitInfoResult> =>
      target.route === 'session'
        ? gitRead<GitCommitInfoResult>(target, 'commit-show', { hash })
        : gitLocal(target, (api) => api.commitShow(target.cwd, hash)),
    gitShowCommitFile: (hash: string, path: string): Promise<GitHeadFileResult> =>
      target.route === 'session'
        ? gitRead<GitHeadFileResult>(target, 'show-commit-file', { hash, path: gitFilePath(path) })
        : gitLocal(target, (api) => api.showCommitFile(target.cwd, hash, path)),
    gitFileHistory: (
      path: string,
      limit?: number,
      cursor?: string
    ): Promise<GitFileHistoryResult> =>
      target.route === 'session'
        ? gitRead<GitFileHistoryResult>(target, 'file-history', {
            path: gitFilePath(path),
            limit: limit === undefined ? undefined : String(limit)
          })
        : gitLocal(target, (api) => api.fileHistory(target.cwd, path, limit, cursor)),
    gitBlame: (path: string): Promise<GitBlameResult> =>
      target.route === 'session'
        ? gitRead<GitBlameResult>(target, 'blame', { path: gitFilePath(path) })
        : gitLocal(target, (api) => api.blame(target.cwd, path)),
    gitGetUserName: (): Promise<GitUserResult> =>
      target.route === 'session'
        ? gitRead<GitUserResult>(target, 'user-name')
        : gitLocal(target, (api) => api.getUserName(target.cwd)),
    gitListAuthors: (): Promise<GitUserListResult> =>
      target.route === 'session'
        ? gitRead<GitUserListResult>(target, 'list-authors')
        : gitLocal(target, (api) => api.listAuthors(target.cwd)),
    gitSuggestCommitMessage
  }
  return Object.freeze(client)
}
export type ScopedGitClient = ReturnType<typeof createGitClient>
async function withCode<T>(
  cwd: string,
  action: (client: ScopedGitClient) => Promise<T>
): Promise<T> {
  return action(createGitClient(await captureCodeGitTarget(cwd)))
}
export const gitInit = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitInit())
export const gitStatus = (cwd: string): Promise<GitStatusResult> =>
  withCode(cwd, (client) => client.gitStatus())
export const gitDiff = (
  cwd: string,
  path: string,
  staged: boolean,
  base?: 'index' | 'head'
): Promise<GitDiffResult> => withCode(cwd, (client) => client.gitDiff(path, staged, base))
export const gitBranchInfo = (cwd: string): Promise<GitBranchInfoResult> =>
  withCode(cwd, (client) => client.gitBranchInfo())
export const gitStage = (cwd: string, path: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitStage(path))
export const gitUnstage = (cwd: string, path: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitUnstage(path))
export const gitDiscardFile = (cwd: string, path: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitDiscardFile(path))
export const gitDiscardWorktree = (cwd: string, path: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitDiscardWorktree(path))
export const gitDiscardWorktreeFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitDiscardWorktreeFiles(paths))
export const gitStageFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitStageFiles(paths))
export const gitCheckIgnored = (cwd: string, paths: string[]): Promise<GitIgnoreCheckResult> =>
  withCode(cwd, (client) => client.gitCheckIgnored(paths))
export const gitUnstageFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitUnstageFiles(paths))
export const gitDiscardFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitDiscardFiles(paths))
export const gitDiscardHunk = (cwd: string, path: string, hunkId: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitDiscardHunk(path, hunkId))
export const gitHeadFile = (cwd: string, path: string): Promise<GitHeadFileResult> =>
  withCode(cwd, (client) => client.gitHeadFile(path))
export const gitGetHeadFile = (cwd: string, path: string): Promise<GitHeadFileResult> =>
  withCode(cwd, (client) => client.gitGetHeadFile(path))
export const gitCommit = (cwd: string, message: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitCommit(message))
export const gitStageAllAndCommit = (cwd: string, message: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitStageAllAndCommit(message))
export const gitAppendGitignore = (cwd: string, path: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitAppendGitignore(path))
export const gitCommitAmend = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitCommitAmend())
export const gitCommitAmendWithMessage = (cwd: string, message: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitCommitAmendWithMessage(message))
export const gitUndoCommit = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitUndoCommit())
export const gitCommitEmpty = (cwd: string, message: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitCommitEmpty(message))
export const gitFetch = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitFetch())
export const gitPull = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPull())
export const gitPush = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPush())
export const gitDivergence = (cwd: string): Promise<GitDivergenceResult> =>
  withCode(cwd, (client) => client.gitDivergence())
export const gitPullMerge = (cwd: string, remember: boolean): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPullMerge(remember))
export const gitPullRebaseWithChoice = (cwd: string, remember: boolean): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPullRebaseWithChoice(remember))
export const gitPullRebase = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPullRebase())
export const gitSync = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitSync())
export const gitPushForce = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPushForce())
export const gitPushTags = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPushTags())
export const gitPushTag = (cwd: string, name: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPushTag(name))
export const gitPullFrom = (cwd: string, remote: string, branch: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPullFrom(remote, branch))
export const gitPushTo = (cwd: string, remote: string, branch?: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPushTo(remote, branch))
export const gitListRemoteBranches = (cwd: string): Promise<GitRemoteBranchListResult> =>
  withCode(cwd, (client) => client.gitListRemoteBranches())
export const gitDeleteRemoteBranch = (
  cwd: string,
  remote: string,
  branch: string
): Promise<GitResult> => withCode(cwd, (client) => client.gitDeleteRemoteBranch(remote, branch))
export const gitDeleteRemoteTag = (
  cwd: string,
  name: string,
  remote?: string
): Promise<GitResult> => withCode(cwd, (client) => client.gitDeleteRemoteTag(name, remote))
export const gitListRemotes = (cwd: string): Promise<GitRemoteListResult> =>
  withCode(cwd, (client) => client.gitListRemotes())
export const gitAddRemote = (cwd: string, name: string, url: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitAddRemote(name, url))
export const gitRemoveRemote = (cwd: string, name: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitRemoveRemote(name))
export const gitListBranches = (cwd: string): Promise<GitBranchListResult> =>
  withCode(cwd, (client) => client.gitListBranches())
export const gitCheckout = (cwd: string, branch: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitCheckout(branch))
export const gitCreateBranch = (
  cwd: string,
  name: string,
  startPoint?: string
): Promise<GitResult> => withCode(cwd, (client) => client.gitCreateBranch(name, startPoint))
export const gitDeleteBranch = (cwd: string, name: string, force?: boolean): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitDeleteBranch(name, force))
export const gitRenameBranch = (
  cwd: string,
  oldName: string,
  newName: string
): Promise<GitResult> => withCode(cwd, (client) => client.gitRenameBranch(oldName, newName))
export const gitPublishBranch = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitPublishBranch())
export const gitMerge = (cwd: string, ref: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitMerge(ref))
export const gitMergeAbort = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitMergeAbort())
export const gitRebase = (cwd: string, ref: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitRebase(ref))
export const gitRebaseAbort = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitRebaseAbort())
export const gitCherryPick = (cwd: string, hash: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitCherryPick(hash))
export const gitCherryPickAbort = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitCherryPickAbort())
export const gitRevertCommit = (cwd: string, hash: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitRevertCommit(hash))
export const gitListStashes = (cwd: string): Promise<GitStashListResult> =>
  withCode(cwd, (client) => client.gitListStashes())
export const gitStashPush = (
  cwd: string,
  message?: string,
  includeUntracked?: boolean
): Promise<GitResult> => withCode(cwd, (client) => client.gitStashPush(message, includeUntracked))
export const gitStashPushStaged = (cwd: string, message?: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitStashPushStaged(message))
export const gitStashPop = (cwd: string, index?: number): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitStashPop(index))
export const gitStashApply = (cwd: string, index?: number): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitStashApply(index))
export const gitStashDrop = (cwd: string, index: number): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitStashDrop(index))
export const gitStashDropBatch = (cwd: string, indexes: number[]): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitStashDropBatch(indexes))
export const gitStashClear = (cwd: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitStashClear())
export const gitStashShow = (cwd: string, index: number): Promise<GitHeadFileResult> =>
  withCode(cwd, (client) => client.gitStashShow(index))
export const gitStashShowFiles = (cwd: string, index: number): Promise<GitHeadFileResult> =>
  withCode(cwd, (client) => client.gitStashShowFiles(index))
export const gitListTags = (cwd: string): Promise<GitTagListResult> =>
  withCode(cwd, (client) => client.gitListTags())
export const gitCreateTag = (cwd: string, name: string, message?: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitCreateTag(name, message))
export const gitDeleteTag = (cwd: string, name: string): Promise<GitResult> =>
  withCode(cwd, (client) => client.gitDeleteTag(name))
export const gitLog = (
  cwd: string,
  limit?: number,
  skip?: number,
  query?: GitLogQuery
): Promise<GitLogResult> => withCode(cwd, (client) => client.gitLog(limit, skip, query))
export const gitIncoming = (cwd: string, limit?: number): Promise<GitLogResult> =>
  withCode(cwd, (client) => client.gitIncoming(limit))
export const gitCommitShow = (cwd: string, hash: string): Promise<GitCommitInfoResult> =>
  withCode(cwd, (client) => client.gitCommitShow(hash))
export const gitShowCommitFile = (
  cwd: string,
  hash: string,
  path: string
): Promise<GitHeadFileResult> => withCode(cwd, (client) => client.gitShowCommitFile(hash, path))
export const gitFileHistory = (
  cwd: string,
  path: string,
  limit?: number,
  cursor?: string
): Promise<GitFileHistoryResult> =>
  withCode(cwd, (client) => client.gitFileHistory(path, limit, cursor))
export const gitBlame = (cwd: string, path: string): Promise<GitBlameResult> =>
  withCode(cwd, (client) => client.gitBlame(path))
export const gitGetUserName = (cwd: string): Promise<GitUserResult> =>
  withCode(cwd, (client) => client.gitGetUserName())
export const gitListAuthors = (cwd: string): Promise<GitUserListResult> =>
  withCode(cwd, (client) => client.gitListAuthors())
export const gitSuggestCommitMessage = (cwd: string): Promise<GitSuggestMessageResult> =>
  withCode(cwd, (client) => client.gitSuggestCommitMessage())
function bridge(): Window['aether'] {
  if (!window.aether) throw new Error('IPC 桥未就绪：preload 未加载')
  return window.aether
}
export const gitAddSshKey = (passphrase: string): Promise<GitResult> =>
  bridge().git.addSshKey(passphrase)
export const gitClone = async (options: GitCloneOptions): Promise<GitCloneResult> => {
  if (!isRemoteEngine()) return bridge().git.clone(options)
  return gitAction<GitCloneResult>(await captureCodeGitTarget(), 'clone', {
    url: options.url
  })
}
export const gitCancelClone = (cloneId: string): Promise<GitResult> =>
  isRemoteEngine()
    ? Promise.resolve({ success: false, error: '远程克隆已通过单次请求执行，当前不支持中途取消。' })
    : bridge().git.cancelClone(cloneId)
export const onGitCloneProgress = (
  listener: (payload: GitCloneProgressPayload) => void
): (() => void) => (isRemoteEngine() ? () => undefined : bridge().git.onCloneProgress(listener))
