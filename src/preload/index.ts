import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/ipc'
import type {
  AppSettings,
  CopyIntoWorkspaceInput,
  CopyIntoWorkspaceResult,
  EngineLogEntry,
  EngineRequestInput,
  EngineRequestResult,
  EngineSnapshot,
  FsEntry,
  FsFileContent,
  FsStat,
  FilesExclude,
  GitCommit,
  GitStatus,
  ReplaceOutcome,
  ReplacePreviewOutcome,
  SearchOptions,
  SearchOutcome,
  StreamEvent,
  StreamStartInput,
  TerminalCreateInput,
  TerminalDataEvent,
  TerminalExitInfo
} from '../shared/ipc'

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
      ipcRenderer.invoke(IPC.invoke.settingsUpdate, patch)
  },

  /**
   * 文件系统（IDE 本地实现）。
   * 主进程侧有「工作区根目录白名单」校验，未授权的路径会被拒绝。
   */
  fs: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.invoke.fsPickFolder),
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
    listAll: (root: string): Promise<string[]> => ipcRenderer.invoke(IPC.invoke.fsListAll, root),
    copyIntoWorkspace: (input: CopyIntoWorkspaceInput): Promise<CopyIntoWorkspaceResult> =>
      ipcRenderer.invoke(IPC.invoke.fsCopyIntoWorkspace, input)
  },

  /**
   * 版本控制（只读）。主进程直接调用 git，cwd 受工作区白名单限制。
   * 非仓库不是错误：status 会返回 { isRepo: false }。
   */
  git: {
    status: (root: string): Promise<GitStatus> => ipcRenderer.invoke(IPC.invoke.gitStatus, root),
    log: (root: string, limit?: number): Promise<GitCommit[]> =>
      ipcRenderer.invoke(IPC.invoke.gitLog, root, limit)
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
