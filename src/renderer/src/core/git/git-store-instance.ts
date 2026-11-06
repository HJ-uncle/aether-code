/** Shared Git store implementation; each mounted task keeps its own instance. */
import { useSyncExternalStore } from 'react'
import {
  captureCodeGitTarget,
  gitFailure,
  GitRequestError,
  type GitTarget as TransportTarget
} from './git-target'
import type { ScopedGitClient } from './git-client'
import {
  captureGitCommand,
  createRepositoryOperation,
  type GitRepositoryOperation
} from './git-repository-operation'
import type {
  GitBlameLine,
  GitCommitInfo,
  GitCloneResult,
  GitFileChange,
  GitFileDiff,
  GitFileHistoryEntry,
  GitLogEntry,
  GitLogQuery,
  GitRemote,
  GitRemoteBranchInfo,
  GitResult
} from '@shared/git-types'
import { createGitClient, gitAddSshKey } from './git-client'
import * as codeClient from './git-client'
import { getGitAutoFetch, getGitAutoFetchIntervalMs, onGitPreferencesChanged } from './git-pref'
import { getEngineSource, isRemoteEngine, sessionStorageKey } from '../engine/source'
import { onWorkspaceConnectionChanged, workspaceConnectionKey } from '../workspace/connection'
import { getWorkspaceState } from '../workspace/workspace-store'

/** 路径归一化（跨 Windows / POSIX 比较用） */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** 外部 fs 变更 → git 刷新的防抖口径（将来接入真实 fs 事件时复用） */
const REFRESH_DEBOUNCE_MS = 300
const REFRESH_MIN_INTERVAL_MS = 5000

/** 时间线分页大小，对齐 VSCode timeline.pageSize 默认值 */
const TIMELINE_PAGE_SIZE = 50
const LOG_CACHE_TTL_MS = 60_000

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
  commitProposal: string
  committing: boolean
  /** 正在执行的写操作名（空串表示空闲），一次只有一个 */
  operation: string
  repositoryOperation: GitRepositoryOperation | null
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
  logLoaded: boolean
  logLoading: boolean
  logError: string
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
  status: {
    isRepo: boolean
    branch: string
    ahead: number | null
    behind: number | null
    changes: GitFileChange[]
  } | null
  /** 旧版只读面板视图模型：提交列表（新→旧），从 commits 派生 */
  legacyCommits: {
    hash: string
    shortHash: string
    subject: string
    author: string
    date: string
    refs: string
  }[]
  /** 是否已针对当前 root 成功拉取过（旧 UI 据此区分「加载中」与「空态」） */
  loaded: boolean
}

function emptyState(): GitStoreState {
  return {
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
    commitProposal: '',
    committing: false,
    operation: '',
    repositoryOperation: null,
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
    logLoaded: false,
    logLoading: false,
    logError: '',
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
}
export interface GitStoreOptions {
  captureTarget?: () => Promise<TransportTarget>
  identity?: () => string
  draftKey?: string
  initialCwd?: string
}

export interface GitPushManyResult extends GitResult {
  results: Array<{ remote: string; ok: boolean; error?: string }>
}

/** Code and each Work task own independent snapshots, drafts and operation controllers. */
export function createGitStore(options: GitStoreOptions = {}) {
  let targetFlight: Promise<TransportTarget> | null = null
  async function captureTarget(): Promise<TransportTarget> {
    const selection = captureGitTarget()
    let flight = targetFlight
    if (!flight) {
      flight = options.captureTarget ? options.captureTarget() : captureCodeGitTarget(selection.cwd)
      targetFlight = flight
      void flight
        .finally(() => {
          if (targetFlight === flight) targetFlight = null
        })
        .catch(() => undefined)
    }
    const target = await flight
    assertGitTarget(selection)
    return target
  }
  async function getClient(): Promise<ScopedGitClient> {
    return createGitClient(await captureTarget())
  }
  // Session reads share one supervisor lane. Parallel status/history/hover reads
  // otherwise contend for the engine's exclusive repository lease.
  let readTail: Promise<unknown> = Promise.resolve()
  function serialized<T>(run: () => Promise<T>): Promise<T> {
    if (!options.captureTarget) return run()
    const result = readTail.then(run, run)
    readTail = result.catch(() => undefined)
    return result
  }
  function read<T>(run: (client: ScopedGitClient) => Promise<T>): Promise<T> {
    const selection = captureGitTarget()
    const invoke = async (): Promise<T> => {
      assertGitTarget(selection)
      const client = await getClient()
      return run(client)
    }
    return serialized(invoke)
  }
  const gitBlame = (_cwd: string, ...args: Parameters<ScopedGitClient['gitBlame']>) =>
    options.captureTarget
      ? read((client) => client.gitBlame(...args))
      : codeClient.gitBlame(_cwd, ...args)
  const gitBranchInfo = (_cwd: string, ...args: Parameters<ScopedGitClient['gitBranchInfo']>) =>
    options.captureTarget
      ? read((client) => client.gitBranchInfo(...args))
      : codeClient.gitBranchInfo(_cwd, ...args)
  const gitCheckIgnored = (
    _cwd: string,
    ...args: Parameters<ScopedGitClient['gitCheckIgnored']>
  ) =>
    options.captureTarget
      ? read((client) => client.gitCheckIgnored(...args))
      : codeClient.gitCheckIgnored(_cwd, ...args)
  const gitCommitShow = (_cwd: string, ...args: Parameters<ScopedGitClient['gitCommitShow']>) =>
    options.captureTarget
      ? read((client) => client.gitCommitShow(...args))
      : codeClient.gitCommitShow(_cwd, ...args)
  const gitDiff = (_cwd: string, ...args: Parameters<ScopedGitClient['gitDiff']>) =>
    options.captureTarget
      ? read((client) => client.gitDiff(...args))
      : codeClient.gitDiff(_cwd, ...args)
  const gitDivergence = (_cwd: string, ...args: Parameters<ScopedGitClient['gitDivergence']>) =>
    options.captureTarget
      ? read((client) => client.gitDivergence(...args))
      : codeClient.gitDivergence(_cwd, ...args)
  const gitFetch = (_cwd: string, ...args: Parameters<ScopedGitClient['gitFetch']>) =>
    options.captureTarget
      ? read((client) => client.gitFetch(...args))
      : codeClient.gitFetch(_cwd, ...args)
  const gitFileHistory = (_cwd: string, ...args: Parameters<ScopedGitClient['gitFileHistory']>) =>
    options.captureTarget
      ? read((client) => client.gitFileHistory(...args))
      : codeClient.gitFileHistory(_cwd, ...args)
  const gitGetUserName = (_cwd: string, ...args: Parameters<ScopedGitClient['gitGetUserName']>) =>
    options.captureTarget
      ? read((client) => client.gitGetUserName(...args))
      : codeClient.gitGetUserName(_cwd, ...args)
  const gitHeadFile = (_cwd: string, ...args: Parameters<ScopedGitClient['gitHeadFile']>) =>
    options.captureTarget
      ? read((client) => client.gitHeadFile(...args))
      : codeClient.gitHeadFile(_cwd, ...args)
  const gitIncoming = (_cwd: string, ...args: Parameters<ScopedGitClient['gitIncoming']>) =>
    options.captureTarget
      ? read((client) => client.gitIncoming(...args))
      : codeClient.gitIncoming(_cwd, ...args)
  const gitListAuthors = (_cwd: string, ...args: Parameters<ScopedGitClient['gitListAuthors']>) =>
    options.captureTarget
      ? read((client) => client.gitListAuthors(...args))
      : codeClient.gitListAuthors(_cwd, ...args)
  const gitListBranches = (
    _cwd: string,
    ...args: Parameters<ScopedGitClient['gitListBranches']>
  ) =>
    options.captureTarget
      ? read((client) => client.gitListBranches(...args))
      : codeClient.gitListBranches(_cwd, ...args)
  const gitListRemoteBranches = (
    _cwd: string,
    ...args: Parameters<ScopedGitClient['gitListRemoteBranches']>
  ) =>
    options.captureTarget
      ? read((client) => client.gitListRemoteBranches(...args))
      : codeClient.gitListRemoteBranches(_cwd, ...args)
  const gitListRemotes = (_cwd: string, ...args: Parameters<ScopedGitClient['gitListRemotes']>) =>
    options.captureTarget
      ? read((client) => client.gitListRemotes(...args))
      : codeClient.gitListRemotes(_cwd, ...args)
  const gitListStashes = (_cwd: string, ...args: Parameters<ScopedGitClient['gitListStashes']>) =>
    options.captureTarget
      ? read((client) => client.gitListStashes(...args))
      : codeClient.gitListStashes(_cwd, ...args)
  const gitListTags = (_cwd: string, ...args: Parameters<ScopedGitClient['gitListTags']>) =>
    options.captureTarget
      ? read((client) => client.gitListTags(...args))
      : codeClient.gitListTags(_cwd, ...args)
  const gitLog = (_cwd: string, ...args: Parameters<ScopedGitClient['gitLog']>) =>
    options.captureTarget
      ? read((client) => client.gitLog(...args))
      : codeClient.gitLog(_cwd, ...args)
  const gitStatus = (_cwd: string, ...args: Parameters<ScopedGitClient['gitStatus']>) =>
    options.captureTarget
      ? read((client) => client.gitStatus(...args))
      : codeClient.gitStatus(_cwd, ...args)
  let state: GitStoreState = emptyState()
  let commitDraftRevision = 0

  const listeners = new Set<() => void>()

  function setState(patch: Partial<GitStoreState>): void {
    // Value equality misses edits that return to the original text (ABA).
    // Repository reselection also invalidates pending AI draft writes.
    if (
      (Object.hasOwn(patch, 'commitMessage') && patch.commitMessage !== state.commitMessage) ||
      (Object.hasOwn(patch, 'cwd') && patch.cwd !== state.cwd)
    )
      commitDraftRevision += 1
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  function getGitState(): GitStoreState {
    return state
  }
  function getCommitDraftRevision(): number {
    return commitDraftRevision
  }

  // ==================== 提交信息草稿持久化（按仓库 cwd） ====================

  const COMMIT_DRAFTS_KEY = 'aether:gitCommitDrafts'
  const MAX_DRAFT_SLOTS = 50

  function readCommitDrafts(
    storageKey = sessionStorageKey(COMMIT_DRAFTS_KEY)
  ): Record<string, string> {
    try {
      const raw = localStorage.getItem(storageKey)
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
    return readCommitDrafts()[options.draftKey ?? cwd] ?? ''
  }

  let commitDraftTimer = 0

  /** 防抖落盘：提交信息是高频输入，每次按键都写 localStorage 不值 */
  function scheduleCommitDraftSave(cwd: string, text: string): void {
    if (!cwd) return
    const storageKey = sessionStorageKey(COMMIT_DRAFTS_KEY)
    clearTimeout(commitDraftTimer)
    commitDraftTimer = window.setTimeout(() => {
      const table = readCommitDrafts(storageKey)
      const slot = options.draftKey ?? cwd
      if (!text.trim()) {
        delete table[slot]
      } else {
        delete table[slot]
        table[slot] = text
        const keys = Object.keys(table)
        while (keys.length > MAX_DRAFT_SLOTS) delete table[keys.shift() as string]
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify(table))
      } catch {
        // 存储写失败不打断输入
      }
    }, 400)
  }

  /** 提交成功后清空输入框与对应草稿 */
  function clearCommitMessage(): void {
    clearTimeout(commitDraftTimer)
    setState({ commitMessage: '', commitProposal: '' })
    scheduleCommitDraftSave(state.cwd, '')
  }

  /** 提交信息输入框的受控 setter（GitCommitBar 输入 / AI 生成回填用） */
  function setCommitMessage(v: string): void {
    setState({ commitMessage: v })
    scheduleCommitDraftSave(state.cwd, v)
  }

  function setCommitProposal(value: string): void {
    setState({ commitProposal: value })
  }

  /** Suggestions reserve the task even while its view is hidden or remounted. */
  function beginSuggestion(): (() => void) | null {
    if (state.operation || state.committing || state.loading) return null
    const target = captureGitTarget()
    setState({ operation: 'suggestion' })
    let released = false
    return () => {
      if (released) return
      released = true
      if (canSettleSelection(target) && state.operation === 'suggestion') setState({ operation: '' })
    }
  }

  function onGitChanged(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  // ---------- 投影（wuzu 的 computed；files 规模小，现算即可） ----------

  /** 暂存组：分别以「暂存视角」出现的文件（对齐 VSCode 分组，一个 MM 文件两边各出现一次） */
  function stagedFilesOf(s: GitStoreState): GitFileChange[] {
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
  function unstagedFilesOf(s: GitStoreState): GitFileChange[] {
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
  function conflictFilesOf(s: GitStoreState): GitFileChange[] {
    return s.files.filter((f) => f.conflict === true)
  }

  function changeCountOf(s: GitStoreState): number {
    return s.files.length
  }
  function totalAdditionsOf(s: GitStoreState): number {
    return s.files.reduce((sum, f) => sum + f.additions, 0)
  }
  function totalDeletionsOf(s: GitStoreState): number {
    return s.files.reduce((sum, f) => sum + f.deletions, 0)
  }
  /** 是否存在可提交内容：暂存区或工作区任一有改动即可（对齐 VSCode smart commit） */
  function hasChangesToCommitOf(s: GitStoreState): boolean {
    return stagedFilesOf(s).length > 0 || s.files.length > 0
  }
  /** 仅暂存区有内容可提交（下拉「提交（暂存区）」等只认暂存区的入口用） */
  function canCommitStagedOf(s: GitStoreState): boolean {
    return stagedFilesOf(s).length > 0 && s.commitMessage.trim().length > 0 && !s.committing
  }
  /** 主提交按钮可用性：有可提交内容且填了信息 */
  function canCommitOf(s: GitStoreState): boolean {
    return hasChangesToCommitOf(s) && s.commitMessage.trim().length > 0 && !s.committing
  }
  /** 正在进行的长耗时写操作名（空串表示没有，工具栏 / 菜单 / 提交区据此统一禁用入口） */
  function busyOperationOf(s: GitStoreState): string {
    return s.operation
  }
  /** 分支下拉数据源：当前分支置顶，其余保持主进程的提交时间倒序 */
  function sortedBranchesOf(s: GitStoreState): string[] {
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
  let incomingRevision = 0
  let logLoadedAt = 0
  let logRevision = 0
  let logFlight: { key: string; promise: Promise<void> } | null = null
  let selectionRevision = 0
  let selectedConnection = ''
  let connectionDispose: (() => void) | null = null

  function connectionIdentity(): string {
    return (
      options.identity?.() ??
      JSON.stringify([workspaceConnectionKey(), isRemoteEngine() ? getEngineSource() : null])
    )
  }

  interface GitTarget {
    cwd: string
    revision: number
    connection: string
  }
  function captureGitTarget(): GitTarget {
    return { cwd: state.cwd, revision: selectionRevision, connection: connectionIdentity() }
  }
  function sameGitTarget(target: GitTarget): boolean {
    return (
      ownsSelection(target) &&
      target.connection === connectionIdentity()
    )
  }
  function ownsSelection(target: GitTarget): boolean {
    return target.cwd === state.cwd && target.revision === selectionRevision
  }
  function canSettleSelection(target: GitTarget): boolean {
    // A task instance remains owned by that task after its engine is retired.
    // Its finished reservation must become evictable, without touching a newer
    // Code selection or accepting any old result into the current snapshot.
    return sameGitTarget(target) || Boolean(options.captureTarget && ownsSelection(target))
  }
  function assertGitTarget(target: GitTarget): void {
    if (!sameGitTarget(target)) throw new Error('工作区连接或目录已经切换，已取消旧 Git 操作')
  }

  async function loadResult<T extends GitResult>(
    target: GitTarget,
    action: () => Promise<T>,
    current: () => boolean = () => sameGitTarget(target)
  ): Promise<T | undefined> {
    try {
      const result = await action()
      if (!current()) return undefined
      if (!result.success) setState({ errorMessage: result.error || '读取 Git 数据失败' })
      return result
    } catch (error) {
      if (current()) setState({ errorMessage: gitFailure(error).error || '读取 Git 数据失败' })
      return undefined
    }
  }

  function resetSelection(cwd: string): void {
    repositoryOperationDispose?.()
    repositoryOperationDispose = null
    selectionRevision++
    commitDraftRevision++
    targetFlight = null
    selectedConnection = connectionIdentity()
    // A previous endpoint may use the exact same absolute path. None of its
    // repository metadata or in-flight results belongs to this selection.
    inflight = null
    queued = null
    operationCount = 0
    mergeMsgApplied = false
    incomingKey = ''
    incomingLoadedAt = 0
    incomingRevision++
    logLoadedAt = 0
    logRevision++
    logFlight = null
    lastAutoFetchOkAt = 0
    autoFetchFailures = 0
    if (fsRefreshTimer) clearTimeout(fsRefreshTimer)
    fsRefreshTimer = null
    clearBlame()
    blameInflight.clear()
    hunkInflight.clear()
    hunksFingerprint.clear()
    for (const key of Object.keys(headCache)) delete headCache[key]
    setState({ ...emptyState(), cwd, commitMessage: loadCommitDraft(cwd), loading: Boolean(cwd) })
  }

  function wireConnection(): void {
    if (options.captureTarget) return
    connectionDispose ??= onWorkspaceConnectionChanged(() => {
      if (selectedConnection === connectionIdentity()) return
      resetSelection('')
      // The workspace store clears its old mount synchronously on a connection
      // change; an unchanged local path can still need a fresh Git snapshot.
      void refreshGit(getWorkspaceState().root)
    })
  }

  // ==================== 刷新 ====================

  /**
   * 刷新工作空间变更列表与分支信息。
   *
   * 并发时不直接复用在跑的那次，而是排队补刷一次：正在跑的那次可能是撤回**之前**
   * 发起的，读到的是旧状态；直接复用会让撤回完成后界面停在旧数据上。
   */
  function refreshGit(root: string | null, options: { background?: boolean } = {}): Promise<void> {
    wireConnection()
    const nextCwd = root ?? ''
    if (state.cwd !== nextCwd || selectedConnection !== connectionIdentity())
      resetSelection(nextCwd)
    const background = options.background === true && state.loaded
    if (!background) setState({ loading: true })
    const target = captureGitTarget()
    if (inflight) {
      if (background) return inflight
      if (!queued) {
        queued = inflight
          .catch(() => undefined)
          .then(() => {
            if (!sameGitTarget(target)) return
            queued = null
            return refreshGit(state.cwd)
          })
      }
      return queued
    }
    const run = doRefresh(target, background).finally(() => {
      if (inflight === run) inflight = null
    })
    inflight = run
    return run
  }

  async function readStatus(target: GitTarget, capturedClient?: ScopedGitClient) {
    const orphan = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false
      const result = value as GitResult
      return (
        result.errorCode === 'git-orphan' ||
        (typeof result.error === 'string' &&
          /Git operation left a verified orphan lease/i.test(result.error))
      )
    }
    const recover = async () => {
      assertGitTarget(target)
      const run = async (client: ScopedGitClient) => {
        // A late status error must never recover the newly selected repository.
        // Native and session transports both verify the physical lease generation.
        assertGitTarget(target)
        const lease = await client.gitLeaseStatus()
        assertGitTarget(target)
        const generation = lease.lease?.generation
        if (!lease.success || lease.lease?.busy !== true || lease.lease.recoverable !== true || typeof generation !== 'string' || !generation)
          throw new Error('Git 存在可疑中断占用，请先重新核对仓库状态')
        const recovered = await client.gitRecoverLease(generation)
        assertGitTarget(target)
        if (!recovered.success || recovered.lease?.busy !== false)
          throw new Error(recovered.error || 'Git 中断占用尚未解除，请稍后重试')
        return client.gitStatus()
      }
      return capturedClient ? run(capturedClient) : read(run)
    }
    try {
      const result = await (capturedClient ? capturedClient.gitStatus() : gitStatus(target.cwd))
      return !result.success && orphan(result) ? recover() : result
    } catch (error) {
      if (!(error instanceof GitRequestError) || !orphan(error.failure))
        throw error
      return recover()
    }
  }

  async function doRefresh(target: GitTarget, background: boolean): Promise<void> {
    const nextCwd = target.cwd
    const previousBranch = state.branch
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
    if (!background) setState({ loading: true, errorMessage: '' })
    try {
      const refreshSnapshot = async (client?: ScopedGitClient): Promise<void> => {
        const statusRes = await readStatus(target, client)
        // 请求期间可能已切走仓库，迟到的结果不能覆盖新仓库。
        if (!sameGitTarget(target)) return
        if (!statusRes.success) {
          // 瞬态失败保留已展示的文件，避免分组塌陷和滚动位置丢失。
          const message = statusRes.error ?? '获取变更失败'
          if (state.errorMessage !== message) setState({ errorMessage: message })
          return
        }
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
        const isRepo = statusRes.isRepo ?? false
        const branch = isRepo ? state.branch : ''
        const upstream = isRepo ? state.upstream : null
        const ahead = isRepo ? state.ahead : null
        const behind = isRepo ? state.behind : null
        const status = {
          isRepo: statusRes.isRepo ?? false,
          branch,
          ahead,
          behind,
          changes: files
        }
        const patch: Partial<GitStoreState> = {
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
          ...(!isRepo ? { stashes: [], commits: [], legacyCommits: [], logLoaded: false,
            logLoading: false, logLoadingMore: false, logError: '' } : {}),
          loaded: true,
          errorMessage: ''
        }
        // File status is independently useful; a slow branch read must not hold
        // the first list behind the loading placeholder or discard it on failure.
        if (
          !background ||
          Object.entries(patch).some(
            ([key, value]) =>
              JSON.stringify(state[key as keyof GitStoreState]) !== JSON.stringify(value)
          )
        )
          setState(patch)
        if (!isRepo) {
          logRevision++
          logFlight = null
          logLoadedAt = 0
          clearIncoming()
          return
        }
        const branchRes = await (client ? client.gitBranchInfo() : gitBranchInfo(nextCwd))
        if (!sameGitTarget(target)) return
        if (!branchRes.success) throw new Error(branchRes.error || '读取分支状态失败')
        const info = branchRes.info
        if (info && (state.branch !== info.branch || state.upstream !== info.upstream || state.ahead !== info.ahead || state.behind !== info.behind))
          setState({
            branch: info.branch,
            upstream: info.upstream,
            ahead: info.ahead,
            behind: info.behind,
            status: { ...status, branch: info.branch, ahead: info.ahead, behind: info.behind }
          })
        // Stashes can change without changing the worktree or branch, so a
        // refresh must read their refs even when the file snapshot is identical.
        const stashRes = await (client ? client.gitListStashes() : gitListStashes(nextCwd))
        if (!sameGitTarget(target)) return
        if (!stashRes.success) throw new Error(stashRes.error || '读取存储列表失败')
        const stashes = stashRes.stashes ?? []
        if (JSON.stringify(state.stashes) !== JSON.stringify(stashes)) setState({ stashes })
      }
      // One frozen task client avoids repeating bind/directory discovery between
      // these reads. Each transport call still verifies the binding on both sides.
      if (options.captureTarget) await read(refreshSnapshot)
      else await refreshSnapshot()
      if (!sameGitTarget(target)) return
      if (background) {
        if (state.isRepo && (state.logLoaded || state.logLoading)) {
          if (state.branch !== previousBranch) void reloadLog(Math.max(50, state.commits.length))
          else void ensureLog(Math.max(50, state.commits.length))
        }
        return
      }
      // 状态变化后重载 hunks，保证编辑器 gutter 与磁盘一致（aether 暂无 gutter 渲染层，按需接入）。
      // HEAD 可能已前进（commit / checkout / pull / merge）：行内 blame 缓存同步失效。
      clearBlame()
      // History revalidation must not extend file-status loading or the write
      // operation. Keep the cached rows visible while its own request completes.
      if (state.logLoaded || state.logLoading) void reloadLog(Math.max(50, state.commits.length))
    } catch (error) {
      const message = error instanceof Error ? error.message : '获取变更失败'
      if (sameGitTarget(target) && state.errorMessage !== message)
        setState({ errorMessage: message })
    } finally {
      if (!background && sameGitTarget(target)) setState({ loading: false })
    }
  }

  /** 强制刷新：跳过最小间隔（手动刷新按钮等用户明确期待的时机用） */
  async function forceRefreshGit(): Promise<void> {
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
  function scheduleFsRefresh(nextCwd: string): void {
    if (!nextCwd) return
    const target = captureGitTarget()
    if (fsRefreshTimer) clearTimeout(fsRefreshTimer)
    fsRefreshTimer = setTimeout(() => {
      fsRefreshTimer = null
      if (!sameGitTarget(target)) return
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
  let autoFetchPreferenceDispose: (() => void) | null = null

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
    const selection = captureGitTarget()
    autoFetchBusy = true
    try {
      const fetched = await runDroppable(() => gitFetch(target))
      if (!fetched || !sameGitTarget(selection)) return
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
      if (!sameGitTarget(selection)) return
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
    if (disposed || !autoFetchStarted) return
    if (!getGitAutoFetch()) return
    autoFetchTimer = setTimeout(() => {
      autoFetchTimer = null
      if (disposed) return
      void autoFetchRemote().finally(scheduleAutoFetch)
    }, currentAutoFetchInterval(getGitAutoFetchIntervalMs()))
  }

  /** 启动自动获取（幂等）。aether 是单例视图，由应用根部生命周期调用一次即可。 */
  function startGitAutoFetch(): void {
    if (disposed || autoFetchStarted) return
    autoFetchStarted = true
    autoFetchPreferenceDispose ??= onGitPreferencesChanged(() => {
      if (autoFetchStarted) scheduleAutoFetch()
    })
    scheduleAutoFetch()
  }

  /** 距上次成功获取超过 minMs 才真正 fetch（窗口回前台 / 手动刷新兜底用） */
  async function autoFetchIfStale(minMs = 60000): Promise<void> {
    if (minMs > 0 && Date.now() - lastAutoFetchOkAt < minMs) return
    await autoFetchRemote()
  }

  /** 供 git-remote-actions 使用的内部自动 fetch（同 wuzu 的 autoFetchRemote） */
  const autoFetchRemoteForStore = autoFetchRemote

  /** 停止自动获取并清理定时器（应用退出 / 测试用） */
  function stopGitAutoFetch(): void {
    autoFetchStarted = false
    if (autoFetchTimer) clearTimeout(autoFetchTimer)
    autoFetchTimer = null
    autoFetchPreferenceDispose?.()
    autoFetchPreferenceDispose = null
  }

  function disposeGitStore(): void {
    logRevision++
    incomingRevision++
    logFlight = null
    stopGitAutoFetch()
    clearTimeout(commitDraftTimer)
    repositoryOperationDispose?.()
    repositoryOperationDispose = null
    disposed = true
    if (autoFetchTimer) {
      clearTimeout(autoFetchTimer)
      autoFetchTimer = null
    }
    if (fsRefreshTimer) {
      clearTimeout(fsRefreshTimer)
      fsRefreshTimer = null
    }
    autoFetchPreferenceDispose?.()
    autoFetchPreferenceDispose = null
    autoFetchStarted = false
    connectionDispose?.()
    connectionDispose = null
  }

  // ==================== 写操作 ====================

  /** 执行写操作并在成功后刷新列表。执行期间把操作名登记到 operation，供 UI 共用同一份「进行中」真相。 */
  let operationCount = 0
  let repositoryOperationDispose: (() => void) | null = null
  async function mutate(
    run: (client: ScopedGitClient) => Promise<GitResult>,
    opName = 'write',
    onSuccess?: () => void | Promise<void>
  ): Promise<GitResult> {
    if (!state.cwd) return { success: false, error: 'Git 能力不可用' }
    if (state.operation === 'suggestion')
      return { success: false, error: '正在生成提交信息，请稍后重试' }
    if (options.captureTarget && state.operation)
      return { success: false, error: '当前任务还有 Git 操作正在处理' }
    const target = captureGitTarget()
    setState({ operation: opName, committing: opName === 'commit' })
    operationCount++
    try {
      // Capture before entering the local queue; later drafts and directories must
      // never become the operands of an already requested command or its retry.
      const scopedTarget = await (options.captureTarget
        ? captureTarget()
        : captureCodeGitTarget(target.cwd))
      assertGitTarget(target)
      const operation = createRepositoryOperation({
        target: scopedTarget,
        label: operationLabel(opName),
        assertCurrent: () => assertGitTarget(target),
        run: (client) =>
          runQueued(async () => {
            assertGitTarget(target)
            return serialized(async () => {
              assertGitTarget(target)
              return run(client)
            })
          }),
        onSuccess: async () => {
          assertGitTarget(target)
          await onSuccess?.()
          assertGitTarget(target)
          await refreshGit(target.cwd)
          assertGitTarget(target)
          if (state.errorMessage) throw new Error(state.errorMessage)
        }
      })
      repositoryOperationDispose?.()
      repositoryOperationDispose = operation.subscribe(() => {
        if (state.repositoryOperation !== operation) return
        const snapshot = operation.getSnapshot()
        if (!sameGitTarget(target)) {
          if (canSettleSelection(target) && !snapshot.pending)
            setState({ operation: '', committing: false })
          return
        }
        const executing = snapshot.pending !== null
        setState({
          errorMessage: snapshot.phase === 'failed' ? (snapshot.failure?.error ?? '操作失败') : '',
          ...(executing
            ? { operation: opName, committing: opName === 'commit' }
            : operationCount === 0
              ? { operation: '', committing: false }
              : {})
        })
      })
      setState({ repositoryOperation: operation })
      return await operation.start()
    } catch (error) {
      const failure = gitFailure(error)
      if (sameGitTarget(target)) setState({ errorMessage: failure.error ?? '操作失败' })
      return failure
    } finally {
      if (canSettleSelection(target)) operationCount--
      if (canSettleSelection(target) && operationCount <= 0) {
        operationCount = 0
        const pending = state.repositoryOperation?.getSnapshot().pending
        if (pending !== 'run' && pending !== 'retry') setState({ operation: '', committing: false })
      }
    }
  }
  function operationLabel(name: string): string {
    const labels: Record<string, string> = {
      commit: '提交',
      fetch: '获取更新',
      pull: '拉取',
      push: '推送',
      sync: '同步',
      stash: '存储',
      checkout: '切换分支',
      merge: '合并',
      rebase: '变基',
      'cherry-pick': '拣选',
      revert: '还原提交',
      remote: '远程操作',
      write: 'Git 操作'
    }
    return labels[name] ?? 'Git 操作'
  }

  // ---------- 状态 / diff ----------

  function gitInitRepo(): Promise<GitResult> {
    return mutate(captureGitCommand('gitInit'))
  }

  function appendGitignore(path: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitAppendGitignore', path))
  }

  async function cloneRepository(url: string): Promise<GitCloneResult> {
    let clone: GitCloneResult | undefined
    const result = await mutate(async (client) => {
      clone = await client.gitCloneRepository(url)
      return clone
    }, 'clone')
    return result.success && clone ? clone : result
  }

  function stage(path: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitStage', path))
  }
  function unstage(path: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitUnstage', path))
  }
  function discardFile(path: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitDiscardFile', path))
  }
  function discardWorktree(path: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitDiscardWorktree', path))
  }
  function discardWorktreeFiles(paths: string[]): Promise<GitResult> {
    return mutate(captureGitCommand('gitDiscardWorktreeFiles', paths))
  }
  function stageFiles(paths: string[]): Promise<GitResult> {
    return mutate(captureGitCommand('gitStageFiles', paths))
  }
  function unstageFiles(paths: string[]): Promise<GitResult> {
    return mutate(captureGitCommand('gitUnstageFiles', paths))
  }
  function discardFiles(paths: string[]): Promise<GitResult> {
    return mutate(captureGitCommand('gitDiscardFiles', paths))
  }
  function discardHunk(path: string, hunkId: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitDiscardHunk', path, hunkId))
  }

  /** 查询哪些路径被 .gitignore 忽略（只读，不触发刷新） */
  async function checkIgnored(paths: string[]): Promise<Set<string> | null> {
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
  function commitSuccess(target: GitTarget, revision: number): () => void {
    return () => {
      if (!sameGitTarget(target)) return
      if (commitDraftRevision === revision) clearCommitMessage()
      setState({ selectedPath: '', currentDiff: null })
    }
  }
  function commit(): Promise<GitResult> {
    const target = captureGitTarget(),
      revision = commitDraftRevision
    const command = stagedFilesOf(state).length > 0 ? 'gitCommit' : 'gitStageAllAndCommit'
    return mutate(
      captureGitCommand(command, state.commitMessage),
      'commit',
      commitSuccess(target, revision)
    )
  }
  function commitStaged(): Promise<GitResult> {
    if (stagedFilesOf(state).length === 0)
      return Promise.resolve({ success: false, error: '暂存区没有可提交的内容' })
    const target = captureGitTarget(),
      revision = commitDraftRevision
    return mutate(
      captureGitCommand('gitCommit', state.commitMessage),
      'commit',
      commitSuccess(target, revision)
    )
  }
  function commitAll(): Promise<GitResult> {
    const target = captureGitTarget(),
      revision = commitDraftRevision
    return mutate(
      captureGitCommand('gitStageAllAndCommit', state.commitMessage),
      'commit',
      commitSuccess(target, revision)
    )
  }
  function commitAmend(message?: string): Promise<GitResult> {
    const target = captureGitTarget(),
      revision = commitDraftRevision
    return mutate(
      message?.trim()
        ? captureGitCommand('gitCommitAmendWithMessage', message)
        : captureGitCommand('gitCommitAmend'),
      'commit',
      commitSuccess(target, revision)
    )
  }

  function undoCommit(): Promise<GitResult> {
    return mutate(captureGitCommand('gitUndoCommit'))
  }

  function commitEmpty(message: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitCommitEmpty', message))
  }

  // ---------- 远程 ----------

  function fetchRemote(): Promise<GitResult> {
    return mutate(captureGitCommand('gitFetch'), 'fetch')
  }
  function pull(): Promise<GitResult> {
    return mutate(captureGitCommand('gitPull'), 'pull')
  }
  function push(): Promise<GitResult> {
    return mutate(captureGitCommand('gitPush'), 'push')
  }
  /** 分叉计数：只读查询，不触发写操作后的状态刷新 */
  async function divergence(): Promise<GitResult & { ahead?: number; behind?: number }> {
    if (!state.cwd) return { success: false, error: 'Git 能力不可用' }
    return gitDivergence(state.cwd)
  }
  function pullMerge(remember: boolean): Promise<GitResult> {
    return mutate(captureGitCommand('gitPullMerge', remember), 'pull')
  }
  function pullRebaseWithChoice(remember: boolean): Promise<GitResult> {
    return mutate(captureGitCommand('gitPullRebaseWithChoice', remember), 'pull')
  }
  /** 装载 SSH 私钥：不走 mutate，避免成功后又触发一次必然失败的远程刷新 */
  async function addSshKey(passphrase: string): Promise<GitResult> {
    if (options.captureTarget) return { success: false, error: '请在任务所在引擎配置 SSH 凭据' }
    return gitAddSshKey(passphrase)
  }
  function sync(): Promise<GitResult> {
    return mutate(captureGitCommand('gitSync'), 'sync')
  }
  function pullRebase(): Promise<GitResult> {
    return mutate(captureGitCommand('gitPullRebase'), 'pull')
  }
  function pushForce(): Promise<GitResult> {
    return mutate(captureGitCommand('gitPushForce'), 'push')
  }
  function pushTags(): Promise<GitResult> {
    return mutate(captureGitCommand('gitPushTags'), 'push')
  }
  function pushTag(name: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitPushTag', name), 'push')
  }
  function pullFrom(remote: string, branch: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitPullFrom', remote, branch), 'pull')
  }
  function pushTo(remote: string, branch?: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitPushTo', remote, branch), 'push')
  }
  function pushToBranch(remote: string, dstBranch: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitPushToBranch', remote, dstBranch), 'push')
  }
  async function pushToMany(remotes: string[]): Promise<GitPushManyResult> {
    const destinations = [...new Set(remotes.map(remote => remote.trim()).filter(Boolean))]
    const results: GitPushManyResult['results'] = []
    if (destinations.length === 0)
      return { success: false, executionDisposition: 'not_started', error: '请至少选择一个远程', results }
    const selection = captureGitTarget()
    const outcome = await mutate(async client => {
      results.length = 0
      const current = await client.gitBranchInfo()
      if (!current.success) return current
      const branch = current.info?.branch.trim()
      if (!branch || branch === 'HEAD' || branch === '(detached)')
        return { success: false, executionDisposition: 'not_started', error: '当前不在任何分支上，无法推送。' }
      let allNotStarted = true
      for (const remote of destinations) {
        let result: GitResult
        try { result = await client.gitPushTo(remote, branch) }
        catch (error) { result = gitFailure(error) }
        results.push({ remote, ok: result.success, ...(result.error ? { error: result.error } : {}) })
        if (result.success || result.executionDisposition !== 'not_started') allNotStarted = false
      }
      const report = results.map(item => `${item.remote}：${item.ok ? '成功' : `失败（${item.error || '未知错误'}）`}`).join('\n')
      return results.every(item => item.ok)
        ? { success: true, notice: report }
        : { success: false, error: report, executionDisposition: allNotStarted ? 'not_started' : 'may_have_effects' }
    }, 'push')
    // A failed destination cannot undo successful pushes. Refresh the retained
    // task snapshot while leaving the failed operation available for inspection.
    if (!outcome.success && results.some(item => item.ok) && sameGitTarget(selection))
      await refreshGit(selection.cwd)
    return { ...outcome, results: [...results] }
  }
  function deleteRemoteBranch(remote: string, branch: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitDeleteRemoteBranch', remote, branch), 'remote')
  }
  function deleteRemoteTag(name: string, remote?: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitDeleteRemoteTag', name, remote), 'remote')
  }

  async function loadRemotes(): Promise<void> {
    if (!state.cwd) return
    const target = captureGitTarget()
    const res = await loadResult(target, () => gitListRemotes(state.cwd))
    if (!res) return
    if (res.success) setState({ remotes: res.remotes ?? [] })
  }

  async function loadRemoteBranches(): Promise<void> {
    if (!state.cwd) return
    const target = captureGitTarget()
    const res = await loadResult(target, () => gitListRemoteBranches(state.cwd))
    if (!res) return
    if (res.success) {
      setState({
        remoteBranches: res.branches ?? [],
        remoteBranchInfos: res.infos ?? []
      })
    }
  }

  async function addRemote(name: string, url: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitAddRemote', name, url), 'write', loadRemotes)
  }

  async function removeRemote(name: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitRemoveRemote', name), 'write', loadRemotes)
  }

  // ---------- 存储（Stash） ----------

  async function loadStashes(): Promise<void> {
    if (!state.cwd) return
    const target = captureGitTarget()
    const res = await loadResult(target, () => gitListStashes(state.cwd))
    if (!res) return
    if (res.success && JSON.stringify(state.stashes) !== JSON.stringify(res.stashes ?? []))
      setState({ stashes: res.stashes ?? [] })
  }

  /** stash 写操作：成功后同时刷新变更列表与 stash 列表 */
  async function stashMutate(
    run: (client: ScopedGitClient) => Promise<GitResult>
  ): Promise<GitResult> {
    return mutate(run, 'stash')
  }

  function stashPush(message?: string, includeUntracked = false): Promise<GitResult> {
    return stashMutate(captureGitCommand('gitStashPush', message, includeUntracked))
  }
  function stashPushStaged(message?: string): Promise<GitResult> {
    return stashMutate(captureGitCommand('gitStashPushStaged', message))
  }
  function stashPop(index?: number): Promise<GitResult> {
    return stashMutate(captureGitCommand('gitStashPop', index))
  }
  function stashApply(index?: number): Promise<GitResult> {
    return stashMutate(captureGitCommand('gitStashApply', index))
  }
  function stashDrop(index: number): Promise<GitResult> {
    return stashMutate(captureGitCommand('gitStashDrop', index))
  }
  function stashDropBatch(indexes: number[]): Promise<GitResult> {
    return stashMutate(captureGitCommand('gitStashDropBatch', indexes))
  }
  function stashClear(): Promise<GitResult> {
    return stashMutate(captureGitCommand('gitStashClear'))
  }

  // ---------- 标记（Tag） ----------

  async function loadTags(): Promise<void> {
    if (!state.cwd) return
    const target = captureGitTarget()
    const res = await loadResult(target, () => gitListTags(state.cwd))
    if (!res) return
    if (res.success) setState({ tags: res.tags ?? [] })
  }

  async function createTag(name: string, message?: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitCreateTag', name, message), 'write', loadTags)
  }

  async function deleteTag(name: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitDeleteTag', name), 'write', loadTags)
  }

  // ---------- 提交历史 ----------

  function ensureLog(limit = 50): Promise<void> {
    limit = Math.max(1, Math.floor(limit) || 50)
    if (state.logError || state.logLoaded && (state.logExhausted || state.commits.length >= limit)
      && Date.now() - logLoadedAt < LOG_CACHE_TTL_MS)
      return Promise.resolve()
    return loadLog(limit)
  }

  function loadLog(limit = 50, append = false): Promise<void> {
    if (!state.cwd) return Promise.resolve()
    limit = Math.max(1, Math.floor(limit) || 50)
    if (append) limit = Math.min(500, limit)
    const target = captureGitTarget()
    const search = state.historySearch.trim()
    const author = state.historyAuthor.trim()
    const ref = state.historyRef.trim()
    const offset = append ? state.commits.length : 0
    const key = JSON.stringify([target, search, author, ref, offset, limit, append])
    if (logFlight?.key === key) return logFlight.promise
    if (append && (state.logExhausted || state.logLoading || state.logLoadingMore)) return Promise.resolve()
    const revision = ++logRevision
    const filterCurrent = (): boolean =>
      revision === logRevision &&
      sameGitTarget(target) &&
      search === state.historySearch.trim() &&
      author === state.historyAuthor.trim() &&
      ref === state.historyRef.trim()
    const query: GitLogQuery | undefined =
      search || author || ref
        ? {
            ...(search ? { search } : {}),
            ...(author ? { author } : {}),
            ...(ref ? { refs: [ref] } : {})
          }
        : undefined
    setState({ logError: '', logLoading: !append, logLoadingMore: append })
    const flight = { key, promise: Promise.resolve() }
    logFlight = flight
    flight.promise = (async () => {
      try {
        const page: GitLogEntry[] = []
        let exhausted = false
        // The transport caps each page at 500; revalidation must preserve all
        // rows already loaded, without publishing a partial refreshed history.
        while (page.length < limit) {
          const count = Math.min(500, limit - page.length)
          const res = await gitLog(target.cwd, count, offset + page.length, query)
          if (!filterCurrent()) return
          if (!res.success) throw new Error(res.error || '读取提交历史失败')
          const entries = res.commits ?? []
          page.push(...entries)
          if (entries.length < count) { exhausted = true; break }
        }
        const commits = append ? [...new Map([...state.commits, ...page].map(commit => [commit.hash, commit])).values()] : page
        if (!append) logLoadedAt = Date.now()
        setState({
          commits,
          logLoaded: true,
          logError: '',
          logExhausted: exhausted,
          legacyCommits: commits.map(entry => ({
            hash: entry.hash, shortHash: entry.shortHash, subject: entry.subject,
            author: entry.author, date: entry.date,
            refs: (entry.refs ?? []).map(r => r.name).join(', ')
          }))
        })
        if (!append && !query) void loadIncoming()
      } catch (error) {
        if (filterCurrent()) setState({ logError: gitFailure(error).error || '读取提交历史失败' })
      } finally {
        if (logFlight === flight) {
          logFlight = null
          if (filterCurrent()) setState({ logLoading: false, logLoadingMore: false })
        }
      }
    })()
    return flight.promise
  }

  /** Explicit refresh invalidates even an in-flight read from before a write. */
  async function reloadLog(limit = 50): Promise<void> {
    logRevision++
    logFlight = null
    if (state.historySearch || state.historyAuthor || state.historyRef) clearIncoming()
    await loadLog(limit)
  }

  /** 设置历史过滤条件并重新加载（替代 wuzu 的 watch 清空 incoming） */
  async function setHistoryFilter(
    patch: { search?: string; author?: string; ref?: string },
    options: { reload?: boolean } = {}
  ): Promise<void> {
    logRevision++
    logFlight = null
    logLoadedAt = 0
    setState({
      commits: [], legacyCommits: [], logLoaded: false, logLoading: false,
      logLoadingMore: false, logError: '', logExhausted: false,
      historySearch: patch.search ?? state.historySearch,
      historyAuthor: patch.author ?? state.historyAuthor,
      historyRef: patch.ref ?? state.historyRef
    })
    clearIncoming()
    if (options.reload !== false) await reloadLog()
  }

  // ---------- 远端领先提交（incoming） ----------

  /**
   * 查询远端领先提交（HEAD..@{u}）。fetch 成功后与历史加载后调用，
   * behind 为 0 / 无上游 / 有过滤条件时清空。非仓库或能力不可用时静默清空。
   */
  async function loadIncoming({ force = false } = {}): Promise<void> {
    if (!state.cwd || !state.isRepo || !state.upstream || state.historySearch || state.historyAuthor || state.historyRef) {
      clearIncoming()
      return
    }
    const key = `${state.upstream}|${state.commits[0]?.hash ?? ''}`
    if (!force && key === incomingKey && Date.now() - incomingLoadedAt < 10000) return
    const target = captureGitTarget()
    const revision = ++incomingRevision
    const current = (): boolean => sameGitTarget(target) && revision === incomingRevision
    setState({ incomingLoading: true })
    try {
      const res = await gitIncoming(state.cwd, 50)
      if (!current()) return
      incomingKey = key
      incomingLoadedAt = Date.now()
      setState({ incomingCommits: res.success ? (res.commits ?? []) : [] })
    } catch {
      if (current()) setState({ incomingCommits: [] })
    } finally {
      if (current()) setState({ incomingLoading: false })
    }
  }

  /** 清空远端领先提交（过滤条件变化 / 历史重载时调用） */
  function clearIncoming(): void {
    incomingRevision++
    incomingKey = ''
    incomingLoadedAt = 0
    setState({ incomingCommits: [], incomingLoading: false })
  }

  // ---------- 时间线（Timeline，按文件） ----------

  /**
   * 加载某个文件的提交历史（时间线数据源）。
   * append 为真时从已加载末条提交继续向上追溯。并发只保留最后一次请求：
   * 用户快速切文件时，先发的那次回来若继续写回会覆盖成上一个文件的历史。
   */
  async function loadTimeline(path: string, append = false): Promise<void> {
    const target = captureGitTarget()
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
    const cursor = append
      ? state.timelineEntries[state.timelineEntries.length - 1]?.hash
      : undefined
    try {
      const res = await loadResult(target, () => gitFileHistory(state.cwd, rel, TIMELINE_PAGE_SIZE, cursor),
        () => sameGitTarget(target) && state.timelinePath === rel)
      if (!res) {
        if (sameGitTarget(target) && state.timelinePath === rel) setState({ timelineError: state.errorMessage })
        return
      }
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
      if (sameGitTarget(target) && state.timelinePath === rel) setState({ timelineLoading: false })
    }
  }

  /** 清空时间线（切工作目录 / 目录不是仓库时调用） */
  function clearTimeline(): void {
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
  async function loadBlame(path: string): Promise<void> {
    const target = captureGitTarget()
    const rel = (path || '').replace(/\\/g, '/')
    if (!state.cwd || !rel) return
    if (blameCache.has(rel)) return
    const running = blameInflight.get(rel)
    if (running) return running
    const job = (async () => {
      try {
        const res = await gitBlame(state.cwd, rel)
        if (!sameGitTarget(target)) return
        blameCache.set(rel, res.success ? (res.lines ?? []) : [])
      } catch {
        if (sameGitTarget(target)) blameCache.set(rel, [])
      } finally {
        if (sameGitTarget(target)) blameInflight.delete(rel)
      }
    })()
    blameInflight.set(rel, job)
    return job
  }

  /** 取某文件某一行的 blame 归属（未加载 / 无归属时返回 null） */
  function blameLineOf(path: string, lineNumber: number): GitBlameLine | null {
    const rel = (path || '').replace(/\\/g, '/')
    const lines = blameCache.get(rel)
    if (!lines || lineNumber < 1 || lineNumber > lines.length) return null
    return lines[lineNumber - 1] ?? null
  }

  /** 清空 blame 缓存（HEAD 变化 / 切工作目录时调用） */
  function clearBlame(): void {
    blameCache.clear()
  }

  /** 某文件的 blame 是否已加载过（含「查不到」的空结果，避免反复重试） */
  function blameReady(path: string): boolean {
    return blameCache.has((path || '').replace(/\\/g, '/'))
  }

  /** 读取单条提交完整信息（行内 blame 的 hover 卡片数据源） */
  async function loadCommitShow(targetCwd: string, hash: string): Promise<GitCommitInfo | null> {
    if (!targetCwd || !hash) return null
    try {
      const res = await gitCommitShow(targetCwd, hash)
      return res.success ? (res.commit ?? null) : null
    } catch {
      return null
    }
  }

  /** 加载当前 Git 用户身份 */
  async function loadCurrentUser(): Promise<void> {
    if (!state.cwd) return
    const target = captureGitTarget()
    const res = await loadResult(target, () => gitGetUserName(state.cwd))
    if (!res) return
    if (res.success && res.name) setState({ currentUser: res.name })
  }

  /** 加载提交历史作者列表（去重） */
  async function loadHistoryAuthors(): Promise<void> {
    if (!state.cwd) return
    const target = captureGitTarget()
    const res = await loadResult(target, () => gitListAuthors(state.cwd))
    if (!res) return
    if (res.success) setState({ historyAuthors: res.authors ?? [] })
  }

  // ---------- 分支 ----------

  /** 加载本地分支列表（含各分支最新提交元信息） */
  async function loadBranches(): Promise<void> {
    if (!state.cwd) return
    const target = captureGitTarget()
    const res = await loadResult(target, () => gitListBranches(state.cwd))
    if (!res) return
    if (res.success) {
      setState({
        branches: res.branches ?? [],
        branchInfos: res.infos ?? [],
        ...(res.current ? { branch: res.current } : {})
      })
    }
  }

  /** 切换分支（有未提交改动时 git 会拒绝，错误透传） */
  async function checkout(name: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitCheckout', name), 'checkout', async () => {
      // 分支变了，原来选中的文件 diff 与 hunk 基准全部作废
      setState({ selectedPath: '', currentDiff: null, hunksMap: {} })
      await loadBranches()
    })
  }

  /** 新建分支并切换；startPoint 缺省基于当前 HEAD */
  async function createBranch(name: string, startPoint?: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitCreateBranch', name, startPoint), 'checkout', loadBranches)
  }

  async function deleteBranch(name: string, force = false): Promise<GitResult> {
    return mutate(captureGitCommand('gitDeleteBranch', name, force), 'write', loadBranches)
  }

  async function renameBranch(oldName: string, newName: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitRenameBranch', oldName, newName), 'write', loadBranches)
  }

  function publishBranch(): Promise<GitResult> {
    return mutate(captureGitCommand('gitPublishBranch'), 'push')
  }
  function merge(ref: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitMerge', ref), 'merge')
  }
  function mergeAbort(): Promise<GitResult> {
    return mutate(captureGitCommand('gitMergeAbort'))
  }
  function rebase(ref: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitRebase', ref), 'rebase')
  }
  function rebaseAbort(): Promise<GitResult> {
    return mutate(captureGitCommand('gitRebaseAbort'))
  }
  function cherryPick(hash: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitCherryPick', hash), 'cherry-pick')
  }
  function cherryPickAbort(): Promise<GitResult> {
    return mutate(captureGitCommand('gitCherryPickAbort'))
  }
  function revertCommit(hash: string): Promise<GitResult> {
    return mutate(captureGitCommand('gitRevertCommit', hash), 'revert')
  }

  // ---------- diff 预览 / hunks ----------

  /** 编辑区自行管理异步比较数据，侧栏只跟随用户选中的文件。 */
  function selectGitFile(path: string): void {
    setState({ selectedPath: path })
  }

  /** 加载指定文件的差异 */
  async function loadDiff(
    path: string,
    staged = false,
    base?: 'index' | 'head'
  ): Promise<GitFileDiff | null> {
    if (!state.cwd) {
      setState({ errorMessage: 'Git 能力不可用' })
      return null
    }
    setState({ selectedPath: path })
    const target = captureGitTarget()
    try {
      const res = await gitDiff(state.cwd, path, staged, base)
      if (!sameGitTarget(target) || state.selectedPath !== path) return null
      if (!res.success || !res.diff) {
        setState({ errorMessage: res.error ?? '获取差异失败', currentDiff: null })
        return null
      }
      setState({ currentDiff: res.diff })
      return res.diff
    } catch (error) {
      if (sameGitTarget(target) && state.selectedPath === path) {
        setState({
          errorMessage: error instanceof Error ? error.message : '获取差异失败',
          currentDiff: null
        })
      }
      return null
    }
  }

  /** 按文件路径读取已缓存的 hunk 列表，供编辑器 gutter 标记使用 */
  function hunksOf(path: string): GitFileDiff['hunks'] {
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
  async function loadHunksFor(path: string): Promise<void> {
    const target = captureGitTarget()
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
        if (!sameGitTarget(target)) return
        if (res.success && res.diff && res.diff.hunks.length > 0) {
          setState({ hunksMap: { ...state.hunksMap, [path]: res.diff.hunks } })
        } else {
          const next = { ...state.hunksMap }
          delete next[path]
          setState({ hunksMap: next })
        }
        hunksFingerprint.set(path, fp)
      } catch {
        if (!sameGitTarget(target)) return
        const next = { ...state.hunksMap }
        delete next[path]
        setState({ hunksMap: next })
        hunksFingerprint.set(path, fp)
      } finally {
        if (sameGitTarget(target)) hunkInflight.delete(path)
      }
    })()
    hunkInflight.set(path, job)
    return job
  }

  /**
   * 编辑器内容变化时实时计算 hunk 标记（缓冲区 vs HEAD，无需保存）。
   * aether 暂无编辑器 gutter 渲染层，接口保留供后续接入。
   */
  async function applyLiveHunks(path: string, content: string): Promise<void> {
    const target = captureGitTarget()
    if (!state.cwd || !path) return
    if (!(path in headCache)) {
      const res = await loadResult(target, () => gitHeadFile(state.cwd, path))
      if (!res?.success) return
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
  const refresh = refreshGit

  /**
   * 订阅完整 git 状态（新版 Git 面板用；字段即 GitStoreState 全量）
   */
  function useGitStore(): GitStoreState {
    return useSyncExternalStore(onGitChanged, getGitState, getGitState)
  }

  /**
   * 订阅 git 状态（旧只读面板兼容层：状态栏 / 资源管理器 / 旧 GitView）。
   * 返回的 commits 是 legacyCommits（refs 为拼接串），error 是 errorMessage 的别名。
   */
  function useGit(): Omit<GitStoreState, 'commits'> & {
    commits: GitStoreState['legacyCommits']
    error: string
    refresh: (root: string | null) => Promise<void>
  } {
    const snapshot = useSyncExternalStore(onGitChanged, getGitState, getGitState)
    const { commits, ...rest } = snapshot
    void commits // 显式丢弃新格式 commits，对外只暴露 legacyCommits
    return {
      ...rest,
      commits: snapshot.legacyCommits,
      error: snapshot.errorMessage,
      refresh: refreshGit
    }
  }

  // ---------- 供 git-remote-actions / git-merge-strategy 消费的 store 切面 ----------

  /** 远程操作编排需要的最小切面（git-remote-actions 的 GitRemoteStore） */
  const gitRemoteStore = {
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
  const mergeStrategyStore = {
    divergence,
    pullMerge,
    pullRebaseWithChoice
  }

  if (options.initialCwd) resetSelection(options.initialCwd)
  return {
    getGitState,
    getCommitDraftRevision,
    setCommitMessage,
    onGitChanged,
    stagedFilesOf,
    unstagedFilesOf,
    conflictFilesOf,
    changeCountOf,
    totalAdditionsOf,
    totalDeletionsOf,
    hasChangesToCommitOf,
    canCommitStagedOf,
    canCommitOf,
    busyOperationOf,
    sortedBranchesOf,
    refreshGit,
    forceRefreshGit,
    scheduleFsRefresh,
    startGitAutoFetch,
    autoFetchIfStale,
    autoFetchRemoteForStore,
    disposeGitStore,
    gitInitRepo,
    stage,
    unstage,
    discardFile,
    discardWorktree,
    discardWorktreeFiles,
    stageFiles,
    unstageFiles,
    discardFiles,
    discardHunk,
    checkIgnored,
    commit,
    commitStaged,
    commitAll,
    commitAmend,
    undoCommit,
    commitEmpty,
    fetchRemote,
    pull,
    push,
    divergence,
    pullMerge,
    pullRebaseWithChoice,
    addSshKey,
    sync,
    pullRebase,
    pushForce,
    pushTags,
    pushTag,
    pullFrom,
    pushTo,
    pushToBranch,
    pushToMany,
    deleteRemoteBranch,
    deleteRemoteTag,
    loadRemotes,
    loadRemoteBranches,
    addRemote,
    removeRemote,
    loadStashes,
    stashPush,
    stashPushStaged,
    stashPop,
    stashApply,
    stashDrop,
    stashDropBatch,
    stashClear,
    loadTags,
    createTag,
    deleteTag,
    loadLog,
    ensureLog,
    reloadLog,
    setHistoryFilter,
    loadIncoming,
    clearIncoming,
    loadTimeline,
    clearTimeline,
    loadBlame,
    blameLineOf,
    clearBlame,
    blameReady,
    loadCommitShow,
    loadCurrentUser,
    loadHistoryAuthors,
    loadBranches,
    checkout,
    createBranch,
    deleteBranch,
    renameBranch,
    publishBranch,
    merge,
    mergeAbort,
    rebase,
    rebaseAbort,
    cherryPick,
    cherryPickAbort,
    revertCommit,
    selectGitFile,
    loadDiff,
    hunksOf,
    loadHunksFor,
    applyLiveHunks,
    refresh,
    useGitStore,
    useGit,
    gitRemoteStore,
    mergeStrategyStore,
    captureTarget,
    getClient,
    readClient: read,
    stopGitAutoFetch,
    beginSuggestion,
    setCommitProposal,
    appendGitignore,
    cloneRepository
  }
}

export type GitStore = ReturnType<typeof createGitStore>
