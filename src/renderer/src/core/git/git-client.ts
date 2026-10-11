/**
 * git 客户端（渲染层）
 *
 * 薄封装 window.aether.git。主进程直接调用 git，cwd 受工作区白名单限制。
 * 全部方法返回 { success, error?, errorCode? } 信封，失败不抛异常。
 * 这里不做任何缓存与重试：状态交给 git-store 统一持有。
 */
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
import { requestOrThrow } from '../engine/client'
import { assertWorkspaceTarget, captureWorkspaceTarget } from '../workspace/connection'
import { remoteWorkspaceContext, remoteWorkspaceRelativePath } from '../workspace/fs-client'

function bridge(): Window['aether'] {
  const api = window.aether
  if (!api) throw new Error('IPC 桥未就绪：preload 未加载')
  return api
}

/** Read-only Git calls are served by the authenticated remote engine. */
async function remoteRead<T>(op: string, cwd: string, query: Record<string, string | undefined> = {}): Promise<T> {
  const target = captureWorkspaceTarget()
  const context = await remoteWorkspaceContext()
  assertWorkspaceTarget(target)
  const cwdRelative = remoteWorkspaceRelativePath(context, cwd)
  const result = await requestOrThrow<T>({ method: 'GET', path: `/git/${op}`, query: {
    sessionId: target.sessionId, cwd: cwdRelative || '.', ...query
  }, expectedEngine: target.expectedEngine })
  assertWorkspaceTarget(target)
  return result
}

async function remoteAction<T extends GitResult = GitResult>(op: string, cwd: string, payload: Record<string, unknown> = {}): Promise<T> {
  const target = captureWorkspaceTarget()
  const context = await remoteWorkspaceContext()
  assertWorkspaceTarget(target)
  const cwdRelative = remoteWorkspaceRelativePath(context, cwd)
  const normalized: Record<string, unknown> = { ...payload }
  if (typeof normalized.path === 'string') normalized.path = remoteFilePath(normalized.path)
  if (Array.isArray(normalized.paths)) normalized.paths = normalized.paths.map((value) => remoteFilePath(String(value)))
  const result = await requestOrThrow<T>({ method: 'POST', path: '/git/action', expectedEngine: target.expectedEngine, body: {
    sessionId: target.sessionId, cwd: cwdRelative || '.', op, ...normalized
  } })
  assertWorkspaceTarget(target)
  return result
}

function remoteFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

// ---------- 状态 / diff ----------
export const gitInit = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('init', cwd) : bridge().git.init(cwd)
export const gitStatus = (cwd: string): Promise<GitStatusResult> => isRemoteEngine() ? remoteRead<GitStatusResult>('status', cwd) : bridge().git.status(cwd)
export const gitDiff = (cwd: string, path: string, staged: boolean, base?: 'index' | 'head'): Promise<GitDiffResult> =>
  isRemoteEngine() ? remoteRead<GitDiffResult>('diff', cwd, { path: remoteFilePath(path), staged: String(staged), ...(base ? { base } : {}) }) : bridge().git.diff(cwd, path, staged, base)
export const gitBranchInfo = (cwd: string): Promise<GitBranchInfoResult> => isRemoteEngine() ? remoteRead<GitBranchInfoResult>('branch-info', cwd) : bridge().git.branchInfo(cwd)

// ---------- 暂存 / 撤销 ----------
export const gitStage = (cwd: string, path: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('stage', cwd, { path }) : bridge().git.stage(cwd, path)
export const gitUnstage = (cwd: string, path: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('unstage', cwd, { path }) : bridge().git.unstage(cwd, path)
export const gitDiscardFile = (cwd: string, path: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('discard-file', cwd, { path }) : bridge().git.discardFile(cwd, path)
export const gitDiscardWorktree = (cwd: string, path: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('discard-worktree', cwd, { path }) : bridge().git.discardWorktree(cwd, path)
export const gitDiscardWorktreeFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('discard-worktree-files', cwd, { paths }) : bridge().git.discardWorktreeFiles(cwd, paths)
export const gitStageFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('stage-files', cwd, { paths }) : bridge().git.stageFiles(cwd, paths)
export const gitCheckIgnored = (cwd: string, paths: string[]): Promise<GitIgnoreCheckResult> =>
  isRemoteEngine() ? remoteAction('check-ignored', cwd, { paths }) : bridge().git.checkIgnored(cwd, paths)
export const gitUnstageFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('unstage-files', cwd, { paths }) : bridge().git.unstageFiles(cwd, paths)
export const gitDiscardFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('discard-files', cwd, { paths }) : bridge().git.discardFiles(cwd, paths)
export const gitDiscardHunk = (cwd: string, path: string, hunkId: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('discard-hunk', cwd, { path, hunkId }) : bridge().git.discardHunk(cwd, path, hunkId)
export const gitHeadFile = (cwd: string, path: string): Promise<GitHeadFileResult> =>
  isRemoteEngine() ? remoteRead<GitHeadFileResult>('head-file', cwd, { path: remoteFilePath(path) }) : bridge().git.headFile(cwd, path)
export const gitGetHeadFile = (cwd: string, path: string): Promise<GitHeadFileResult> =>
  isRemoteEngine() ? remoteRead<GitHeadFileResult>('head-file-content', cwd, { path: remoteFilePath(path) }) : bridge().git.getHeadFile(cwd, path)

// ---------- 提交 ----------
export const gitCommit = (cwd: string, message: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('commit', cwd, { message }) : bridge().git.commit(cwd, message)
export const gitStageAllAndCommit = (cwd: string, message: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('stage-all-commit', cwd, { message }) : bridge().git.stageAllAndCommit(cwd, message)
export const gitAppendGitignore = (cwd: string, path: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('append-gitignore', cwd, { path }) : bridge().git.appendGitignore(cwd, path)
/**
 * 远程引擎的旧版 suggest-message 只返回本地启发式文案，不带 diff 上下文。
 *
 * GitCommitBar 会在拿到 aiContext 后再调用 /utility/chat。为了让旧版或未升级的
 * 远程引擎也能走这条 AI 路径，这里用已有的 status/diff 查询在渲染层补齐上下文。
 * 上下文只保留文件清单和每个文件有限的 diff 片段，避免把大仓库整份搬进模型请求。
 */
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
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${heading}`)
    for (const line of hunk.lines) {
      const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '
      lines.push(`${prefix}${line.content}`)
    }
  }

  // An untracked file has no git hunk yet, but the remote endpoint still returns its
  // current contents. Include a short addition preview so a single new file does not
  // produce an empty-looking AI context.
  if (diff.hunks.length === 0 && changeLabel(change) === 'untracked' && diff.newContent) {
    lines.push(...diff.newContent.split(/\r?\n/).slice(0, 120).map((line) => `+${line}`))
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
      const additions = diff?.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.type === 'add').length, 0) ?? change.additions
      const deletions = diff?.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.type === 'delete').length, 0) ?? change.deletions
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

async function collectRemoteCommitAiContext(cwd: string): Promise<string> {
  const status = await gitStatus(cwd)
  if (!status.success || !status.files?.length) return ''

  // Match the local implementation: once anything is staged, describe the index only;
  // otherwise describe worktree changes and untracked files.
  const stagedFiles = status.files.filter((file) => Boolean(file.stagedChange))
  const staged = stagedFiles.length > 0
  const candidates = (staged ? stagedFiles : status.files).slice(0, REMOTE_COMMIT_MAX_FILES)
  const diffs = await Promise.all(candidates.map(async (change) => {
    const result = await gitDiff(cwd, change.path, staged).catch(() => ({ success: false as const }))
    return { change, diff: result.success ? result.diff : undefined }
  }))
  return buildRemoteCommitAiContext(candidates, diffs, staged)
}

export const gitSuggestCommitMessage = async (cwd: string): Promise<GitSuggestMessageResult> => {
  if (!isRemoteEngine()) return bridge().git.suggestCommitMessage(cwd)
  const result = await remoteAction<GitSuggestMessageResult>('suggest-message', cwd)
  if (!result.success || result.aiContext?.trim()) return result
  try {
    const aiContext = await collectRemoteCommitAiContext(cwd)
    return aiContext ? { ...result, aiContext } : result
  } catch {
    // Keep the remote engine's local fallback message when status/diff enrichment is
    // unavailable (for example while the workspace connection is being replaced).
    return result
  }
}
export const gitCommitAmend = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('commit-amend', cwd) : bridge().git.commitAmend(cwd)
export const gitCommitAmendWithMessage = (cwd: string, message: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('commit-amend-message', cwd, { message }) : bridge().git.commitAmendWithMessage(cwd, message)
export const gitUndoCommit = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('undo-commit', cwd) : bridge().git.undoCommit(cwd)
export const gitCommitEmpty = (cwd: string, message: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('commit-empty', cwd, { message }) : bridge().git.commitEmpty(cwd, message)

// ---------- 远程 ----------
export const gitFetch = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('fetch', cwd) : bridge().git.fetch(cwd)
export const gitPull = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('pull', cwd) : bridge().git.pull(cwd)
export const gitPush = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('push', cwd) : bridge().git.push(cwd)
export const gitDivergence = (cwd: string): Promise<GitDivergenceResult> => isRemoteEngine() ? remoteRead<GitDivergenceResult>('divergence', cwd) : bridge().git.divergence(cwd)
export const gitPullMerge = (cwd: string, remember: boolean): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('pull-merge', cwd, { remember }) : bridge().git.pullMerge(cwd, remember)
export const gitPullRebaseWithChoice = (cwd: string, remember: boolean): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('pull-rebase', cwd, { remember }) : bridge().git.pullRebaseWithChoice(cwd, remember)
export const gitPullRebase = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('pull-rebase', cwd) : bridge().git.pullRebase(cwd)
export const gitSync = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('sync', cwd) : bridge().git.sync(cwd)
export const gitPushForce = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('push-force', cwd) : bridge().git.pushForce(cwd)
export const gitPushTags = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('push-tags', cwd) : bridge().git.pushTags(cwd)
export const gitPushTag = (cwd: string, name: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('push-tag', cwd, { name }) : bridge().git.pushTag(cwd, name)
export const gitPullFrom = (cwd: string, remote: string, branch: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('pull-from', cwd, { remote, branch }) : bridge().git.pullFrom(cwd, remote, branch)
export const gitPushTo = (cwd: string, remote: string, branch?: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('push-to', cwd, { remote, branch }) : bridge().git.pushTo(cwd, remote, branch)
export const gitAddSshKey = (passphrase: string): Promise<GitResult> => bridge().git.addSshKey(passphrase)
export const gitListRemoteBranches = (cwd: string): Promise<GitRemoteBranchListResult> =>
  isRemoteEngine() ? remoteRead<GitRemoteBranchListResult>('list-remote-branches', cwd) : bridge().git.listRemoteBranches(cwd)
export const gitDeleteRemoteBranch = (cwd: string, remote: string, branch: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('delete-remote-branch', cwd, { remote, branch }) : bridge().git.deleteRemoteBranch(cwd, remote, branch)
export const gitDeleteRemoteTag = (cwd: string, name: string, remote?: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('delete-remote-tag', cwd, { name, remote }) : bridge().git.deleteRemoteTag(cwd, name, remote)
export const gitListRemotes = (cwd: string): Promise<GitRemoteListResult> => isRemoteEngine() ? remoteRead<GitRemoteListResult>('list-remotes', cwd) : bridge().git.listRemotes(cwd)
export const gitAddRemote = (cwd: string, name: string, url: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('add-remote', cwd, { name, url }) : bridge().git.addRemote(cwd, name, url)
export const gitRemoveRemote = (cwd: string, name: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('remove-remote', cwd, { name }) : bridge().git.removeRemote(cwd, name)

// ---------- 分支 ----------
export const gitListBranches = (cwd: string): Promise<GitBranchListResult> => isRemoteEngine() ? remoteRead<GitBranchListResult>('list-branches', cwd) : bridge().git.listBranches(cwd)
export const gitCheckout = (cwd: string, branch: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('checkout', cwd, { branch }) : bridge().git.checkout(cwd, branch)
export const gitCreateBranch = (cwd: string, name: string, startPoint?: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('create-branch', cwd, { branch: name, ref: startPoint }) : bridge().git.createBranch(cwd, name, startPoint)
export const gitDeleteBranch = (cwd: string, name: string, force?: boolean): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('delete-branch', cwd, { branch: name, force }) : bridge().git.deleteBranch(cwd, name, force)
export const gitRenameBranch = (cwd: string, oldName: string, newName: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('rename-branch', cwd, { oldName, newName }) : bridge().git.renameBranch(cwd, oldName, newName)
export const gitPublishBranch = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('publish-branch', cwd) : bridge().git.publishBranch(cwd)
export const gitMerge = (cwd: string, ref: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('merge', cwd, { ref }) : bridge().git.merge(cwd, ref)
export const gitMergeAbort = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('merge-abort', cwd) : bridge().git.mergeAbort(cwd)
export const gitRebase = (cwd: string, ref: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('rebase', cwd, { ref }) : bridge().git.rebase(cwd, ref)
export const gitRebaseAbort = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('rebase-abort', cwd) : bridge().git.rebaseAbort(cwd)
export const gitCherryPick = (cwd: string, hash: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('cherry-pick', cwd, { hash }) : bridge().git.cherryPick(cwd, hash)
export const gitCherryPickAbort = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('cherry-pick-abort', cwd) : bridge().git.cherryPickAbort(cwd)
export const gitRevertCommit = (cwd: string, hash: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('revert-commit', cwd, { hash }) : bridge().git.revertCommit(cwd, hash)

// ---------- 克隆 ----------
export const gitClone = async (options: GitCloneOptions): Promise<GitCloneResult> => {
  if (!isRemoteEngine()) return bridge().git.clone(options)
  const context = await remoteWorkspaceContext()
  return remoteAction<GitCloneResult>('clone', context.root, { url: options.url })
}
export const gitCancelClone = (cloneId: string): Promise<GitResult> => isRemoteEngine() ? Promise.resolve({ success: false, error: '远程克隆已通过单次请求执行，当前不支持中途取消。' }) : bridge().git.cancelClone(cloneId)
export const onGitCloneProgress = (listener: (payload: GitCloneProgressPayload) => void): (() => void) =>
  isRemoteEngine() ? (() => undefined) : bridge().git.onCloneProgress(listener)

// ---------- 存储（Stash） ----------
export const gitListStashes = (cwd: string): Promise<GitStashListResult> => isRemoteEngine() ? remoteRead<GitStashListResult>('list-stashes', cwd) : bridge().git.listStashes(cwd)
export const gitStashPush = (cwd: string, message?: string, includeUntracked?: boolean): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('stash-push', cwd, { message, includeUntracked }) : bridge().git.stashPush(cwd, message, includeUntracked)
export const gitStashPushStaged = (cwd: string, message?: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('stash-push-staged', cwd, { message }) : bridge().git.stashPushStaged(cwd, message)
export const gitStashPop = (cwd: string, index?: number): Promise<GitResult> => isRemoteEngine() ? remoteAction('stash-pop', cwd, { index }) : bridge().git.stashPop(cwd, index)
export const gitStashApply = (cwd: string, index?: number): Promise<GitResult> => isRemoteEngine() ? remoteAction('stash-apply', cwd, { index }) : bridge().git.stashApply(cwd, index)
export const gitStashDrop = (cwd: string, index: number): Promise<GitResult> => isRemoteEngine() ? remoteAction('stash-drop', cwd, { index }) : bridge().git.stashDrop(cwd, index)
export const gitStashDropBatch = (cwd: string, indexes: number[]): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('stash-drop-batch', cwd, { indexes }) : bridge().git.stashDropBatch(cwd, indexes)
export const gitStashClear = (cwd: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('stash-clear', cwd) : bridge().git.stashClear(cwd)
export const gitStashShow = (cwd: string, index: number): Promise<GitHeadFileResult> =>
  isRemoteEngine() ? remoteRead<GitHeadFileResult>('stash-show', cwd, { index: String(index) }) : bridge().git.stashShow(cwd, index)
export const gitStashShowFiles = (cwd: string, index: number): Promise<GitHeadFileResult> =>
  isRemoteEngine() ? remoteRead<GitHeadFileResult>('stash-show-files', cwd, { index: String(index) }) : bridge().git.stashShowFiles(cwd, index)

// ---------- 标记（Tag） ----------
export const gitListTags = (cwd: string): Promise<GitTagListResult> => isRemoteEngine() ? remoteRead<GitTagListResult>('list-tags', cwd) : bridge().git.listTags(cwd)
export const gitCreateTag = (cwd: string, name: string, message?: string): Promise<GitResult> =>
  isRemoteEngine() ? remoteAction('create-tag', cwd, { name, message }) : bridge().git.createTag(cwd, name, message)
export const gitDeleteTag = (cwd: string, name: string): Promise<GitResult> => isRemoteEngine() ? remoteAction('delete-tag', cwd, { name }) : bridge().git.deleteTag(cwd, name)

// ---------- 历史 ----------
export const gitLog = (cwd: string, limit?: number, skip?: number, query?: GitLogQuery): Promise<GitLogResult> =>
  isRemoteEngine() ? remoteRead<GitLogResult>('log', cwd, { limit: limit === undefined ? undefined : String(limit), skip: skip === undefined ? undefined : String(skip), search: query?.search, author: query?.author, refs: query?.refs?.length === 1 ? query.refs[0] : query?.refs?.includes('all') ? 'all' : undefined }) : bridge().git.log(cwd, limit, skip, query)
export const gitIncoming = (cwd: string, limit?: number): Promise<GitLogResult> => isRemoteEngine() ? remoteRead<GitLogResult>('incoming', cwd, { limit: limit === undefined ? undefined : String(limit) }) : bridge().git.incoming(cwd, limit)
export const gitCommitShow = (cwd: string, hash: string): Promise<GitCommitInfoResult> =>
  isRemoteEngine() ? remoteRead<GitCommitInfoResult>('commit-show', cwd, { hash }) : bridge().git.commitShow(cwd, hash)
export const gitShowCommitFile = (cwd: string, hash: string, path: string): Promise<GitHeadFileResult> =>
  isRemoteEngine() ? remoteRead<GitHeadFileResult>('show-commit-file', cwd, { hash, path: remoteFilePath(path) }) : bridge().git.showCommitFile(cwd, hash, path)
export const gitFileHistory = (
  cwd: string,
  path: string,
  limit?: number,
  cursor?: string
): Promise<GitFileHistoryResult> => isRemoteEngine() ? remoteRead<GitFileHistoryResult>('file-history', cwd, { path: remoteFilePath(path), limit: limit === undefined ? undefined : String(limit) }) : bridge().git.fileHistory(cwd, path, limit, cursor)
export const gitBlame = (cwd: string, path: string): Promise<GitBlameResult> => isRemoteEngine() ? remoteRead<GitBlameResult>('blame', cwd, { path: remoteFilePath(path) }) : bridge().git.blame(cwd, path)
export const gitGetUserName = (cwd: string): Promise<GitUserResult> => isRemoteEngine() ? remoteRead<GitUserResult>('user-name', cwd) : bridge().git.getUserName(cwd)
export const gitListAuthors = (cwd: string): Promise<GitUserListResult> => isRemoteEngine() ? remoteRead<GitUserListResult>('list-authors', cwd) : bridge().git.listAuthors(cwd)
