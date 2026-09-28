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

function bridge(): Window['aether'] {
  const api = window.aether
  if (!api) throw new Error('IPC 桥未就绪：preload 未加载')
  return api
}

// ---------- 状态 / diff ----------
export const gitInit = (cwd: string): Promise<GitResult> => bridge().git.init(cwd)
export const gitStatus = (cwd: string): Promise<GitStatusResult> => bridge().git.status(cwd)
export const gitDiff = (cwd: string, path: string, staged: boolean, base?: 'index' | 'head'): Promise<GitDiffResult> =>
  bridge().git.diff(cwd, path, staged, base)
export const gitBranchInfo = (cwd: string): Promise<GitBranchInfoResult> => bridge().git.branchInfo(cwd)

// ---------- 暂存 / 撤销 ----------
export const gitStage = (cwd: string, path: string): Promise<GitResult> => bridge().git.stage(cwd, path)
export const gitUnstage = (cwd: string, path: string): Promise<GitResult> => bridge().git.unstage(cwd, path)
export const gitDiscardFile = (cwd: string, path: string): Promise<GitResult> => bridge().git.discardFile(cwd, path)
export const gitDiscardWorktree = (cwd: string, path: string): Promise<GitResult> =>
  bridge().git.discardWorktree(cwd, path)
export const gitDiscardWorktreeFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  bridge().git.discardWorktreeFiles(cwd, paths)
export const gitStageFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  bridge().git.stageFiles(cwd, paths)
export const gitCheckIgnored = (cwd: string, paths: string[]): Promise<GitIgnoreCheckResult> =>
  bridge().git.checkIgnored(cwd, paths)
export const gitUnstageFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  bridge().git.unstageFiles(cwd, paths)
export const gitDiscardFiles = (cwd: string, paths: string[]): Promise<GitResult> =>
  bridge().git.discardFiles(cwd, paths)
export const gitDiscardHunk = (cwd: string, path: string, hunkId: string): Promise<GitResult> =>
  bridge().git.discardHunk(cwd, path, hunkId)
export const gitHeadFile = (cwd: string, path: string): Promise<GitHeadFileResult> =>
  bridge().git.headFile(cwd, path)
export const gitGetHeadFile = (cwd: string, path: string): Promise<GitHeadFileResult> =>
  bridge().git.getHeadFile(cwd, path)

// ---------- 提交 ----------
export const gitCommit = (cwd: string, message: string): Promise<GitResult> => bridge().git.commit(cwd, message)
export const gitStageAllAndCommit = (cwd: string, message: string): Promise<GitResult> =>
  bridge().git.stageAllAndCommit(cwd, message)
export const gitAppendGitignore = (cwd: string, path: string): Promise<GitResult> =>
  bridge().git.appendGitignore(cwd, path)
export const gitSuggestCommitMessage = (cwd: string): Promise<GitSuggestMessageResult> =>
  bridge().git.suggestCommitMessage(cwd)
export const gitCommitAmend = (cwd: string): Promise<GitResult> => bridge().git.commitAmend(cwd)
export const gitCommitAmendWithMessage = (cwd: string, message: string): Promise<GitResult> =>
  bridge().git.commitAmendWithMessage(cwd, message)
export const gitUndoCommit = (cwd: string): Promise<GitResult> => bridge().git.undoCommit(cwd)
export const gitCommitEmpty = (cwd: string, message: string): Promise<GitResult> =>
  bridge().git.commitEmpty(cwd, message)

// ---------- 远程 ----------
export const gitFetch = (cwd: string): Promise<GitResult> => bridge().git.fetch(cwd)
export const gitPull = (cwd: string): Promise<GitResult> => bridge().git.pull(cwd)
export const gitPush = (cwd: string): Promise<GitResult> => bridge().git.push(cwd)
export const gitDivergence = (cwd: string): Promise<GitDivergenceResult> => bridge().git.divergence(cwd)
export const gitPullMerge = (cwd: string, remember: boolean): Promise<GitResult> =>
  bridge().git.pullMerge(cwd, remember)
export const gitPullRebaseWithChoice = (cwd: string, remember: boolean): Promise<GitResult> =>
  bridge().git.pullRebaseWithChoice(cwd, remember)
export const gitPullRebase = (cwd: string): Promise<GitResult> => bridge().git.pullRebase(cwd)
export const gitSync = (cwd: string): Promise<GitResult> => bridge().git.sync(cwd)
export const gitPushForce = (cwd: string): Promise<GitResult> => bridge().git.pushForce(cwd)
export const gitPushTags = (cwd: string): Promise<GitResult> => bridge().git.pushTags(cwd)
export const gitPushTag = (cwd: string, name: string): Promise<GitResult> => bridge().git.pushTag(cwd, name)
export const gitPullFrom = (cwd: string, remote: string, branch: string): Promise<GitResult> =>
  bridge().git.pullFrom(cwd, remote, branch)
export const gitPushTo = (cwd: string, remote: string, branch?: string): Promise<GitResult> =>
  bridge().git.pushTo(cwd, remote, branch)
export const gitAddSshKey = (passphrase: string): Promise<GitResult> => bridge().git.addSshKey(passphrase)
export const gitListRemoteBranches = (cwd: string): Promise<GitRemoteBranchListResult> =>
  bridge().git.listRemoteBranches(cwd)
export const gitDeleteRemoteBranch = (cwd: string, remote: string, branch: string): Promise<GitResult> =>
  bridge().git.deleteRemoteBranch(cwd, remote, branch)
export const gitDeleteRemoteTag = (cwd: string, name: string, remote?: string): Promise<GitResult> =>
  bridge().git.deleteRemoteTag(cwd, name, remote)
export const gitListRemotes = (cwd: string): Promise<GitRemoteListResult> => bridge().git.listRemotes(cwd)
export const gitAddRemote = (cwd: string, name: string, url: string): Promise<GitResult> =>
  bridge().git.addRemote(cwd, name, url)
export const gitRemoveRemote = (cwd: string, name: string): Promise<GitResult> =>
  bridge().git.removeRemote(cwd, name)

// ---------- 分支 ----------
export const gitListBranches = (cwd: string): Promise<GitBranchListResult> => bridge().git.listBranches(cwd)
export const gitCheckout = (cwd: string, branch: string): Promise<GitResult> => bridge().git.checkout(cwd, branch)
export const gitCreateBranch = (cwd: string, name: string, startPoint?: string): Promise<GitResult> =>
  bridge().git.createBranch(cwd, name, startPoint)
export const gitDeleteBranch = (cwd: string, name: string, force?: boolean): Promise<GitResult> =>
  bridge().git.deleteBranch(cwd, name, force)
export const gitRenameBranch = (cwd: string, oldName: string, newName: string): Promise<GitResult> =>
  bridge().git.renameBranch(cwd, oldName, newName)
export const gitPublishBranch = (cwd: string): Promise<GitResult> => bridge().git.publishBranch(cwd)
export const gitMerge = (cwd: string, ref: string): Promise<GitResult> => bridge().git.merge(cwd, ref)
export const gitMergeAbort = (cwd: string): Promise<GitResult> => bridge().git.mergeAbort(cwd)
export const gitRebase = (cwd: string, ref: string): Promise<GitResult> => bridge().git.rebase(cwd, ref)
export const gitRebaseAbort = (cwd: string): Promise<GitResult> => bridge().git.rebaseAbort(cwd)
export const gitCherryPick = (cwd: string, hash: string): Promise<GitResult> => bridge().git.cherryPick(cwd, hash)
export const gitCherryPickAbort = (cwd: string): Promise<GitResult> => bridge().git.cherryPickAbort(cwd)
export const gitRevertCommit = (cwd: string, hash: string): Promise<GitResult> =>
  bridge().git.revertCommit(cwd, hash)

// ---------- 克隆 ----------
export const gitClone = (options: GitCloneOptions): Promise<GitCloneResult> => bridge().git.clone(options)
export const gitCancelClone = (cloneId: string): Promise<GitResult> => bridge().git.cancelClone(cloneId)
export const onGitCloneProgress = (listener: (payload: GitCloneProgressPayload) => void): (() => void) =>
  bridge().git.onCloneProgress(listener)

// ---------- 存储（Stash） ----------
export const gitListStashes = (cwd: string): Promise<GitStashListResult> => bridge().git.listStashes(cwd)
export const gitStashPush = (cwd: string, message?: string, includeUntracked?: boolean): Promise<GitResult> =>
  bridge().git.stashPush(cwd, message, includeUntracked)
export const gitStashPushStaged = (cwd: string, message?: string): Promise<GitResult> =>
  bridge().git.stashPushStaged(cwd, message)
export const gitStashPop = (cwd: string, index?: number): Promise<GitResult> => bridge().git.stashPop(cwd, index)
export const gitStashApply = (cwd: string, index?: number): Promise<GitResult> => bridge().git.stashApply(cwd, index)
export const gitStashDrop = (cwd: string, index: number): Promise<GitResult> => bridge().git.stashDrop(cwd, index)
export const gitStashDropBatch = (cwd: string, indexes: number[]): Promise<GitResult> =>
  bridge().git.stashDropBatch(cwd, indexes)
export const gitStashClear = (cwd: string): Promise<GitResult> => bridge().git.stashClear(cwd)
export const gitStashShow = (cwd: string, index: number): Promise<GitHeadFileResult> =>
  bridge().git.stashShow(cwd, index)
export const gitStashShowFiles = (cwd: string, index: number): Promise<GitHeadFileResult> =>
  bridge().git.stashShowFiles(cwd, index)

// ---------- 标记（Tag） ----------
export const gitListTags = (cwd: string): Promise<GitTagListResult> => bridge().git.listTags(cwd)
export const gitCreateTag = (cwd: string, name: string, message?: string): Promise<GitResult> =>
  bridge().git.createTag(cwd, name, message)
export const gitDeleteTag = (cwd: string, name: string): Promise<GitResult> => bridge().git.deleteTag(cwd, name)

// ---------- 历史 ----------
export const gitLog = (cwd: string, limit?: number, skip?: number, query?: GitLogQuery): Promise<GitLogResult> =>
  bridge().git.log(cwd, limit, skip, query)
export const gitIncoming = (cwd: string, limit?: number): Promise<GitLogResult> => bridge().git.incoming(cwd, limit)
export const gitCommitShow = (cwd: string, hash: string): Promise<GitCommitInfoResult> =>
  bridge().git.commitShow(cwd, hash)
export const gitShowCommitFile = (cwd: string, hash: string, path: string): Promise<GitHeadFileResult> =>
  bridge().git.showCommitFile(cwd, hash, path)
export const gitFileHistory = (
  cwd: string,
  path: string,
  limit?: number,
  cursor?: string
): Promise<GitFileHistoryResult> => bridge().git.fileHistory(cwd, path, limit, cursor)
export const gitBlame = (cwd: string, path: string): Promise<GitBlameResult> => bridge().git.blame(cwd, path)
export const gitGetUserName = (cwd: string): Promise<GitUserResult> => bridge().git.getUserName(cwd)
export const gitListAuthors = (cwd: string): Promise<GitUserListResult> => bridge().git.listAuthors(cwd)
