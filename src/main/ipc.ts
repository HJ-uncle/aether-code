/**
 * IPC 通道注册
 *
 * 通道刻意保持少而稳定：生命周期走具名通道，业务数据走一个通用 request 通道。
 * 这样后续接入 workspace / terminal / lsp 等路由时无需新增 IPC 协议。
 *
 * 流式对话例外：SSE 需要主进程持续推送，用 start/abort + 事件通道实现。
 */
import { app, dialog, ipcMain, webContents, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  CopyIntoWorkspaceInput,
  EngineRequestInput,
  EngineSnapshot,
  FilesExclude,
  LspMessage,
  LspStartInput,
  SearchOptions,
  StreamEvent,
  StreamStartInput,
  TerminalCreateInput
} from '../shared/ipc'
import { engineRequest, engineUpload } from './engine/client'
import { uploadRemoteAttachment } from './engine/upload-remote-attachment'
import { engineHost } from './engine/host'
import { onEngineLog } from './engine/logger'
import * as fileService from './fs/file-service'
import { watchDocuments } from './fs/document-watch'
import * as gitService from './git/git-service'
import * as lspServer from './lsp/server'
import {
  createTerminal,
  disposeTerminal,
  resizeTerminal,
  writeTerminal
} from './terminal/pty-service'
import { remoteTerminalService } from './terminal/remote-terminal'
import { replaceWorkspace, searchWorkspace, previewReplaceWorkspace } from './search/search-service'
import { getSettings, updateSettings } from './settings-store'
import type { AppSettings, RemoteTokenStatus } from '../shared/ipc'
import type { GitCloneOptions, GitLogQuery, GitResult } from '../shared/git-types'
import { addSshKeyToAgent } from './git/ssh-agent'
import { cancelClone, cloneRepository } from './git/git-clone'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRuntime } from './engine/runtime'
import { clearRemoteInstanceToken, remoteInstanceTokenConfigured, setRemoteInstanceToken, withRemoteInstanceTokenChange } from './engine/remote-token'
import { importLocalRuntime } from './engine/import-local-runtime'
import { getActiveRuntimeId, listLocalRuntimes, removeLocalRuntime, setActiveRuntimeId } from './engine/local-runtime-store'
import type { EngineImportProgress, EngineRuntimeCatalog } from '../shared/engine-import'

/** 进行中的 SSE 请求：streamId → AbortController */
const activeStreams = new Map<string, AbortController>()
let runtimeImportBusy = false
let runtimeActivationBusy = false

function ensureNotActivatingRuntime(): void {
  if (runtimeActivationBusy) throw new Error('正在切换本地引擎，请稍后再试')
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send(channel, payload)
  }
}

export function registerIpcHandlers(): void {
  // ── 引擎状态广播 ──
  engineHost.on('snapshot', (snapshot: EngineSnapshot) => {
    broadcast(IPC.event.engineSnapshot, snapshot)
  })
  engineHost.on('stream', (event: StreamEvent) => {
    broadcast(IPC.event.streamEvent, event)
  })
  onEngineLog((entry) => {
    broadcast(IPC.event.engineLog, entry)
  })

  // ── 生命周期 ──
  ipcMain.handle(IPC.invoke.engineGetSnapshot, () => engineHost.getSnapshot())

  ipcMain.handle(IPC.invoke.engineStart, async () => {
    ensureNotActivatingRuntime()
    const settings = getSettings()
    return engineHost.start(settings.engineMode, settings.remoteBaseUrl, settings.remoteWorkspaceRoot)
  })

  ipcMain.handle(IPC.invoke.engineStop, () => {
    ensureNotActivatingRuntime()
    return engineHost.stop()
  })

  ipcMain.handle(IPC.invoke.engineRestart, async () => {
    ensureNotActivatingRuntime()
    const settings = getSettings()
    await engineHost.stop()
    return engineHost.start(settings.engineMode, settings.remoteBaseUrl, settings.remoteWorkspaceRoot)
  })

  ipcMain.handle(IPC.invoke.engineGetLocalRuntimes, (): EngineRuntimeCatalog => ({
    activeId: getActiveRuntimeId(app.getPath('userData')),
    runtimes: listLocalRuntimes(app.getPath('userData'))
  }))

  // Only the native picker can supply import paths; the renderer cannot invoke
  // archive extraction against arbitrary filesystem locations through this IPC.
  ipcMain.handle(IPC.invoke.engineImportLocalRuntime, async (event) => {
    if (runtimeImportBusy || runtimeActivationBusy) throw new Error('正在处理本地引擎，请稍后再试')
    if (getSettings().engineMode !== 'embedded') throw new Error('请先保存“本地内置”运行方式')
    runtimeImportBusy = true
    try {
      const options: Electron.OpenDialogOptions = {
        title: '导入本地引擎包',
        buttonLabel: '导入引擎',
        filters: [{ name: '引擎包', extensions: ['tgz'] }],
        properties: ['openFile']
      }
      const parent = BrowserWindow.fromWebContents(event.sender)
      const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (picked.canceled || !picked.filePaths[0]) return null
      const sendProgress = (progress: EngineImportProgress): void => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC.event.engineImportProgress, progress)
      }
      return await importLocalRuntime(picked.filePaths[0], sendProgress)
    } finally {
      runtimeImportBusy = false
    }
  })

  ipcMain.handle(IPC.invoke.engineActivateLocalRuntime, async (_event, id: unknown) => {
    if (runtimeImportBusy || runtimeActivationBusy) throw new Error('正在处理本地引擎，请稍后再试')
    if (id !== null && typeof id !== 'string') throw new Error('无效的本地引擎标识')
    const settings = getSettings()
    if (settings.engineMode !== 'embedded') throw new Error('请先保存“本地内置”运行方式')
    const userData = app.getPath('userData')
    const previousId = getActiveRuntimeId(userData)
    const previous = engineHost.getSnapshot()
    if (previous.phase === 'starting' || previous.phase === 'stopping' || previous.phase === 'installing') {
      throw new Error('引擎正在启动或停止，请等待完成后再切换')
    }
    const restoreRunning = previous.phase === 'ready'
    let pointerChanged = false
    let stopped = false
    runtimeActivationBusy = true
    try {
      if (id !== previousId) {
        setActiveRuntimeId(userData, id)
        pointerChanged = true
      }
      // Resolve before stopping the existing engine so missing assets cannot
      // interrupt a working session. Failed activation restores the pointer.
      if (!resolveRuntime()) throw new Error('未找到默认引擎；请先导入完整引擎包')
      abortAllStreams()
      stopped = true
      await engineHost.stop()
      const next = await engineHost.start('embedded')
      if (next.phase !== 'ready') throw new Error(next.error || '新引擎未能启动')
      return next
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const recoveryErrors: string[] = []
      let pointerRestored = !pointerChanged
      if (pointerChanged) {
        try {
          setActiveRuntimeId(userData, previousId)
          pointerRestored = true
        } catch (rollbackError) {
          recoveryErrors.push(`恢复原引擎选择失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
      if (stopped) {
        try {
          await engineHost.stop()
          if (restoreRunning && pointerRestored) {
            const restored = await engineHost.start(settings.engineMode, settings.remoteBaseUrl, settings.remoteWorkspaceRoot)
            if (restored.phase !== 'ready') recoveryErrors.push(`原引擎重新启动失败：${restored.error || '引擎未就绪'}`)
          }
        } catch (rollbackError) {
          recoveryErrors.push(`恢复原引擎运行状态失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
      if (recoveryErrors.length) throw new Error(`切换引擎失败：${message}；${recoveryErrors.join('；')}`)
      throw new Error(`切换引擎失败，${stopped ? '已恢复原引擎选择' : '当前引擎未被停止'}：${message}`)
    } finally {
      runtimeActivationBusy = false
    }
  })

  ipcMain.handle(IPC.invoke.engineDeleteLocalRuntime, (_event, id: unknown): void => {
    if (runtimeImportBusy || runtimeActivationBusy) throw new Error('正在处理本地引擎，请稍后再试')
    if (typeof id !== 'string') throw new Error('无效的本地引擎标识')
    const userData = app.getPath('userData')
    if (getActiveRuntimeId(userData) === id) throw new Error('当前使用的本地引擎不能删除，请先切换到默认引擎')
    removeLocalRuntime(userData, id)
  })

  // ── 业务请求 ──
  ipcMain.handle(IPC.invoke.engineRequest, (_event, input: EngineRequestInput) =>
    engineRequest(input)
  )
  ipcMain.handle(IPC.invoke.engineUpload, (_event, input) => engineUpload(input))
  ipcMain.handle(IPC.invoke.engineUploadAttachment, (_event, input) => uploadRemoteAttachment(input))

  // ── 流式请求 ──
  ipcMain.handle(IPC.invoke.engineStreamStart, async (_event, input: StreamStartInput) => {
    // 同一 streamId 重复启动时先中止旧的，避免两个 reader 抢同一个通道
    activeStreams.get(input.streamId)?.abort()

    const controller = new AbortController()
    activeStreams.set(input.streamId, controller)

    try {
      await engineHost.stream(input.streamId, input.path, input.body, controller.signal, input.method, input.query, input.expectedEngine)
    } finally {
      activeStreams.delete(input.streamId)
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.engineStreamAbort, (_event, streamId: string) => {
    const controller = activeStreams.get(streamId)
    if (!controller) return { ok: false }
    controller.abort()
    activeStreams.delete(streamId)
    return { ok: true }
  })

  // ── 窗口控制（自绘标题栏）──
  // 无边框窗口没有系统按钮，最小化/最大化/关闭必须由渲染层显式调用。
  // 统一从 sender 反查窗口，避免依赖「当前主窗口」这类全局状态。
  const windowOf = (event: IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle(IPC.invoke.windowMinimize, (event) => {
    windowOf(event)?.minimize()
  })
  ipcMain.handle(IPC.invoke.windowToggleMaximize, (event) => {
    const win = windowOf(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(IPC.invoke.windowClose, (event) => {
    windowOf(event)?.close()
  })
  ipcMain.handle(IPC.invoke.windowIsMaximized, (event) => windowOf(event)?.isMaximized() ?? false)

  // ── 设置 ──
  ipcMain.handle(IPC.invoke.settingsGet, () => getSettings())
  ipcMain.handle(IPC.invoke.settingsUpdate, (_event, patch: Partial<AppSettings>) => {
    const connectionKeys: (keyof AppSettings)[] = ['engineMode', 'preferredPort', 'remoteBaseUrl', 'remoteWorkspaceRoot', 'autoStartEngine']
    if (connectionKeys.some((key) => Object.prototype.hasOwnProperty.call(patch, key))) ensureNotActivatingRuntime()
    return updateSettings(patch)
  })
  const remoteTokenStatus = (): RemoteTokenStatus => {
    const stored = remoteInstanceTokenConfigured()
    const environment = Boolean(process.env.AETHER_IDE_REMOTE_INSTANCE_TOKEN?.trim())
    return {
      configured: stored || environment,
      source: stored ? 'stored' as const : environment ? 'environment' as const : 'none' as const
    }
  }
  ipcMain.handle(IPC.invoke.settingsRemoteTokenStatus, remoteTokenStatus)
  ipcMain.handle(IPC.invoke.settingsSetRemoteToken, (_event, token: string) => {
    ensureNotActivatingRuntime()
    if (typeof token !== 'string') throw new Error('远端令牌必须是字符串')
    setRemoteInstanceToken(token)
    return remoteTokenStatus()
  })
  ipcMain.handle(IPC.invoke.settingsClearRemoteToken, () => {
    ensureNotActivatingRuntime()
    clearRemoteInstanceToken()
    return remoteTokenStatus()
  })
  ipcMain.handle(IPC.invoke.settingsSaveEngine, (_event, patch: Partial<AppSettings>, token: string) => {
    ensureNotActivatingRuntime()
    if (typeof token !== 'string') throw new Error('远端令牌必须是字符串')
    // Never spread a credential-bearing object into ordinary persisted settings.
    const connection = {
      engineMode: patch.engineMode,
      preferredPort: patch.preferredPort,
      remoteBaseUrl: patch.remoteBaseUrl,
      remoteWorkspaceRoot: patch.remoteWorkspaceRoot ?? getSettings().remoteWorkspaceRoot,
      autoStartEngine: patch.autoStartEngine
    }
    if (!['embedded', 'remote'].includes(connection.engineMode ?? '') ||
      typeof connection.remoteBaseUrl !== 'string' || typeof connection.autoStartEngine !== 'boolean' ||
      !Number.isInteger(connection.preferredPort) || connection.preferredPort! < 1 || connection.preferredPort! > 65535) {
      throw new Error('引擎连接设置无效')
    }
    return withRemoteInstanceTokenChange(token, () => updateSettings(connection))
  })

  // ── 文件系统 ──
  // 这些 handler 直接抛错：文件操作失败原因（不存在/无权限/越界）需要原样
  // 传到界面，包一层 result 信封反而会丢掉调用栈与错误类型。
  ipcMain.handle(IPC.invoke.fsPickFolder, async () => {
    const folder = await fileService.pickFolder()
    // 记住选择，下次启动可直接恢复并保持授权
    if (folder) updateSettings({ lastFolder: folder })
    return folder
  })
  ipcMain.handle(IPC.invoke.fsAllowRoot, (_event, root: string) => fileService.allowRoot(root))
  ipcMain.handle(IPC.invoke.fsReadDir, (_event, dir: string) => fileService.readDirectory(dir))
  ipcMain.handle(IPC.invoke.fsReadFile, (_event, filePath: string) =>
    fileService.readFile(filePath)
  )
  ipcMain.handle(IPC.invoke.fsWriteFile, (_event, filePath: string, content: string) =>
    fileService.writeFile(filePath, content)
  )
  ipcMain.handle(IPC.invoke.fsCreateFile, (_event, filePath: string) =>
    fileService.createFile(filePath)
  )
  ipcMain.handle(IPC.invoke.fsCreateFolder, (_event, folderPath: string) =>
    fileService.createFolder(folderPath)
  )
  ipcMain.handle(IPC.invoke.fsRename, (_event, src: string, dest: string) =>
    fileService.renamePath(src, dest)
  )
  ipcMain.handle(IPC.invoke.fsCopy, (_event, src: string, dest: string) =>
    fileService.copyPath(src, dest)
  )
  ipcMain.handle(IPC.invoke.fsTrash, (_event, target: string) => fileService.trashPath(target))
  ipcMain.handle(IPC.invoke.fsStat, (_event, target: string) => fileService.statPath(target))
  ipcMain.handle(IPC.invoke.fsReveal, (_event, target: string) => fileService.revealPath(target))
  const documentWatchers = new Map<number, () => void>()
  const watcherOwners = new Set<number>()
  ipcMain.handle(IPC.invoke.fsWatchDocuments, (event, paths: string[]) => {
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) throw new Error('文件监听路径无效')
    const sender = event.sender
    const dispose = watchDocuments(paths, (changed) => {
      if (!sender.isDestroyed()) sender.send(IPC.event.fsDocumentsChanged, changed)
    })
    documentWatchers.get(sender.id)?.()
    documentWatchers.set(sender.id, dispose)
    if (!watcherOwners.has(sender.id)) {
      watcherOwners.add(sender.id)
      sender.once('destroyed', () => {
        documentWatchers.get(sender.id)?.()
        documentWatchers.delete(sender.id)
        watcherOwners.delete(sender.id)
      })
    }
  })
  ipcMain.handle(IPC.invoke.fsListAll, (_event, root: string) => fileService.listAllFiles(root))
  ipcMain.handle(IPC.invoke.fsCopyIntoWorkspace, (_event, input: CopyIntoWorkspaceInput) =>
    fileService.copyIntoWorkspace(input)
  )

  // ── 版本控制（Git 面板）──
  // 全部走 { success, error?, errorCode? } 信封（见 shared/git-types.ts）：
  // git 操作失败是常态（冲突、网络、权限），渲染层需要按 errorCode 给用户出路，
  // 而不是靠解析抛错的文案。cwd 由服务层过工作区白名单校验。
  /** 包一层兜底：服务层漏出的异常（如路径越界）也归一成信封，不抛给渲染层 */
  const guard = <T extends GitResult>(run: () => Promise<T>): Promise<T> =>
    run().catch((error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }) as T)

  ipcMain.handle(IPC.invoke.gitInit, (_e, cwd: string) => guard(() => gitService.init(cwd)))
  ipcMain.handle(IPC.invoke.gitStatus, (_e, cwd: string) => guard(() => gitService.status(cwd)))
  ipcMain.handle(IPC.invoke.gitDiff, (_e, cwd: string, path: string, staged: boolean, base?: 'index' | 'head') =>
    guard(() => gitService.diff(cwd, path, staged, base))
  )
  ipcMain.handle(IPC.invoke.gitBranchInfo, (_e, cwd: string) => guard(() => gitService.branchInfo(cwd)))
  ipcMain.handle(IPC.invoke.gitStage, (_e, cwd: string, path: string) => guard(() => gitService.stage(cwd, path)))
  ipcMain.handle(IPC.invoke.gitUnstage, (_e, cwd: string, path: string) => guard(() => gitService.unstage(cwd, path)))
  ipcMain.handle(IPC.invoke.gitDiscardFile, (_e, cwd: string, path: string) =>
    guard(() => gitService.discardFile(cwd, path))
  )
  ipcMain.handle(IPC.invoke.gitDiscardWorktree, (_e, cwd: string, path: string) =>
    guard(() => gitService.discardWorktree(cwd, path))
  )
  ipcMain.handle(IPC.invoke.gitDiscardWorktreeFiles, (_e, cwd: string, paths: string[]) =>
    guard(() => gitService.discardWorktreeFiles(cwd, paths))
  )
  ipcMain.handle(IPC.invoke.gitStageFiles, (_e, cwd: string, paths: string[]) =>
    guard(() => gitService.stageFiles(cwd, paths))
  )
  ipcMain.handle(IPC.invoke.gitCheckIgnored, (_e, cwd: string, paths: string[]) =>
    guard(() => gitService.checkIgnored(cwd, paths))
  )
  ipcMain.handle(IPC.invoke.gitUnstageFiles, (_e, cwd: string, paths: string[]) =>
    guard(() => gitService.unstageFiles(cwd, paths))
  )
  ipcMain.handle(IPC.invoke.gitDiscardFiles, (_e, cwd: string, paths: string[]) =>
    guard(() => gitService.discardFiles(cwd, paths))
  )
  ipcMain.handle(IPC.invoke.gitHeadFile, (_e, cwd: string, path: string) =>
    guard(() => gitService.headFile(cwd, path))
  )
  ipcMain.handle(IPC.invoke.gitFetch, (_e, cwd: string) => guard(() => gitService.fetchRemote(cwd)))
  ipcMain.handle(IPC.invoke.gitPull, (_e, cwd: string) => guard(() => gitService.pull(cwd)))
  ipcMain.handle(IPC.invoke.gitPush, (_e, cwd: string) => guard(() => gitService.push(cwd)))
  ipcMain.handle(IPC.invoke.gitDivergence, (_e, cwd: string) => guard(() => gitService.divergence(cwd)))
  ipcMain.handle(IPC.invoke.gitPullMerge, (_e, cwd: string, remember: boolean) =>
    guard(() => gitService.pullMerge(cwd, remember))
  )
  ipcMain.handle(IPC.invoke.gitPullRebaseChoice, (_e, cwd: string, remember: boolean) =>
    guard(() => gitService.pullRebaseWithChoice(cwd, remember))
  )
  ipcMain.handle(IPC.invoke.gitAddSshKey, (_e, passphrase: string) => guard(() => addSshKeyToAgent(passphrase)))
  ipcMain.handle(IPC.invoke.gitBranches, (_e, cwd: string) => guard(() => gitService.listBranches(cwd)))
  ipcMain.handle(IPC.invoke.gitCheckout, (_e, cwd: string, branch: string) =>
    guard(() => gitService.checkout(cwd, branch))
  )
  ipcMain.handle(IPC.invoke.gitCreateBranch, (_e, cwd: string, name: string, startPoint?: string) =>
    guard(() => gitService.createBranch(cwd, name, startPoint))
  )
  ipcMain.handle(IPC.invoke.gitDiscardHunk, (_e, cwd: string, path: string, hunkId: string) =>
    guard(() => gitService.discardHunk(cwd, path, hunkId))
  )
  ipcMain.handle(IPC.invoke.gitCommit, (_e, cwd: string, message: string) =>
    guard(() => gitService.commit(cwd, message))
  )
  ipcMain.handle(IPC.invoke.gitStageAllAndCommit, (_e, cwd: string, message: string) =>
    guard(() => gitService.stageAllAndCommit(cwd, message))
  )
  ipcMain.handle(IPC.invoke.gitHeadFileContent, (_e, cwd: string, path: string) =>
    guard(() => gitService.getHeadFile(cwd, path))
  )
  ipcMain.handle(IPC.invoke.gitAppendGitignore, (_e, cwd: string, path: string) =>
    guard(() => gitService.appendGitignore(cwd, path))
  )
  ipcMain.handle(IPC.invoke.gitSuggestMessage, (_e, cwd: string) =>
    guard(() => gitService.suggestCommitMessage(cwd))
  )
  ipcMain.handle(IPC.invoke.gitCommitAmend, (_e, cwd: string) => guard(() => gitService.commitAmend(cwd)))
  ipcMain.handle(IPC.invoke.gitCommitAmendMessage, (_e, cwd: string, message: string) =>
    guard(() => gitService.commitAmendWithMessage(cwd, message))
  )
  ipcMain.handle(IPC.invoke.gitUndoCommit, (_e, cwd: string) => guard(() => gitService.undoCommit(cwd)))
  ipcMain.handle(IPC.invoke.gitCommitEmpty, (_e, cwd: string, message: string) =>
    guard(() => gitService.commitEmpty(cwd, message))
  )
  ipcMain.handle(IPC.invoke.gitSync, (_e, cwd: string) => guard(() => gitService.sync(cwd)))
  ipcMain.handle(IPC.invoke.gitPullRebase, (_e, cwd: string) => guard(() => gitService.pullRebase(cwd)))
  ipcMain.handle(IPC.invoke.gitPushForce, (_e, cwd: string) => guard(() => gitService.pushForce(cwd)))
  ipcMain.handle(IPC.invoke.gitPushTags, (_e, cwd: string) => guard(() => gitService.pushTags(cwd)))
  ipcMain.handle(IPC.invoke.gitPushTag, (_e, cwd: string, name: string) => guard(() => gitService.pushTag(cwd, name)))
  ipcMain.handle(IPC.invoke.gitPullFrom, (_e, cwd: string, remote: string, branch: string) =>
    guard(() => gitService.pullFrom(cwd, remote, branch))
  )
  ipcMain.handle(IPC.invoke.gitPushTo, (_e, cwd: string, remote: string, branch?: string) =>
    guard(() => gitService.pushTo(cwd, remote, branch))
  )
  ipcMain.handle(IPC.invoke.gitRemoteBranches, (_e, cwd: string) =>
    guard(() => gitService.listRemoteBranches(cwd))
  )
  ipcMain.handle(IPC.invoke.gitDeleteRemoteBranch, (_e, cwd: string, remote: string, branch: string) =>
    guard(() => gitService.deleteRemoteBranch(cwd, remote, branch))
  )
  ipcMain.handle(IPC.invoke.gitDeleteRemoteTag, (_e, cwd: string, name: string, remote?: string) =>
    guard(() => gitService.deleteRemoteTag(cwd, name, remote))
  )
  ipcMain.handle(IPC.invoke.gitDeleteBranch, (_e, cwd: string, name: string, force?: boolean) =>
    guard(() => gitService.deleteBranch(cwd, name, force))
  )
  ipcMain.handle(IPC.invoke.gitRenameBranch, (_e, cwd: string, oldName: string, newName: string) =>
    guard(() => gitService.renameBranch(cwd, oldName, newName))
  )
  ipcMain.handle(IPC.invoke.gitPublishBranch, (_e, cwd: string) => guard(() => gitService.publishBranch(cwd)))
  ipcMain.handle(IPC.invoke.gitMerge, (_e, cwd: string, ref: string) => guard(() => gitService.merge(cwd, ref)))
  ipcMain.handle(IPC.invoke.gitMergeAbort, (_e, cwd: string) => guard(() => gitService.mergeAbort(cwd)))
  ipcMain.handle(IPC.invoke.gitRebase, (_e, cwd: string, ref: string) => guard(() => gitService.rebase(cwd, ref)))
  ipcMain.handle(IPC.invoke.gitRebaseAbort, (_e, cwd: string) => guard(() => gitService.rebaseAbort(cwd)))
  ipcMain.handle(IPC.invoke.gitCherryPick, (_e, cwd: string, hash: string) =>
    guard(() => gitService.cherryPick(cwd, hash))
  )
  ipcMain.handle(IPC.invoke.gitCherryPickAbort, (_e, cwd: string) => guard(() => gitService.cherryPickAbort(cwd)))
  ipcMain.handle(IPC.invoke.gitRevertCommit, (_e, cwd: string, hash: string) =>
    guard(() => gitService.revertCommit(cwd, hash))
  )
  ipcMain.handle(IPC.invoke.gitRemotes, (_e, cwd: string) => guard(() => gitService.listRemotes(cwd)))
  ipcMain.handle(IPC.invoke.gitAddRemote, (_e, cwd: string, name: string, url: string) =>
    guard(() => gitService.addRemote(cwd, name, url))
  )
  ipcMain.handle(IPC.invoke.gitRemoveRemote, (_e, cwd: string, name: string) =>
    guard(() => gitService.removeRemote(cwd, name))
  )
  // 克隆：invoke 挂起至结束，期间进度经 event.sender 定向推回发起窗口
  ipcMain.handle(IPC.invoke.gitClone, (event, options: GitCloneOptions) =>
    cloneRepository(options, (payload) => {
      if (!event.sender.isDestroyed()) {
        try {
          event.sender.send(IPC.event.gitCloneProgress, payload)
        } catch {
          // 发送失败（窗口销毁中）不影响克隆本身
        }
      }
    })
  )
  ipcMain.handle(IPC.invoke.gitCloneCancel, (_e, cloneId: string) => cancelClone(cloneId))
  ipcMain.handle(IPC.invoke.gitStashList, (_e, cwd: string) => guard(() => gitService.listStashes(cwd)))
  ipcMain.handle(IPC.invoke.gitStashPush, (_e, cwd: string, message?: string, includeUntracked?: boolean) =>
    guard(() => gitService.stashPush(cwd, message, includeUntracked))
  )
  ipcMain.handle(IPC.invoke.gitStashPushStaged, (_e, cwd: string, message?: string) =>
    guard(() => gitService.stashPushStaged(cwd, message))
  )
  ipcMain.handle(IPC.invoke.gitStashPop, (_e, cwd: string, index?: number) =>
    guard(() => gitService.stashPop(cwd, index))
  )
  ipcMain.handle(IPC.invoke.gitStashApply, (_e, cwd: string, index?: number) =>
    guard(() => gitService.stashApply(cwd, index))
  )
  ipcMain.handle(IPC.invoke.gitStashDrop, (_e, cwd: string, index: number) =>
    guard(() => gitService.stashDrop(cwd, index))
  )
  ipcMain.handle(IPC.invoke.gitStashDropBatch, (_e, cwd: string, indexes: number[]) =>
    guard(() => gitService.stashDropBatch(cwd, indexes))
  )
  ipcMain.handle(IPC.invoke.gitStashClear, (_e, cwd: string) => guard(() => gitService.stashClear(cwd)))
  ipcMain.handle(IPC.invoke.gitStashShow, (_e, cwd: string, index: number) =>
    guard(() => gitService.stashShow(cwd, index))
  )
  ipcMain.handle(IPC.invoke.gitStashShowFiles, (_e, cwd: string, index: number) =>
    guard(() => gitService.stashShowFiles(cwd, index))
  )
  ipcMain.handle(IPC.invoke.gitTags, (_e, cwd: string) => guard(() => gitService.listTags(cwd)))
  ipcMain.handle(IPC.invoke.gitCreateTag, (_e, cwd: string, name: string, message?: string) =>
    guard(() => gitService.createTag(cwd, name, message))
  )
  ipcMain.handle(IPC.invoke.gitDeleteTag, (_e, cwd: string, name: string) =>
    guard(() => gitService.deleteTag(cwd, name))
  )
  ipcMain.handle(IPC.invoke.gitLog, (_e, cwd: string, limit?: number, skip?: number, query?: GitLogQuery) =>
    guard(() => gitService.log(cwd, limit, skip, query))
  )
  ipcMain.handle(IPC.invoke.gitIncoming, (_e, cwd: string, limit?: number) =>
    guard(() => gitService.incomingLog(cwd, limit))
  )
  ipcMain.handle(IPC.invoke.gitCommitShow, (_e, cwd: string, hash: string) =>
    guard(() => gitService.commitShow(cwd, hash))
  )
  ipcMain.handle(IPC.invoke.gitShowCommitFile, (_e, cwd: string, hash: string, path: string) =>
    guard(() => gitService.showCommitFile(cwd, hash, path))
  )
  ipcMain.handle(IPC.invoke.gitFileHistory, (_e, cwd: string, path: string, limit?: number, cursor?: string) =>
    guard(() => gitService.fileHistory(cwd, path, limit, cursor))
  )
  ipcMain.handle(IPC.invoke.gitBlame, (_e, cwd: string, path: string) => guard(() => gitService.blame(cwd, path)))
  ipcMain.handle(IPC.invoke.gitUserName, (_e, cwd: string) => guard(() => gitService.getUserName(cwd)))
  ipcMain.handle(IPC.invoke.gitListAuthors, (_e, cwd: string) => guard(() => gitService.listAuthors(cwd)))

  // ── 全局搜索 ──
  // 排除表由渲染层随选项一起传来（主进程不读设置，保持无状态）：
  // 渲染层手上有最新的 settings，改完设置立刻生效，无需等主进程缓存刷新。
  ipcMain.handle(
    IPC.invoke.searchQuery,
    (_event, root: string, query: string, options?: SearchOptions, excludes?: FilesExclude) =>
      searchWorkspace(root, query, options, excludes)
  )
  ipcMain.handle(
    IPC.invoke.searchReplace,
    (
      _event,
      root: string,
      query: string,
      options: SearchOptions,
      replaceText: string,
      excludes?: FilesExclude
    ) => replaceWorkspace(root, query, options, replaceText, excludes)
  )
  ipcMain.handle(
    IPC.invoke.searchReplacePreview,
    (
      _event,
      root: string,
      query: string,
      options: SearchOptions,
      replaceText: string,
      excludes?: FilesExclude
    ) => previewReplaceWorkspace(root, query, options, replaceText, excludes)
  )

  // ── 终端（node-pty，多实例按 id 路由）──
  // 数据回发绑定到发起窗口：单窗口应用下等价于全局广播，但语义上更准确。
  ipcMain.handle(IPC.invoke.terminalCreate, async (event, input: TerminalCreateInput) => {
    const sender = event.sender
    if (engineHost.getSnapshot().mode === 'remote') {
      return remoteTerminalService.create(input, {
        onData: (id, chunk) => { if (!sender.isDestroyed()) sender.send(IPC.event.terminalData, { id, chunk }) },
        onExit: (info) => { if (!sender.isDestroyed()) sender.send(IPC.event.terminalExit, info) }
      })
    }
    return createTerminal(
      input,
      (id, chunk) => {
        if (!sender.isDestroyed()) sender.send(IPC.event.terminalData, { id, chunk })
      },
      (info) => {
        if (!sender.isDestroyed()) sender.send(IPC.event.terminalExit, info)
      }
    )
  })
  ipcMain.handle(IPC.invoke.terminalWrite, (_event, id: string, data: string) => {
    if (remoteTerminalService.owns(id)) return remoteTerminalService.write(id, data)
    return writeTerminal(id, data)
  })
  ipcMain.handle(IPC.invoke.terminalResize, (_event, id: string, cols: number, rows: number) => {
    if (remoteTerminalService.owns(id)) return remoteTerminalService.resize(id, cols, rows)
    return resizeTerminal(id, cols, rows)
  })
  ipcMain.handle(IPC.invoke.terminalDispose, (_event, id: string) => {
    if (remoteTerminalService.owns(id)) return remoteTerminalService.dispose(id)
    return disposeTerminal(id)
  })

  // ── TS 语言服务（typescript-language-server，单实例）──
  // 与引擎 SSE 同款双向长连接：渲染进程发 JSON-RPC 经 lsp:send 进 stdin，
  // stdout 解帧后经 lsp:message 广播回来。LSP 只有一个服务器进程，
  // 无需 streamId 路由 —— 所有窗口共享同一份诊断。
  ipcMain.handle(IPC.invoke.lspStart, (_event, input: LspStartInput) => {
    try {
      // Dev uses the installed dependency. Packaged builds carry the server beside
      // the engine runtime, so they never depend on an asar dependency resolution.
      let entry: string
      let nodePath: string | undefined
      if (app.isPackaged) {
        const runtime = resolveRuntime()
        if (!runtime) throw new Error('配套引擎运行时不存在，无法启动 TypeScript 语言服务')
        entry = join(runtime.root, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs')
        nodePath = runtime.nodePath
      } else {
        entry = input.serverEntry || require.resolve('typescript-language-server/lib/cli.mjs')
        nodePath = input.nodePath
      }
      if (!existsSync(entry)) throw new Error(`TypeScript 语言服务入口不存在：${entry}`)
      lspServer.startLsp(entry, {
        onMessage: (message: LspMessage) => broadcast(IPC.event.lspMessage, message),
        onExit: (info) => broadcast(IPC.event.lspExit, info)
      }, nodePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.invoke.lspStop, () => {
    lspServer.stopLsp()
    return { ok: true }
  })
  ipcMain.handle(IPC.invoke.lspSend, (_event, message: LspMessage) => {
    return { ok: lspServer.sendToLsp(message) }
  })
}

/** 应用退出时中止所有流，避免 reader 悬挂 */
export function abortAllStreams(): void {
  for (const controller of activeStreams.values()) controller.abort()
  activeStreams.clear()
}

/** 应用退出时停掉语言服务进程 */
export function disposeLsp(): void {
  lspServer.stopLsp()
}
