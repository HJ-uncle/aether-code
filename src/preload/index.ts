import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/ipc'
import type {
  AppSettings,
  CopyIntoWorkspaceInput,
  CopyIntoWorkspaceResult,
  EngineLogEntry,
  EngineRequestInput,
  RemoteAttachmentInput,
  RemoteAttachmentResult,
  EngineRequestResult,
  EngineSnapshot,
  FsEntry,
  FsFileContent,
  FsStat,
  FilesExclude,
  LspExitInfo,
  LspMessage,
  LspStartInput,
  LspStartResult,
  ReplaceOutcome,
  ReplacePreviewOutcome,
  SearchOptions,
  SearchOutcome,
  StreamEvent,
  StreamStartInput,
  TerminalCreateInput,
  TerminalDataEvent,
  TerminalExitInfo,
  RemoteTokenStatus
} from '../shared/ipc'
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
} from '../shared/git-types'

/**
 * 暴露给渲染进程的窄接口。
 *
 * 刻意不暴露通用的 ipcRenderer.send/invoke：渲染层只能调用下面这些具名方法，
 * 通道被写死在 preload 里，页面代码无法自行拼通道名。
 */
const api = {
  engine: {
    getSnapshot: (): Promise<EngineSnapshot> => ipcRenderer.invoke(IPC.invoke.engineGetSnapshot),
    start: (): Promise<EngineSnapshot> => ipcRenderer.invoke(IPC.invoke.engineStart),
    stop: (): Promise<EngineSnapshot> => ipcRenderer.invoke(IPC.invoke.engineStop),
    restart: (): Promise<EngineSnapshot> => ipcRenderer.invoke(IPC.invoke.engineRestart),

    request: <T = unknown>(input: EngineRequestInput): Promise<EngineRequestResult<T>> =>
      ipcRenderer.invoke(IPC.invoke.engineRequest, input),
    uploadAttachment: (input: RemoteAttachmentInput): Promise<RemoteAttachmentResult> =>
      ipcRenderer.invoke(IPC.invoke.engineUploadAttachment, input),

    stream: {
      start: (input: StreamStartInput): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke(IPC.invoke.engineStreamStart, input),
      abort: (streamId: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke(IPC.invoke.engineStreamAbort, streamId)
    },

    /** 订阅状态变更，返回取消订阅函数 */
    onSnapshot: (listener: (snapshot: EngineSnapshot) => void): (() => void) => {
      const handler = (_e: unknown, snapshot: EngineSnapshot): void => listener(snapshot)
      ipcRenderer.on(IPC.event.engineSnapshot, handler)
      return () => ipcRenderer.removeListener(IPC.event.engineSnapshot, handler)
    },

    onLog: (listener: (entry: EngineLogEntry) => void): (() => void) => {
      const handler = (_e: unknown, entry: EngineLogEntry): void => listener(entry)
      ipcRenderer.on(IPC.event.engineLog, handler)
      return () => ipcRenderer.removeListener(IPC.event.engineLog, handler)
    },

    onStreamEvent: (listener: (event: StreamEvent) => void): (() => void) => {
      const handler = (_e: unknown, event: StreamEvent): void => listener(event)
      ipcRenderer.on(IPC.event.streamEvent, handler)
      return () => ipcRenderer.removeListener(IPC.event.streamEvent, handler)
    }
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.invoke.settingsGet),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.invoke.settingsUpdate, patch),
    saveEngine: (patch: Partial<AppSettings>, token: string): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.invoke.settingsSaveEngine, patch, token),
    remoteTokenStatus: (): Promise<RemoteTokenStatus> =>
      ipcRenderer.invoke(IPC.invoke.settingsRemoteTokenStatus),
    setRemoteToken: (token: string): Promise<RemoteTokenStatus> =>
      ipcRenderer.invoke(IPC.invoke.settingsSetRemoteToken, token),
    clearRemoteToken: (): Promise<RemoteTokenStatus> =>
      ipcRenderer.invoke(IPC.invoke.settingsClearRemoteToken)
  },

  /**
   * 文件系统（IDE 本地实现）。
   * 主进程侧有「工作区根目录白名单」校验，未授权的路径会被拒绝。
   */
  fs: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.invoke.fsPickFolder),
    allowRoot: (root: string): Promise<void> => ipcRenderer.invoke(IPC.invoke.fsAllowRoot, root),
    readDir: (dir: string): Promise<FsEntry[]> => ipcRenderer.invoke(IPC.invoke.fsReadDir, dir),
    readFile: (path: string): Promise<FsFileContent> =>
      ipcRenderer.invoke(IPC.invoke.fsReadFile, path),
    writeFile: (path: string, content: string): Promise<FsStat> =>
      ipcRenderer.invoke(IPC.invoke.fsWriteFile, path, content),
    createFile: (path: string): Promise<void> => ipcRenderer.invoke(IPC.invoke.fsCreateFile, path),
    createFolder: (path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.invoke.fsCreateFolder, path),
    rename: (src: string, dest: string): Promise<void> =>
      ipcRenderer.invoke(IPC.invoke.fsRename, src, dest),
    copy: (src: string, dest: string): Promise<void> =>
      ipcRenderer.invoke(IPC.invoke.fsCopy, src, dest),
    trash: (path: string): Promise<void> => ipcRenderer.invoke(IPC.invoke.fsTrash, path),
    stat: (path: string): Promise<FsStat> => ipcRenderer.invoke(IPC.invoke.fsStat, path),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke(IPC.invoke.fsReveal, path),
    watchDocuments: (paths: string[]): Promise<void> => ipcRenderer.invoke(IPC.invoke.fsWatchDocuments, paths),
    onDocumentsChanged: (listener: (paths: string[]) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, paths: string[]): void => listener(paths)
      ipcRenderer.on(IPC.event.fsDocumentsChanged, handler)
      return () => ipcRenderer.removeListener(IPC.event.fsDocumentsChanged, handler)
    },
    listAll: (root: string): Promise<string[]> => ipcRenderer.invoke(IPC.invoke.fsListAll, root),
    copyIntoWorkspace: (input: CopyIntoWorkspaceInput): Promise<CopyIntoWorkspaceResult> =>
      ipcRenderer.invoke(IPC.invoke.fsCopyIntoWorkspace, input)
  },

  /**
   * 版本控制（Git 面板）。主进程直接调用 git，cwd 受工作区白名单限制。
   * 全部方法返回 { success, error?, errorCode? } 信封（见 shared/git-types.ts），
   * 失败不抛异常 —— 渲染层按 errorCode 给用户出路。
   */
  git: {
    init: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitInit, cwd),
    status: (cwd: string): Promise<GitStatusResult> => ipcRenderer.invoke(IPC.invoke.gitStatus, cwd),
    diff: (cwd: string, path: string, staged: boolean, base?: 'index' | 'head'): Promise<GitDiffResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDiff, cwd, path, staged, base),
    branchInfo: (cwd: string): Promise<GitBranchInfoResult> =>
      ipcRenderer.invoke(IPC.invoke.gitBranchInfo, cwd),
    stage: (cwd: string, path: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStage, cwd, path),
    unstage: (cwd: string, path: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitUnstage, cwd, path),
    discardFile: (cwd: string, path: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDiscardFile, cwd, path),
    discardWorktree: (cwd: string, path: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDiscardWorktree, cwd, path),
    discardWorktreeFiles: (cwd: string, paths: string[]): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDiscardWorktreeFiles, cwd, paths),
    stageFiles: (cwd: string, paths: string[]): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStageFiles, cwd, paths),
    checkIgnored: (cwd: string, paths: string[]): Promise<GitIgnoreCheckResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCheckIgnored, cwd, paths),
    unstageFiles: (cwd: string, paths: string[]): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitUnstageFiles, cwd, paths),
    discardFiles: (cwd: string, paths: string[]): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDiscardFiles, cwd, paths),
    headFile: (cwd: string, path: string): Promise<GitHeadFileResult> =>
      ipcRenderer.invoke(IPC.invoke.gitHeadFile, cwd, path),
    fetch: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitFetch, cwd),
    pull: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitPull, cwd),
    push: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitPush, cwd),
    divergence: (cwd: string): Promise<GitDivergenceResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDivergence, cwd),
    pullMerge: (cwd: string, remember: boolean): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitPullMerge, cwd, remember),
    pullRebaseWithChoice: (cwd: string, remember: boolean): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitPullRebaseChoice, cwd, remember),
    addSshKey: (passphrase: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitAddSshKey, passphrase),
    listBranches: (cwd: string): Promise<GitBranchListResult> =>
      ipcRenderer.invoke(IPC.invoke.gitBranches, cwd),
    checkout: (cwd: string, branch: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCheckout, cwd, branch),
    createBranch: (cwd: string, name: string, startPoint?: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCreateBranch, cwd, name, startPoint),
    discardHunk: (cwd: string, path: string, hunkId: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDiscardHunk, cwd, path, hunkId),
    commit: (cwd: string, message: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCommit, cwd, message),
    stageAllAndCommit: (cwd: string, message: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStageAllAndCommit, cwd, message),
    getHeadFile: (cwd: string, path: string): Promise<GitHeadFileResult> =>
      ipcRenderer.invoke(IPC.invoke.gitHeadFileContent, cwd, path),
    appendGitignore: (cwd: string, path: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitAppendGitignore, cwd, path),
    suggestCommitMessage: (cwd: string): Promise<GitSuggestMessageResult> =>
      ipcRenderer.invoke(IPC.invoke.gitSuggestMessage, cwd),
    commitAmend: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitCommitAmend, cwd),
    commitAmendWithMessage: (cwd: string, message: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCommitAmendMessage, cwd, message),
    undoCommit: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitUndoCommit, cwd),
    commitEmpty: (cwd: string, message: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCommitEmpty, cwd, message),
    sync: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitSync, cwd),
    pullRebase: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitPullRebase, cwd),
    pushForce: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitPushForce, cwd),
    pushTags: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitPushTags, cwd),
    pushTag: (cwd: string, name: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitPushTag, cwd, name),
    pullFrom: (cwd: string, remote: string, branch: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitPullFrom, cwd, remote, branch),
    pushTo: (cwd: string, remote: string, branch?: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitPushTo, cwd, remote, branch),
    listRemoteBranches: (cwd: string): Promise<GitRemoteBranchListResult> =>
      ipcRenderer.invoke(IPC.invoke.gitRemoteBranches, cwd),
    deleteRemoteBranch: (cwd: string, remote: string, branch: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDeleteRemoteBranch, cwd, remote, branch),
    deleteRemoteTag: (cwd: string, name: string, remote?: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDeleteRemoteTag, cwd, name, remote),
    deleteBranch: (cwd: string, name: string, force?: boolean): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDeleteBranch, cwd, name, force),
    renameBranch: (cwd: string, oldName: string, newName: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitRenameBranch, cwd, oldName, newName),
    publishBranch: (cwd: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitPublishBranch, cwd),
    merge: (cwd: string, ref: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitMerge, cwd, ref),
    mergeAbort: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitMergeAbort, cwd),
    rebase: (cwd: string, ref: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitRebase, cwd, ref),
    rebaseAbort: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitRebaseAbort, cwd),
    cherryPick: (cwd: string, hash: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCherryPick, cwd, hash),
    cherryPickAbort: (cwd: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCherryPickAbort, cwd),
    revertCommit: (cwd: string, hash: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitRevertCommit, cwd, hash),
    listRemotes: (cwd: string): Promise<GitRemoteListResult> =>
      ipcRenderer.invoke(IPC.invoke.gitRemotes, cwd),
    addRemote: (cwd: string, name: string, url: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitAddRemote, cwd, name, url),
    removeRemote: (cwd: string, name: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitRemoveRemote, cwd, name),
    clone: (options: GitCloneOptions): Promise<GitCloneResult> =>
      ipcRenderer.invoke(IPC.invoke.gitClone, options),
    cancelClone: (cloneId: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCloneCancel, cloneId),
    /** 订阅克隆进度，返回取消订阅函数（与 terminal.onData 同构） */
    onCloneProgress: (listener: (payload: GitCloneProgressPayload) => void): (() => void) => {
      const handler = (_e: unknown, payload: GitCloneProgressPayload): void => listener(payload)
      ipcRenderer.on(IPC.event.gitCloneProgress, handler)
      return () => ipcRenderer.removeListener(IPC.event.gitCloneProgress, handler)
    },
    listStashes: (cwd: string): Promise<GitStashListResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStashList, cwd),
    stashPush: (cwd: string, message?: string, includeUntracked?: boolean): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStashPush, cwd, message, includeUntracked),
    stashPushStaged: (cwd: string, message?: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStashPushStaged, cwd, message),
    stashPop: (cwd: string, index?: number): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStashPop, cwd, index),
    stashApply: (cwd: string, index?: number): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStashApply, cwd, index),
    stashDrop: (cwd: string, index: number): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStashDrop, cwd, index),
    stashDropBatch: (cwd: string, indexes: number[]): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStashDropBatch, cwd, indexes),
    stashClear: (cwd: string): Promise<GitResult> => ipcRenderer.invoke(IPC.invoke.gitStashClear, cwd),
    stashShow: (cwd: string, index: number): Promise<GitHeadFileResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStashShow, cwd, index),
    stashShowFiles: (cwd: string, index: number): Promise<GitHeadFileResult> =>
      ipcRenderer.invoke(IPC.invoke.gitStashShowFiles, cwd, index),
    listTags: (cwd: string): Promise<GitTagListResult> => ipcRenderer.invoke(IPC.invoke.gitTags, cwd),
    createTag: (cwd: string, name: string, message?: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCreateTag, cwd, name, message),
    deleteTag: (cwd: string, name: string): Promise<GitResult> =>
      ipcRenderer.invoke(IPC.invoke.gitDeleteTag, cwd, name),
    log: (cwd: string, limit?: number, skip?: number, query?: GitLogQuery): Promise<GitLogResult> =>
      ipcRenderer.invoke(IPC.invoke.gitLog, cwd, limit, skip, query),
    incoming: (cwd: string, limit?: number): Promise<GitLogResult> =>
      ipcRenderer.invoke(IPC.invoke.gitIncoming, cwd, limit),
    commitShow: (cwd: string, hash: string): Promise<GitCommitInfoResult> =>
      ipcRenderer.invoke(IPC.invoke.gitCommitShow, cwd, hash),
    showCommitFile: (cwd: string, hash: string, path: string): Promise<GitHeadFileResult> =>
      ipcRenderer.invoke(IPC.invoke.gitShowCommitFile, cwd, hash, path),
    fileHistory: (cwd: string, path: string, limit?: number, cursor?: string): Promise<GitFileHistoryResult> =>
      ipcRenderer.invoke(IPC.invoke.gitFileHistory, cwd, path, limit, cursor),
    blame: (cwd: string, path: string): Promise<GitBlameResult> =>
      ipcRenderer.invoke(IPC.invoke.gitBlame, cwd, path),
    getUserName: (cwd: string): Promise<GitUserResult> => ipcRenderer.invoke(IPC.invoke.gitUserName, cwd),
    listAuthors: (cwd: string): Promise<GitUserListResult> =>
      ipcRenderer.invoke(IPC.invoke.gitListAuthors, cwd)
  },

  /** 全局搜索：git 仓库用 git grep，其余退回文件遍历 */
  search: {
    query: (
      root: string,
      query: string,
      options: SearchOptions,
      excludes: FilesExclude
    ): Promise<SearchOutcome> =>
      ipcRenderer.invoke(IPC.invoke.searchQuery, root, query, options, excludes),
    replace: (
      root: string,
      query: string,
      options: SearchOptions,
      replaceText: string,
      excludes: FilesExclude
    ): Promise<ReplaceOutcome> =>
      ipcRenderer.invoke(IPC.invoke.searchReplace, root, query, options, replaceText, excludes),
    preview: (
      root: string,
      query: string,
      options: SearchOptions,
      replaceText: string,
      excludes: FilesExclude
    ): Promise<ReplacePreviewOutcome> =>
      ipcRenderer.invoke(
        IPC.invoke.searchReplacePreview,
        root,
        query,
        options,
        replaceText,
        excludes
      )
  },

  /**
   * 终端（node-pty，多实例）。create 返回会话 id，后续读写均按 id 路由。
   * onData/onExit 返回取消订阅函数，与 engine 的事件订阅同构。
   */
  terminal: {
    create: (input: TerminalCreateInput): Promise<{ id: string }> =>
      ipcRenderer.invoke(IPC.invoke.terminalCreate, input),
    write: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke(IPC.invoke.terminalWrite, id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(IPC.invoke.terminalResize, id, cols, rows),
    dispose: (id: string): Promise<void> => ipcRenderer.invoke(IPC.invoke.terminalDispose, id),
    onData: (listener: (event: TerminalDataEvent) => void): (() => void) => {
      const handler = (_e: unknown, event: TerminalDataEvent): void => listener(event)
      ipcRenderer.on(IPC.event.terminalData, handler)
      return () => ipcRenderer.removeListener(IPC.event.terminalData, handler)
    },
    onExit: (listener: (info: TerminalExitInfo) => void): (() => void) => {
      const handler = (_e: unknown, info: TerminalExitInfo): void => listener(info)
      ipcRenderer.on(IPC.event.terminalExit, handler)
      return () => ipcRenderer.removeListener(IPC.event.terminalExit, handler)
    }
  },

  /**
   * TS 语言服务（typescript-language-server，单实例）。
   * 渲染进程发 JSON-RPC 经 send 进 stdin，服务器消息经 onMessage 推回；
   * onExit 在服务器进程退出时触发（渲染端据此降级或重启）。
   */
  lsp: {
    start: (input: LspStartInput): Promise<LspStartResult> =>
      ipcRenderer.invoke(IPC.invoke.lspStart, input),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.invoke.lspStop),
    send: (message: LspMessage): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.invoke.lspSend, message),
    onMessage: (listener: (message: LspMessage) => void): (() => void) => {
      const handler = (_e: unknown, message: LspMessage): void => listener(message)
      ipcRenderer.on(IPC.event.lspMessage, handler)
      return () => ipcRenderer.removeListener(IPC.event.lspMessage, handler)
    },
    onExit: (listener: (info: LspExitInfo) => void): (() => void) => {
      const handler = (_e: unknown, info: LspExitInfo): void => listener(info)
      ipcRenderer.on(IPC.event.lspExit, handler)
      return () => ipcRenderer.removeListener(IPC.event.lspExit, handler)
    }
  },

  /** 窗口控制：无边框窗口下由自绘标题栏按钮驱动 */
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.invoke.windowMinimize),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke(IPC.invoke.windowToggleMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.invoke.windowClose),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.invoke.windowIsMaximized)
  }
}

export type AetherIdeApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('aether', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.aether = api
}
