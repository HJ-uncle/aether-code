/**
 * git 状态共享 store（单例）
 *
 * 移植自 wuzu-client stores/codeGit.ts 的渲染层 store。aether 是单项目视图，
 * 不需要 wuzu 的 createGitState 双实例（项目视图 / 会话检出两份）—— 单例即可，
 * 代码注释中保留该差异说明。
 *
 * 实现模式沿用 aether 既有约定：模块级 state + Set<listener> + useSyncExternalStore。
 * 数据源是 core/git/git-client 的薄封装（Result 信封契约），状态集中在
 * core/git/git-types 的 GitFileChange / GitLogEntry 等共享类型上。
 *
 * 关键行为与 wuzu 对齐：
 * - refresh 串行化：inflight 复用 + 并发请求合并成一次 queued 补刷，
 *   且补刷一定拿到发起时刻之后的状态（撤回/提交后界面不停在旧数据上）。
 * - selection 代际：refresh 发起时取一代际号，回写前比对，防止旧请求覆盖新仓库数据。
 * - 外部 fs 变更自动刷新：aether 目前没有 chokidar 类的全局 fs-change 订阅通道
 *   （preload 只暴露 engine.onSnapshot / terminal.onData / git.onCloneProgress），
 *   故落地为「保存后刷新 + Agent 对话结束后刷新 + 手动刷新」三条既有触发点
 *   （editor-store / ChatView / StatusBar），并保留 scheduleFsRefresh 的防抖口径
 *   （300ms 防抖 + 5s 最小间隔）供将来接入真实 fs 事件复用。
 * - 自动 fetch 定时器：按偏好间隔静默 fetch，失败退避 ×5，不占 operation、不弹 toast。
 *
 * 与 wuzu 的偏差（主动取舍）：
 * - 不引入 Pinia；computed 投影改为每次取值时现算（files 数组规模小，开销可忽略）。
 * - blame/hunks/timeline 的编辑器联动在 aether 暂无宿主（无 gutter 渲染层），
 *   loadHunksFor/applyLiveHunks/isDirtyBuffer 这类依赖编辑器缓冲区的接口未移植，
 *   保留 loadBlame/blameLineOf/clearBlame 与 loadCommitShow/loadTimeline/loadLog 等
 *   纯数据接口，供后续 UI 任务按需接入。
 */
import { useSyncExternalStore } from 'react'
import type {
  GitBlameLine,
  GitCommitInfo,
  GitFileChange,
  GitFileDiff,
  GitFileHistoryEntry,
  GitLogEntry,
  GitLogQuery,
  GitRemote,
  GitRemoteBranchInfo,
  GitResult
} from '@shared/git-types'
import {
  gitAddRemote,
  gitAddSshKey,
  gitBlame,
  gitBranchInfo,
  gitCheckIgnored,
  gitCherryPick,
  gitCherryPickAbort,
  gitCheckout,
  gitCommit,
  gitCommitAmend,
  gitCommitAmendWithMessage,
  gitCommitEmpty,
  gitCommitShow,
  gitCreateBranch,
  gitCreateTag,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitDeleteRemoteTag,
  gitDeleteTag,
  gitDiff,
  gitDiscardFile,
  gitDiscardFiles,
  gitDiscardHunk,
  gitDiscardWorktree,
  gitDiscardWorktreeFiles,
  gitDivergence,
  gitFetch,
  gitFileHistory,
  gitGetUserName,
  gitHeadFile,
  gitIncoming,
  gitInit,
  gitListAuthors,
  gitListBranches,
  gitListRemoteBranches,
  gitListRemotes,
  gitListStashes,
  gitListTags,
  gitLog,
  gitMerge,
  gitMergeAbort,
  gitPublishBranch,
  gitPull,
  gitPullFrom,
  gitPullMerge,
  gitPullRebase,
  gitPullRebaseWithChoice,
  gitPush,
  gitPushForce,
  gitPushTag,
  gitPushTags,
  gitPushTo,
  gitRebase,
  gitRebaseAbort,
  gitRemoveRemote,
  gitRenameBranch,
  gitRevertCommit,
  gitStage,
  gitStageAllAndCommit,
  gitStageFiles,
  gitStashApply,
  gitStashClear,
  gitStashDrop,
  gitStashDropBatch,
  gitStashPop,
  gitStashPush,
  gitStashPushStaged,
  gitStatus,
  gitSync,
  gitUndoCommit,
  gitUnstage,
  gitUnstageFiles
} from './git-client'
import { getGitAutoFetch, getGitAutoFetchIntervalMs } from './git-pref'

/** 可能长时间运行的写操作名：执行期间 UI 一律禁用其他 git 入口 */
const LONG_OPS = new Set([
  'commit',
  'fetch',
  'pull',
  'push',
  'sync',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'stash',
  'checkout',
  'remote'
])

/** 路径归一化（跨 Windows / POSIX 比较用） */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** 外部 fs 变更 → git 刷新的防抖口径（将来接入真实 fs 事件时复用） */
const REFRESH_DEBOUNCE_MS = 300
const REFRESH_MIN_INTERVAL_MS = 5000

/** 时间线分页大小，对齐 VSCode timeline.pageSize 默认值 */
const TIMELINE_PAGE_SIZE = 50

export interface GitStoreState {
  cwd: string
  isRepo: boolean
  loading: boolean
  errorMessage: string
  files: GitFileChange[]
  branch: string
  upstream: string | null
  ahead: number | null
  behind: number | null
  selectedPath: string
  currentDiff: GitFileDiff | null
  /** 各文件当前工作空间 diff 的 hunk 列表（gutter 高亮数据源，key 为相对路径） */
  hunksMap: Record<string, GitFileDiff['hunks']>
  commitMessage: string
  committing: boolean
  /** 正在执行的写操作名（空串表示空闲），一次只有一个 */
  operation: string
  /** 远端领先（@{u} 有而 HEAD 没有）的提交，fetch / 历史加载后更新，过滤时清空 */
  incomingCommits: GitLogEntry[]
  incomingLoading: boolean
  /** 是否处于合并中（.git/MERGE_HEAD 存在） */
  merging: boolean
  /** git 预填的合并提交信息，用于自动填入提交框 */
  mergeMessage: string
  remotes: GitRemote[]
  remoteBranches: string[]
  remoteBranchInfos: GitRemoteBranchInfo[]
  stashes: import('@shared/git-types').GitStashEntry[]
  tags: string[]
  commits: GitLogEntry[]
  logExhausted: boolean
  logLoadingMore: boolean
  historySearch: string
  historyAuthor: string
  historyRef: string
  currentUser: string
  historyAuthors: string[]
  branches: string[]
  branchInfos: GitRemoteBranchInfo[]
  timelinePath: string
  timelineEntries: GitFileHistoryEntry[]
  timelineLoading: boolean
  timelineHasMore: boolean
  timelineError: string
  /** 旧版只读面板视图模型：状态栏/资源管理器仍消费它，从 files/branch 派生 */
  status: { isRepo: boolean; branch: string; ahead: number | null; behind: number | null; changes: GitFileChange[] } | null
  /** 旧版只读面板视图模型：提交列表（新→旧），从 commits 派生 */
  legacyCommits: { hash: string; shortHash: string; subject: string; author: string; date: string; refs: string }[]
  /** 是否已针对当前 root 成功拉取过（旧 UI 据此区分「加载中」与「空态」） */
  loaded: boolean
}

let state: GitStoreState = {
  cwd: '',
  isRepo: false,
  loading: false,
  errorMessage: '',
  files: [],
  branch: '',
  upstream: null,
  ahead: null,
  behind: null,
  selectedPath: '',
  currentDiff: null,
  hunksMap: {},
  commitMessage: '',
  committing: false,
  operation: '',
  incomingCommits: [],
  incomingLoading: false,
  merging: false,
  mergeMessage: '',
  remotes: [],
  remoteBranches: [],
  remoteBranchInfos: [],
  stashes: [],
  tags: [],
  commits: [],
  logExhausted: false,
  logLoadingMore: false,
  historySearch: '',
  historyAuthor: '',
  historyRef: '',
  currentUser: '',
  historyAuthors: [],
  branches: [],
  branchInfos: [],
  timelinePath: '',
  timelineEntries: [],
  timelineLoading: false,
  timelineHasMore: false,
  timelineError: '',
  status: null,
  legacyCommits: [],
  loaded: false
}

const listeners = new Set<() => void>()

function setState(patch: Partial<GitStoreState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function getGitState(): GitStoreState {
  return state
}

// ==================== 提交信息草稿持久化（按仓库 cwd） ====================

const COMMIT_DRAFTS_KEY = 'aether:gitCommitDrafts'
const MAX_DRAFT_SLOTS = 50

function readCommitDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(COMMIT_DRAFTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const table: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) table[key] = value
    }
    return table
  } catch {
    return {}
  }
}

function loadCommitDraft(cwd: string): string {
  return readCommitDrafts()[cwd] ?? ''
}

let commitDraftTimer = 0

/** 防抖落盘：提交信息是高频输入，每次按键都写 localStorage 不值 */
function scheduleCommitDraftSave(cwd: string, text: string): void {
  if (!cwd) return
  clearTimeout(commitDraftTimer)
  commitDraftTimer = window.setTimeout(() => {
    const table = readCommitDrafts()
    if (!text.trim()) {
      delete table[cwd]
    } else {
      delete table[cwd]
      table[cwd] = text
      const keys = Object.keys(table)
      while (keys.length > MAX_DRAFT_SLOTS) delete table[keys.shift() as string]
    }
    try {
      localStorage.setItem(COMMIT_DRAFTS_KEY, JSON.stringify(table))
    } catch {
      // 存储写失败不打断输入
    }
  }, 400)
}

/** 提交成功后清空输入框与对应草稿 */
function clearCommitMessage(): void {
  clearTimeout(commitDraftTimer)
  setState({ commitMessage: '' })
  scheduleCommitDraftSave(state.cwd, '')
}

/** 提交信息输入框的受控 setter（GitCommitBar 输入 / AI 生成回填用） */
export function setCommitMessage(v: string): void {
  setState({ commitMessage: v })
  scheduleCommitDraftSave(state.cwd, v)
}

export function onGitChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ---------- 投影（wuzu 的 computed；files 规模小，现算即可） ----------

/** 暂存组：分别以「暂存视角」出现的文件（对齐 VSCode 分组，一个 MM 文件两边各出现一次） */
export function stagedFilesOf(s: GitStoreState): GitFileChange[] {
  return s.files.flatMap((f) => {
    if (f.stagedChange == null && !f.conflict) return []
    return [
      {
        ...f,
        changeType: f.stagedChange ?? f.changeType,
        staged: true,
        additions: f.stagedAdditions ?? 0,
        deletions: f.stagedDeletions ?? 0
      }
    ]
  })
}

/** 更改组：工作区视角的文件（暂存之后新改的部分） */
export function unstagedFilesOf(s: GitStoreState): GitFileChange[] {
  return s.files.flatMap((f) => {
    if (f.unstagedChange == null) return []
    return [
      {
        ...f,
        changeType: f.unstagedChange,
        staged: false,
        additions: f.unstagedAdditions ?? 0,
        deletions: f.unstagedDeletions ?? 0
      }
    ]
  })
}

/** 合并冲突文件列表（porcelain `u` 行；VSCode 的 Merge Changes 组） */
export function conflictFilesOf(s: GitStoreState): GitFileChange[] {
  return s.files.filter((f) => f.conflict === true)
}

export function changeCountOf(s: GitStoreState): number {
  return s.files.length
}
export function totalAdditionsOf(s: GitStoreState): number {
  return s.files.reduce((sum, f) => sum + f.additions, 0)
}
export function totalDeletionsOf(s: GitStoreState): number {
  return s.files.reduce((sum, f) => sum + f.deletions, 0)
}
/** 是否存在可提交内容：暂存区或工作区任一有改动即可（对齐 VSCode smart commit） */
export function hasChangesToCommitOf(s: GitStoreState): boolean {
  return stagedFilesOf(s).length > 0 || s.files.length > 0
}
/** 仅暂存区有内容可提交（下拉「提交（暂存区）」等只认暂存区的入口用） */
export function canCommitStagedOf(s: GitStoreState): boolean {
  return stagedFilesOf(s).length > 0 && s.commitMessage.trim().length > 0 && !s.committing
}
/** 主提交按钮可用性：有可提交内容且填了信息 */
export function canCommitOf(s: GitStoreState): boolean {
  return hasChangesToCommitOf(s) && s.commitMessage.trim().length > 0 && !s.committing
}
/** 正在进行的长耗时写操作名（空串表示没有，工具栏 / 菜单 / 提交区据此统一禁用入口） */
export function busyOperationOf(s: GitStoreState): string {
  return LONG_OPS.has(s.operation) ? s.operation : ''
}
/** 分支下拉数据源：当前分支置顶，其余保持主进程的提交时间倒序 */
export function sortedBranchesOf(s: GitStoreState): string[] {
  const rest = s.branches.filter((b) => b !== s.branch)
  return s.branch ? [s.branch, ...rest] : rest
}

// ==================== 内部：串行门 / 代际 ====================

/** 用户写操作互斥排队；后台自动获取用丢弃式（busy 即放弃，不排队） */
let opBusy = false
async function runQueued<T>(run: () => Promise<T>): Promise<T> {
  while (opBusy) await new Promise((r) => setTimeout(r, 50))
  opBusy = true
  try {
    return await run()
  } finally {
    opBusy = false
  }
}
async function runDroppable<T>(run: () => Promise<T>): Promise<T | null> {
  if (opBusy) return null
  opBusy = true
  try {
    return await run()
  } finally {
    opBusy = false
  }
}

/** 正在跑的那次刷新 */
let inflight: Promise<void> | null = null
/** 刷新期间又来的请求合并成的这一次补刷 */
let queued: Promise<void> | null = null

/** 合并信息预填标记：每轮合并只预填一次，避免用户清空后被无关刷新反复填回 */
let mergeMsgApplied = false
/** 远端领先提交的缓存 key / 加载时刻（10s 内同 key 跳过） */
let incomingKey = ''
let incomingLoadedAt = 0

// ==================== 刷新 ====================

/**
 * 刷新工作空间变更列表与分支信息。
 *
 * 并发时不直接复用在跑的那次，而是排队补刷一次：正在跑的那次可能是撤回**之前**
 * 发起的，读到的是旧状态；直接复用会让撤回完成后界面停在旧数据上。
 */
export function refreshGit(root: string | null): Promise<void> {
  const nextCwd = root ?? ''
  // 代际号在 aether 单项目视图下没有「等待期竞态」可防（wuzu 用它挡 load 期间的
  // 工作区切换），回写统一靠 doRefresh 里的 cwd 比对，故此处不再取号
  if (state.cwd !== nextCwd) {
    // 换了仓库：旧数据一定不适用，先清空避免显示上一个项目的分支
    setState({
      files: [],
      branch: '',
      upstream: null,
      ahead: null,
      behind: null,
      isRepo: false,
      currentDiff: null,
      hunksMap: {},
      // 换仓库时恢复该仓库的提交草稿（没有则为空），而不是一律清空
      commitMessage: loadCommitDraft(nextCwd),
      selectedPath: '',
      merging: false,
      mergeMessage: '',
      incomingCommits: [],
      commits: [],
      timelinePath: '',
      timelineEntries: [],
      timelineHasMore: false,
      timelineLoading: false,
      timelineError: '',
      status: null,
      legacyCommits: [],
      loaded: false,
      errorMessage: '',
      loading: true
    })
    clearBlame()
    clearIncoming()
  }
  setState({ cwd: nextCwd, loading: true })
  if (inflight) {
    if (!queued) {
      queued = inflight
        .catch(() => undefined)
        .then(() => {
          queued = null
          return refreshGit(state.cwd)
        })
    }
    return queued
  }
  inflight = doRefresh(nextCwd).finally(() => {
    inflight = null
  })
  return inflight
}

async function doRefresh(nextCwd: string): Promise<void> {
  if (!nextCwd) {
    setState({
      files: [],
      isRepo: false,
      status: null,
      legacyCommits: [],
      loading: false
    })
    clearTimeline()
    return
  }
  setState({ loading: true, errorMessage: '' })
  try {
    const [statusRes, branchRes] = await Promise.all([gitStatus(nextCwd), gitBranchInfo(nextCwd)])
    // 请求期间可能已切走仓库，迟到的结果不能覆盖新仓库
    if (state.cwd !== nextCwd) return
    if (statusRes.success) {
      const merging = statusRes.merging ?? false
      const mergeMessage = statusRes.mergeMessage ?? ''
      const files = statusRes.files ?? []
      // 合并中且用户尚未手打提交信息时，自动填入 git 预写的合并信息
      // （面板走 git commit -m，git 不会自己带出 MERGE_MSG，需在此补上）。
      // 每轮合并只预填一次：否则用户清空输入框后一次无关的刷新又会把它填回来。
      let commitMessage = state.commitMessage
      if (!merging) {
        mergeMsgApplied = false
      } else if (mergeMessage && !mergeMsgApplied && !commitMessage.trim()) {
        commitMessage = mergeMessage
        mergeMsgApplied = true
      }
      const branch = branchRes.success && branchRes.info ? branchRes.info.branch : state.branch
      const upstream = branchRes.success && branchRes.info ? branchRes.info.upstream : state.upstream
      const ahead = branchRes.success && branchRes.info ? branchRes.info.ahead : state.ahead
      const behind = branchRes.success && branchRes.info ? branchRes.info.behind : state.behind
      const status = {
        isRepo: statusRes.isRepo ?? false,
        branch,
        ahead,
        behind,
        changes: files
      }
      setState({
        isRepo: statusRes.isRepo ?? false,
        files,
        merging,
        mergeMessage,
        commitMessage,
        branch,
        upstream,
        ahead,
        behind,
        status,
        loaded: true
      })
    } else {
      // 刷新失败（并发 git 命令占用 index.lock 等瞬态错误）时保留上一次的列表：
      // 清空会让「更改/暂存」各分组瞬间塌掉、内容高度骤减把滚动钳回顶部。
      setState({ errorMessage: statusRes.error ?? '获取变更失败' })
    }
    // 状态变化后重载 hunks，保证编辑器 gutter 与磁盘一致（aether 暂无 gutter 渲染层，按需接入）。
    // HEAD 可能已前进（commit / checkout / pull / merge）：行内 blame 缓存同步失效。
    clearBlame()
    // 提交历史同步重载：commit / push / pull 都会改 commits 快照或 origin 装饰，
    // 只刷 status/branchInfo 会让历史区停在旧数据。从未加载过的保持懒加载。
    if (state.commits.length > 0) await loadLog(state.commits.length)
  } catch (error) {
    setState({ errorMessage: error instanceof Error ? error.message : '获取变更失败' })
  } finally {
    setState({ loading: false })
  }
}

/** 强制刷新：跳过最小间隔（手动刷新按钮等用户明确期待的时机用） */
export async function forceRefreshGit(): Promise<void> {
  fsLastRefreshAt = Date.now()
  await refreshGit(state.cwd)
}

// ---------- 外部 fs 变更 → git 刷新（防抖口径保留，供将来真实 fs 事件接入） ----------

let fsRefreshTimer: ReturnType<typeof setTimeout> | null = null
let fsLastRefreshAt = 0

/**
 * 调度一次受防抖约束的外部变更刷新：300ms 防抖合并高频事件，
 * 5000ms 最小间隔避免连续事件放大 git status IPC。
 * 当前由保存后 / Agent 对话结束后的既有触发点间接受益；将来若 aether 接入
 * chokidar 类 fs 事件通道，直接复用本函数即可。
 */
export function scheduleFsRefresh(nextCwd: string): void {
  if (!nextCwd) return
  if (fsRefreshTimer) clearTimeout(fsRefreshTimer)
  fsRefreshTimer = setTimeout(() => {
    fsRefreshTimer = null
    const now = Date.now()
    if (now - fsLastRefreshAt < REFRESH_MIN_INTERVAL_MS) return
    fsLastRefreshAt = now
    void refreshGit(nextCwd)
  }, REFRESH_DEBOUNCE_MS)
}

// ==================== 后台自动获取远端 ====================

let autoFetchTimer: ReturnType<typeof setTimeout> | null = null
let autoFetchStarted = false
let autoFetchBusy = false
let lastAutoFetchOkAt = 0
let autoFetchFailures = 0
let disposed = false

function autoFetchGateBlocked(): boolean {
  return (
    disposed ||
    autoFetchBusy ||
    !state.isRepo ||
    state.operation !== '' ||
    state.committing ||
    state.merging ||
    opBusy ||
    (typeof document !== 'undefined' && document.visibilityState !== 'visible')
  )
}

/** 静默执行一次 git fetch。丢弃式并发：任何用户操作 / 上一次在跑都直接放弃。 */
async function autoFetchRemote(): Promise<void> {
  if (autoFetchGateBlocked()) return
  if (!state.cwd) return
  const target = state.cwd
  autoFetchBusy = true
  try {
    const fetched = await runDroppable(() => gitFetch(target))
    if (!fetched) return
    const res = fetched
    if (!res.success) {
      autoFetchFailures++
      console.debug('[git-store] 自动获取远端失败（已跳过，不提示）:', res.error ?? '未知错误')
      return
    }
    autoFetchFailures = 0
    lastAutoFetchOkAt = Date.now()
    if (disposed || normalizePath(state.cwd) !== normalizePath(target)) return
    await refreshGit(target)
    await loadIncoming({ force: true })
  } catch (error) {
    autoFetchFailures++
    console.debug('[git-store] 自动获取远端异常（已跳过）:', error)
  } finally {
    autoFetchBusy = false
  }
}

/** 本轮轮询间隔：连续失败 ≥3 次（如 SSH 口令未装、大仓库超时）后退避 ×5 */
function currentAutoFetchInterval(base: number): number {
  return autoFetchFailures >= 3 ? base * 5 : base
}

function scheduleAutoFetch(): void {
  if (autoFetchTimer) {
    clearTimeout(autoFetchTimer)
    autoFetchTimer = null
  }
  if (disposed) return
  if (!getGitAutoFetch()) return
  autoFetchTimer = setTimeout(() => {
    autoFetchTimer = null
    if (disposed) return
    void autoFetchRemote().finally(scheduleAutoFetch)
  }, currentAutoFetchInterval(getGitAutoFetchIntervalMs()))
}

/** 启动自动获取（幂等）。aether 是单例视图，由应用根部生命周期调用一次即可。 */
export function startGitAutoFetch(): void {
  if (disposed || autoFetchStarted) return
  autoFetchStarted = true
  scheduleAutoFetch()
}

/** 距上次成功获取超过 minMs 才真正 fetch（窗口回前台 / 手动刷新兜底用） */
export async function autoFetchIfStale(minMs = 60000): Promise<void> {
  if (minMs > 0 && Date.now() - lastAutoFetchOkAt < minMs) return
  await autoFetchRemote()
}

/** 供 git-remote-actions 使用的内部自动 fetch（同 wuzu 的 autoFetchRemote） */
export const autoFetchRemoteForStore = autoFetchRemote

/** 停止自动获取并清理定时器（应用退出 / 测试用） */
export function disposeGitStore(): void {
  disposed = true
  if (autoFetchTimer) {
    clearTimeout(autoFetchTimer)
    autoFetchTimer = null
  }
  if (fsRefreshTimer) {
    clearTimeout(fsRefreshTimer)
    fsRefreshTimer = null
  }
  autoFetchStarted = false
}

// ==================== 写操作 ====================

/** 执行写操作并在成功后刷新列表。执行期间把操作名登记到 operation，供 UI 共用同一份「进行中」真相。 */
let operationCount = 0
async function mutate(
  run: () => Promise<GitResult>,
  opName = 'write'
): Promise<GitResult> {
  if (!state.cwd) return { success: false, error: 'Git 能力不可用' }
  setState({ operation: opName })
  operationCount++
  try {
    return await runQueued(async () => {
      const res = await run()
      if (res.success) {
        await refreshGit(state.cwd)
      } else {
        setState({ errorMessage: res.error ?? '操作失败' })
      }
      return res
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '操作失败'
    setState({ errorMessage: message })
    return { success: false, error: message }
  } finally {
    // 并发写操作计数，最后一个结束时才清空 operation（对齐 wuzu）
    operationCount--
    if (operationCount <= 0) {
      operationCount = 0
      setState({ operation: '' })
    }
  }
}

// ---------- 状态 / diff ----------

export function gitInitRepo(): Promise<GitResult> {
  return mutate(() => gitInit(state.cwd))
}

export function stage(path: string): Promise<GitResult> {
  return mutate(() => gitStage(state.cwd, path))
}
export function unstage(path: string): Promise<GitResult> {
  return mutate(() => gitUnstage(state.cwd, path))
}
export function discardFile(path: string): Promise<GitResult> {
  return mutate(() => gitDiscardFile(state.cwd, path))
}
export function discardWorktree(path: string): Promise<GitResult> {
  return mutate(() => gitDiscardWorktree(state.cwd, path))
}
export function discardWorktreeFiles(paths: string[]): Promise<GitResult> {
  return mutate(() => gitDiscardWorktreeFiles(state.cwd, paths))
}
export function stageFiles(paths: string[]): Promise<GitResult> {
  return mutate(() => gitStageFiles(state.cwd, paths))
}
export function unstageFiles(paths: string[]): Promise<GitResult> {
  return mutate(() => gitUnstageFiles(state.cwd, paths))
}
export function discardFiles(paths: string[]): Promise<GitResult> {
  return mutate(() => gitDiscardFiles(state.cwd, paths))
}
export function discardHunk(path: string, hunkId: string): Promise<GitResult> {
  return mutate(() => gitDiscardHunk(state.cwd, path, hunkId))
}

/** 查询哪些路径被 .gitignore 忽略（只读，不触发刷新） */
export async function checkIgnored(paths: string[]): Promise<Set<string> | null> {
  if (!state.cwd || paths.length === 0) return null
  try {
    const res = await gitCheckIgnored(state.cwd, paths)
    if (!res.success || !res.ignored) return null
    const set = new Set<string>()
    for (const [p, hit] of Object.entries(res.ignored)) if (hit) set.add(p)
    return set
  } catch (error) {
    console.error('[git-store] checkIgnored 失败:', error)
    return null
  }
}

// ---------- 提交 ----------

/** 提交：暂存区非空时只提交暂存区；暂存区为空时自动暂存全部改动后提交（smart commit） */
export async function commit(): Promise<GitResult> {
  setState({ committing: true })
  try {
    const stagedCount = stagedFilesOf(state).length
    const res =
      stagedCount > 0
        ? await mutate(() => gitCommit(state.cwd, state.commitMessage), 'commit')
        : await mutate(() => gitStageAllAndCommit(state.cwd, state.commitMessage), 'commit')
    if (res.success) {
      clearCommitMessage()
      setState({ selectedPath: '', currentDiff: null })
    }
    return res
  } finally {
    setState({ committing: false })
  }
}

/** 只提交暂存区，暂存区为空时不回退到全量暂存（下拉「提交（暂存区）」用） */
export async function commitStaged(): Promise<GitResult> {
  if (stagedFilesOf(state).length === 0) {
    return { success: false, error: '暂存区没有可提交的内容' }
  }
  setState({ committing: true })
  try {
    const res = await mutate(() => gitCommit(state.cwd, state.commitMessage), 'commit')
    if (res.success) {
      clearCommitMessage()
      setState({ selectedPath: '', currentDiff: null })
    }
    return res
  } finally {
    setState({ committing: false })
  }
}

/** 暂存全部改动并提交 */
export async function commitAll(): Promise<GitResult> {
  setState({ committing: true })
  try {
    const res = await mutate(() => gitStageAllAndCommit(state.cwd, state.commitMessage), 'commit')
    if (res.success) {
      clearCommitMessage()
      setState({ selectedPath: '', currentDiff: null })
    }
    return res
  } finally {
    setState({ committing: false })
  }
}

/** 提交（含 amend）成功后清空提交框与选中态 */
function afterCommit(res: GitResult): GitResult {
  if (res.success) {
    clearCommitMessage()
    setState({ selectedPath: '', currentDiff: null })
  }
  return res
}

/** 修补上一次提交；message 非空时改用新信息 */
export function commitAmend(message?: string): Promise<GitResult> {
  return mutate(
    () => (message?.trim() ? gitCommitAmendWithMessage(state.cwd, message) : gitCommitAmend(state.cwd)),
    'commit'
  ).then(afterCommit)
}

export function undoCommit(): Promise<GitResult> {
  return mutate(() => gitUndoCommit(state.cwd))
}

export function commitEmpty(message: string): Promise<GitResult> {
  return mutate(() => gitCommitEmpty(state.cwd, message))
}

// ---------- 远程 ----------

export function fetchRemote(): Promise<GitResult> {
  return mutate(() => gitFetch(state.cwd), 'fetch')
}
export function pull(): Promise<GitResult> {
  return mutate(() => gitPull(state.cwd), 'pull')
}
export function push(): Promise<GitResult> {
  return mutate(() => gitPush(state.cwd), 'push')
}
/** 分叉计数：只读查询，不触发写操作后的状态刷新 */
export async function divergence(): Promise<GitResult & { ahead?: number; behind?: number }> {
  if (!state.cwd) return { success: false, error: 'Git 能力不可用' }
  return gitDivergence(state.cwd)
}
export function pullMerge(remember: boolean): Promise<GitResult> {
  return mutate(() => gitPullMerge(state.cwd, remember), 'pull')
}
export function pullRebaseWithChoice(remember: boolean): Promise<GitResult> {
  return mutate(() => gitPullRebaseWithChoice(state.cwd, remember), 'pull')
}
/** 装载 SSH 私钥：不走 mutate，避免成功后又触发一次必然失败的远程刷新 */
export async function addSshKey(passphrase: string): Promise<GitResult> {
  return gitAddSshKey(passphrase)
}
export function sync(): Promise<GitResult> {
  return mutate(() => gitSync(state.cwd), 'sync')
}
export function pullRebase(): Promise<GitResult> {
  return mutate(() => gitPullRebase(state.cwd), 'pull')
}
export function pushForce(): Promise<GitResult> {
  return mutate(() => gitPushForce(state.cwd), 'push')
}
export function pushTags(): Promise<GitResult> {
  return mutate(() => gitPushTags(state.cwd), 'push')
}
export function pushTag(name: string): Promise<GitResult> {
  return mutate(() => gitPushTag(state.cwd, name), 'push')
}
export function pullFrom(remote: string, branch: string): Promise<GitResult> {
  return mutate(() => gitPullFrom(state.cwd, remote, branch), 'pull')
}
export function pushTo(remote: string, branch?: string): Promise<GitResult> {
  return mutate(() => gitPushTo(state.cwd, remote, branch), 'push')
}
export function deleteRemoteBranch(remote: string, branch: string): Promise<GitResult> {
  return mutate(() => gitDeleteRemoteBranch(state.cwd, remote, branch), 'remote')
}
export function deleteRemoteTag(name: string, remote?: string): Promise<GitResult> {
  return mutate(() => gitDeleteRemoteTag(state.cwd, name, remote), 'remote')
}

export async function loadRemotes(): Promise<void> {
  if (!state.cwd) return
  const res = await gitListRemotes(state.cwd)
  if (res.success) setState({ remotes: res.remotes ?? [] })
}

export async function loadRemoteBranches(): Promise<void> {
  if (!state.cwd) return
  const res = await gitListRemoteBranches(state.cwd)
  if (res.success) {
    setState({
      remoteBranches: res.branches ?? [],
      remoteBranchInfos: res.infos ?? []
    })
  }
}

export async function addRemote(name: string, url: string): Promise<GitResult> {
  const res = await mutate(() => gitAddRemote(state.cwd, name, url))
  if (res.success) await loadRemotes()
  return res
}

export async function removeRemote(name: string): Promise<GitResult> {
  const res = await mutate(() => gitRemoveRemote(state.cwd, name))
  if (res.success) await loadRemotes()
  return res
}

// ---------- 存储（Stash） ----------

export async function loadStashes(): Promise<void> {
  if (!state.cwd) return
  const res = await gitListStashes(state.cwd)
  if (res.success) setState({ stashes: res.stashes ?? [] })
}

/** stash 写操作：成功后同时刷新变更列表与 stash 列表 */
async function stashMutate(run: () => Promise<GitResult>): Promise<GitResult> {
  const res = await mutate(run, 'stash')
  if (res.success) await loadStashes()
  return res
}

export function stashPush(message?: string, includeUntracked = false): Promise<GitResult> {
  return stashMutate(() => gitStashPush(state.cwd, message, includeUntracked))
}
export function stashPushStaged(message?: string): Promise<GitResult> {
  return stashMutate(() => gitStashPushStaged(state.cwd, message))
}
export function stashPop(index?: number): Promise<GitResult> {
  return stashMutate(() => gitStashPop(state.cwd, index))
}
export function stashApply(index?: number): Promise<GitResult> {
  return stashMutate(() => gitStashApply(state.cwd, index))
}
export function stashDrop(index: number): Promise<GitResult> {
  return stashMutate(() => gitStashDrop(state.cwd, index))
}
export function stashDropBatch(indexes: number[]): Promise<GitResult> {
  return stashMutate(() => gitStashDropBatch(state.cwd, indexes))
}
export function stashClear(): Promise<GitResult> {
  return stashMutate(() => gitStashClear(state.cwd))
}

// ---------- 标记（Tag） ----------

export async function loadTags(): Promise<void> {
  if (!state.cwd) return
  const res = await gitListTags(state.cwd)
  if (res.success) setState({ tags: res.tags ?? [] })
}

export async function createTag(name: string, message?: string): Promise<GitResult> {
  const res = await mutate(() => gitCreateTag(state.cwd, name, message))
  if (res.success) await loadTags()
  return res
}

export async function deleteTag(name: string): Promise<GitResult> {
  const res = await mutate(() => gitDeleteTag(state.cwd, name))
  if (res.success) await loadTags()
  return res
}

// ---------- 提交历史 ----------

export async function loadLog(limit = 50, append = false): Promise<void> {
  if (!state.cwd) return
  const search = state.historySearch.trim()
  const author = state.historyAuthor.trim()
  const ref = state.historyRef.trim()
  const query: GitLogQuery | undefined =
    search || author || ref
      ? {
          ...(search ? { search } : {}),
          ...(author ? { author } : {}),
          ...(ref ? { refs: [ref] } : {})
        }
      : undefined
  if (append) {
    if (state.logExhausted || state.logLoadingMore) return
    setState({ logLoadingMore: true })
    try {
      const res = await gitLog(state.cwd, limit, state.commits.length, query)
      if (res.success) {
        const next = res.commits ?? []
        setState({
          commits: [...state.commits, ...next],
          logExhausted: next.length < limit
        })
      }
    } finally {
      setState({ logLoadingMore: false })
    }
    return
  }
  const res = await gitLog(state.cwd, limit, 0, query)
  if (res.success) {
    const commits = res.commits ?? []
    setState({
      commits,
      logExhausted: commits.length < limit,
      legacyCommits: commits.map((entry) => ({
        hash: entry.hash,
        shortHash: entry.shortHash,
        subject: entry.subject,
        author: entry.author,
        date: entry.date,
        refs: (entry.refs ?? []).map((r) => r.name).join(', ')
      }))
    })
    // 无过滤条件时顺带刷新远端领先提交（历史区展开 / fetch 后需要重挂泳道）
    if (!query) await loadIncoming()
  }
}

/** 按过滤条件重新加载历史（清空当前列表从头拉） */
export async function reloadLog(limit = 50): Promise<void> {
  setState({ logExhausted: false })
  if (state.historySearch || state.historyAuthor || state.historyRef) clearIncoming()
  await loadLog(limit)
}

/** 设置历史过滤条件并重新加载（替代 wuzu 的 watch 清空 incoming） */
export async function setHistoryFilter(patch: { search?: string; author?: string; ref?: string }): Promise<void> {
  setState({
    historySearch: patch.search ?? state.historySearch,
    historyAuthor: patch.author ?? state.historyAuthor,
    historyRef: patch.ref ?? state.historyRef
  })
  clearIncoming()
  await reloadLog()
}

// ---------- 远端领先提交（incoming） ----------

/**
 * 查询远端领先提交（HEAD..@{u}）。fetch 成功后与历史加载后调用，
 * behind 为 0 / 无上游 / 有过滤条件时清空。非仓库或能力不可用时静默清空。
 */
export async function loadIncoming({ force = false } = {}): Promise<void> {
  if (!state.cwd || !state.isRepo || !state.upstream) {
    setState({ incomingCommits: [] })
    return
  }
  const key = `${state.upstream}|${state.commits[0]?.hash ?? ''}`
  if (!force && key === incomingKey && Date.now() - incomingLoadedAt < 10000) return
  const target = state.cwd
  setState({ incomingLoading: true })
  try {
    const res = await gitIncoming(state.cwd, 50)
    if (normalizePath(state.cwd) !== normalizePath(target)) {
      setState({ incomingCommits: [] })
      return
    }
    incomingKey = key
    incomingLoadedAt = Date.now()
    setState({ incomingCommits: res.success ? (res.commits ?? []) : [] })
  } catch {
    setState({ incomingCommits: [] })
  } finally {
    setState({ incomingLoading: false })
  }
}

/** 清空远端领先提交（过滤条件变化 / 历史重载时调用） */
export function clearIncoming(): void {
  incomingKey = ''
  incomingLoadedAt = 0
  setState({ incomingCommits: [] })
}

// ---------- 时间线（Timeline，按文件） ----------

/**
 * 加载某个文件的提交历史（时间线数据源）。
 * append 为真时从已加载末条提交继续向上追溯。并发只保留最后一次请求：
 * 用户快速切文件时，先发的那次回来若继续写回会覆盖成上一个文件的历史。
 */
export async function loadTimeline(path: string, append = false): Promise<void> {
  const rel = (path || '').replace(/\\/g, '/')
  if (!state.cwd || !rel) {
    setState({
      timelinePath: rel,
      timelineEntries: [],
      timelineHasMore: false,
      timelineLoading: false,
      timelineError: ''
    })
    return
  }
  if (append && (state.timelineLoading || !state.timelineHasMore)) return
  setState({ timelineLoading: true, timelineError: '' })
  if (!append && state.timelinePath !== rel) setState({ timelineEntries: [] })
  setState({ timelinePath: rel, timelineHasMore: append ? state.timelineHasMore : false })
  const cursor = append ? state.timelineEntries[state.timelineEntries.length - 1]?.hash : undefined
  try {
    const res = await gitFileHistory(state.cwd, rel, TIMELINE_PAGE_SIZE, cursor)
    if (state.timelinePath !== rel) return
    if (res.success) {
      const next = res.entries ?? []
      setState({
        timelineEntries: append ? [...state.timelineEntries, ...next] : next,
        timelineHasMore: res.hasMore === true
      })
    } else {
      setState({ timelineError: res.error ?? '读取文件历史失败' })
      if (!append) setState({ timelineEntries: [] })
    }
  } finally {
    if (state.timelinePath === rel) setState({ timelineLoading: false })
  }
}

/** 清空时间线（切工作目录 / 目录不是仓库时调用） */
export function clearTimeline(): void {
  setState({
    timelinePath: '',
    timelineEntries: [],
    timelineHasMore: false,
    timelineLoading: false,
    timelineError: ''
  })
}

// ---------- 行内 Blame ----------

/** 整文件行级 blame 缓存：relPath → 行数组（下标 = 行号 - 1）；空数组代表「查不到」 */
const blameCache = new Map<string, GitBlameLine[]>()
/** 进行中的 blame 请求按路径合并，避免并发重复走 IPC */
const blameInflight = new Map<string, Promise<void>>()

/** 加载指定文件的整文件行级 blame（结果按路径缓存，光标移动不再走 IPC） */
export async function loadBlame(path: string): Promise<void> {
  const rel = (path || '').replace(/\\/g, '/')
  if (!state.cwd || !rel) return
  if (blameCache.has(rel)) return
  const running = blameInflight.get(rel)
  if (running) return running
  const job = (async () => {
    try {
      const res = await gitBlame(state.cwd, rel)
      blameCache.set(rel, res.success ? (res.lines ?? []) : [])
    } catch {
      blameCache.set(rel, [])
    } finally {
      blameInflight.delete(rel)
    }
  })()
  blameInflight.set(rel, job)
  return job
}

/** 取某文件某一行的 blame 归属（未加载 / 无归属时返回 null） */
export function blameLineOf(path: string, lineNumber: number): GitBlameLine | null {
  const rel = (path || '').replace(/\\/g, '/')
  const lines = blameCache.get(rel)
  if (!lines || lineNumber < 1 || lineNumber > lines.length) return null
  return lines[lineNumber - 1] ?? null
}

/** 清空 blame 缓存（HEAD 变化 / 切工作目录时调用） */
export function clearBlame(): void {
  blameCache.clear()
}

/** 某文件的 blame 是否已加载过（含「查不到」的空结果，避免反复重试） */
export function blameReady(path: string): boolean {
  return blameCache.has((path || '').replace(/\\/g, '/'))
}

/** 读取单条提交完整信息（行内 blame 的 hover 卡片数据源） */
export async function loadCommitShow(targetCwd: string, hash: string): Promise<GitCommitInfo | null> {
  if (!targetCwd || !hash) return null
  try {
    const res = await gitCommitShow(targetCwd, hash)
    return res.success ? (res.commit ?? null) : null
  } catch {
    return null
  }
}

/** 加载当前 Git 用户身份 */
export async function loadCurrentUser(): Promise<void> {
  if (!state.cwd) return
  const res = await gitGetUserName(state.cwd)
  if (res.success && res.name) setState({ currentUser: res.name })
}

/** 加载提交历史作者列表（去重） */
export async function loadHistoryAuthors(): Promise<void> {
  if (!state.cwd) return
  const res = await gitListAuthors(state.cwd)
  if (res.success) setState({ historyAuthors: res.authors ?? [] })
}

// ---------- 分支 ----------

/** 加载本地分支列表（含各分支最新提交元信息） */
export async function loadBranches(): Promise<void> {
  if (!state.cwd) return
  const res = await gitListBranches(state.cwd)
  if (res.success) {
    setState({
      branches: res.branches ?? [],
      branchInfos: res.infos ?? [],
      ...(res.current ? { branch: res.current } : {})
    })
  }
}

/** 切换分支（有未提交改动时 git 会拒绝，错误透传） */
export async function checkout(name: string): Promise<GitResult> {
  const res = await mutate(() => gitCheckout(state.cwd, name), 'checkout')
  if (res.success) {
    // 分支变了，原来选中的文件 diff 与 hunk 基准全部作废
    setState({ selectedPath: '', currentDiff: null, hunksMap: {} })
    await loadBranches()
  }
  return res
}

/** 新建分支并切换；startPoint 缺省基于当前 HEAD */
export async function createBranch(name: string, startPoint?: string): Promise<GitResult> {
  const res = await mutate(() => gitCreateBranch(state.cwd, name, startPoint), 'checkout')
  if (res.success) await loadBranches()
  return res
}

export async function deleteBranch(name: string, force = false): Promise<GitResult> {
  const res = await mutate(() => gitDeleteBranch(state.cwd, name, force))
  if (res.success) await loadBranches()
  return res
}

export async function renameBranch(oldName: string, newName: string): Promise<GitResult> {
  const res = await mutate(() => gitRenameBranch(state.cwd, oldName, newName))
  if (res.success) await loadBranches()
  return res
}

export function publishBranch(): Promise<GitResult> {
  return mutate(() => gitPublishBranch(state.cwd), 'push')
}
export function merge(ref: string): Promise<GitResult> {
  return mutate(() => gitMerge(state.cwd, ref), 'merge')
}
export function mergeAbort(): Promise<GitResult> {
  return mutate(() => gitMergeAbort(state.cwd))
}
export function rebase(ref: string): Promise<GitResult> {
  return mutate(() => gitRebase(state.cwd, ref), 'rebase')
}
export function rebaseAbort(): Promise<GitResult> {
  return mutate(() => gitRebaseAbort(state.cwd))
}
export function cherryPick(hash: string): Promise<GitResult> {
  return mutate(() => gitCherryPick(state.cwd, hash), 'cherry-pick')
}
export function cherryPickAbort(): Promise<GitResult> {
  return mutate(() => gitCherryPickAbort(state.cwd))
}
export function revertCommit(hash: string): Promise<GitResult> {
  return mutate(() => gitRevertCommit(state.cwd, hash), 'revert')
}

// ---------- diff 预览 / hunks ----------

/** 加载指定文件的差异 */
export async function loadDiff(
  path: string,
  staged = false,
  base?: 'index' | 'head'
): Promise<GitFileDiff | null> {
  if (!state.cwd) {
    setState({ errorMessage: 'Git 能力不可用' })
    return null
  }
  setState({ selectedPath: path })
  try {
    const res = await gitDiff(state.cwd, path, staged, base)
    if (!res.success || !res.diff) {
      setState({ errorMessage: res.error ?? '获取差异失败', currentDiff: null })
      return null
    }
    setState({ currentDiff: res.diff })
    return res.diff
  } catch (error) {
    setState({ errorMessage: error instanceof Error ? error.message : '获取差异失败', currentDiff: null })
    return null
  }
}

/** 按文件路径读取已缓存的 hunk 列表，供编辑器 gutter 标记使用 */
export function hunksOf(path: string): GitFileDiff['hunks'] {
  return state.hunksMap[path] ?? []
}

/** HEAD 内容缓存（实时 diff 基准；refresh 时清空） */
const headCache: Record<string, string> = {}

/** 上次成功计算 hunks 时的 git 状态指纹（path → 指纹） */
const hunksFingerprint = new Map<string, string>()
/** 进行中的 hunks 加载按路径合并（激活 watch + refresh 并发触发时只发一次 diff） */
const hunkInflight = new Map<string, Promise<void>>()

/** 文件当前 git 状态指纹（gutter hunks 短路用） */
function statusFingerprint(relPath: string): string {
  const f = state.files.find((x) => normalizePath(x.path) === normalizePath(relPath))
  if (!f) return 'clean'
  return `${f.changeType}|${f.stagedChange ?? ''}|${f.unstagedChange ?? ''}|${f.stagedAdditions ?? 0}|${f.stagedDeletions ?? 0}|${f.unstagedAdditions ?? 0}|${f.unstagedDeletions ?? 0}`
}

/** 判断文件是否有未保存的缓冲区编辑（脏缓冲区的 hunks 归实时 diff 管） */
function isDirtyBuffer(relPath: string): boolean {
  // aether 目前没有编辑器脏缓冲区订阅通道；若后续接入 editor-store 的 dirty 标记，在此补判定。
  void relPath
  return false
}

/**
 * 加载指定文件的工作空间 hunk 列表到 hunksMap（gutter 高亮用）。
 * 缓冲区有未保存编辑时跳过 —— 以实时 diff（缓冲区 vs HEAD）为准。
 * git 状态指纹未变时跳过（含「算过是空」的情况）；并发触发 in-flight 合并。
 */
export async function loadHunksFor(path: string): Promise<void> {
  if (!state.cwd || !path) return
  if (isDirtyBuffer(path)) return
  const fp = statusFingerprint(path)
  if (hunksFingerprint.get(path) === fp) return
  const running = hunkInflight.get(path)
  if (running) return running
  const job = (async () => {
    try {
      // gutter 是 dirty diff：体现全部未提交改动（含已暂存），基准用 HEAD
      const res = await gitDiff(state.cwd, path, false, 'head')
      if (res.success && res.diff && res.diff.hunks.length > 0) {
        setState({ hunksMap: { ...state.hunksMap, [path]: res.diff.hunks } })
      } else {
        const next = { ...state.hunksMap }
        delete next[path]
        setState({ hunksMap: next })
      }
      hunksFingerprint.set(path, fp)
    } catch {
      const next = { ...state.hunksMap }
      delete next[path]
      setState({ hunksMap: next })
      hunksFingerprint.set(path, fp)
    } finally {
      hunkInflight.delete(path)
    }
  })()
  hunkInflight.set(path, job)
  return job
}

/**
 * 编辑器内容变化时实时计算 hunk 标记（缓冲区 vs HEAD，无需保存）。
 * aether 暂无编辑器 gutter 渲染层，接口保留供后续接入。
 */
export async function applyLiveHunks(path: string, content: string): Promise<void> {
  if (!state.cwd || !path) return
  if (!(path in headCache)) {
    const res = await gitHeadFile(state.cwd, path)
    if (!res.success) return
    headCache[path] = res.content ?? ''
  }
  const head = headCache[path]
  // 简化：无编辑器 gutter 时不跑 live diff，避免无谓计算；接口保留。
  if (head === content) {
    const next = { ...state.hunksMap }
    delete next[path]
    setState({ hunksMap: next })
  }
}

// ---------- 兼容旧只读面板（状态栏 / 资源管理器 / GitView） ----------

/** 旧 UI 消费的刷新入口别名 */
export const refresh = refreshGit

/**
 * 订阅完整 git 状态（新版 Git 面板用；字段即 GitStoreState 全量）
 */
export function useGitStore(): GitStoreState {
  return useSyncExternalStore(onGitChanged, getGitState, getGitState)
}

/**
 * 订阅 git 状态（旧只读面板兼容层：状态栏 / 资源管理器 / 旧 GitView）。
 * 返回的 commits 是 legacyCommits（refs 为拼接串），error 是 errorMessage 的别名。
 */
export function useGit(): Omit<GitStoreState, 'commits'> & {
  commits: GitStoreState['legacyCommits']
  error: string
  refresh: (root: string | null) => Promise<void>
} {
  const snapshot = useSyncExternalStore(onGitChanged, getGitState, getGitState)
  const { commits, ...rest } = snapshot
  void commits // 显式丢弃新格式 commits，对外只暴露 legacyCommits
  return { ...rest, commits: snapshot.legacyCommits, error: snapshot.errorMessage, refresh: refreshGit }
}

// ---------- 供 git-remote-actions / git-merge-strategy 消费的 store 切面 ----------

/** 远程操作编排需要的最小切面（git-remote-actions 的 GitRemoteStore） */
export const gitRemoteStore = {
  get cwd() {
    return state.cwd
  },
  get branch() {
    return state.branch
  },
  get upstream() {
    return state.upstream
  },
  sync,
  pull,
  pullRebase,
  push,
  publishBranch,
  fetchRemote,
  pullMerge,
  pullRebaseWithChoice,
  addSshKey
}

/** 合并策略编排需要的最小切面（git-merge-strategy 的 MergeStrategyStore） */
export const mergeStrategyStore = {
  divergence,
  pullMerge,
  pullRebaseWithChoice
}
