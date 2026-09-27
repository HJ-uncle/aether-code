/**
 * IPC 通道注册
 *
 * 通道刻意保持少而稳定：生命周期走具名通道，业务数据走一个通用 request 通道。
 * 这样后续接入 workspace / terminal / lsp 等路由时无需新增 IPC 协议。
 *
 * 流式对话例外：SSE 需要主进程持续推送，用 start/abort + 事件通道实现。
 */
import { ipcMain, webContents, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  CopyIntoWorkspaceInput,
  EngineRequestInput,
  EngineSnapshot,
  SearchOptions,
  StreamEvent,
  StreamStartInput,
  TerminalCreateInput
} from '../shared/ipc'
import { engineRequest } from './engine/client'
import { engineHost } from './engine/host'
import { onEngineLog } from './engine/logger'
import * as fileService from './fs/file-service'
import * as gitService from './git/git-service'
import {
  createTerminal,
  disposeTerminal,
  resizeTerminal,
  writeTerminal
} from './terminal/pty-service'
import { replaceWorkspace, searchWorkspace, previewReplaceWorkspace } from './search/search-service'
import { getSettings, updateSettings } from './settings-store'
import type { AppSettings } from '../shared/ipc'

/** 进行中的 SSE 请求：streamId → AbortController */
const activeStreams = new Map<string, AbortController>()

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
    const settings = getSettings()
    return engineHost.start(settings.engineMode, settings.remoteBaseUrl)
  })

  ipcMain.handle(IPC.invoke.engineStop, () => engineHost.stop())

  ipcMain.handle(IPC.invoke.engineRestart, async () => {
    const settings = getSettings()
    await engineHost.stop()
    return engineHost.start(settings.engineMode, settings.remoteBaseUrl)
  })

  // ── 业务请求 ──
  ipcMain.handle(IPC.invoke.engineRequest, (_event, input: EngineRequestInput) =>
    engineRequest(input)
  )

  // ── 流式请求 ──
  ipcMain.handle(IPC.invoke.engineStreamStart, async (_event, input: StreamStartInput) => {
    // 同一 streamId 重复启动时先中止旧的，避免两个 reader 抢同一个通道
    activeStreams.get(input.streamId)?.abort()

    const controller = new AbortController()
    activeStreams.set(input.streamId, controller)

    try {
      await engineHost.stream(input.streamId, input.path, input.body, controller.signal)
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
  ipcMain.handle(IPC.invoke.settingsUpdate, (_event, patch: Partial<AppSettings>) =>
    updateSettings(patch)
  )

  // ── 文件系统 ──
  // 这些 handler 直接抛错：文件操作失败原因（不存在/无权限/越界）需要原样
  // 传到界面，包一层 result 信封反而会丢掉调用栈与错误类型。
  ipcMain.handle(IPC.invoke.fsPickFolder, async () => {
    const folder = await fileService.pickFolder()
    // 记住选择，下次启动可直接恢复并保持授权
    if (folder) updateSettings({ lastFolder: folder })
    return folder
  })
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
  ipcMain.handle(IPC.invoke.fsTrash, (_event, target: string) => fileService.trashPath(target))
  ipcMain.handle(IPC.invoke.fsStat, (_event, target: string) => fileService.statPath(target))
  ipcMain.handle(IPC.invoke.fsListAll, (_event, root: string) => fileService.listAllFiles(root))
  ipcMain.handle(IPC.invoke.fsCopyIntoWorkspace, (_event, input: CopyIntoWorkspaceInput) =>
    fileService.copyIntoWorkspace(input)
  )

  // ── 版本控制（只读）──
  // 与 fs 同样直接抛错：git 不可用、路径越界都属于需要原样呈现给用户的原因。
  // 唯一的例外是「不是 git 仓库」，它由 getStatus 返回 isRepo=false 表达。
  ipcMain.handle(IPC.invoke.gitStatus, (_event, root: string) => gitService.getStatus(root))
  ipcMain.handle(IPC.invoke.gitLog, (_event, root: string, limit?: number) =>
    gitService.getLog(root, limit)
  )

  // ── 全局搜索 ──
  ipcMain.handle(
    IPC.invoke.searchQuery,
    (_event, root: string, query: string, options?: SearchOptions) =>
      searchWorkspace(root, query, options)
  )
  ipcMain.handle(
    IPC.invoke.searchReplace,
    (_event, root: string, query: string, options: SearchOptions, replaceText: string) =>
      replaceWorkspace(root, query, options, replaceText)
  )
  ipcMain.handle(
    IPC.invoke.searchReplacePreview,
    (_event, root: string, query: string, options: SearchOptions, replaceText: string) =>
      previewReplaceWorkspace(root, query, options, replaceText)
  )

  // ── 终端（node-pty，多实例按 id 路由）──
  // 数据回发绑定到发起窗口：单窗口应用下等价于全局广播，但语义上更准确。
  ipcMain.handle(IPC.invoke.terminalCreate, (event, input: TerminalCreateInput) => {
    const sender = event.sender
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
  ipcMain.handle(IPC.invoke.terminalWrite, (_event, id: string, data: string) =>
    writeTerminal(id, data)
  )
  ipcMain.handle(IPC.invoke.terminalResize, (_event, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows)
  )
  ipcMain.handle(IPC.invoke.terminalDispose, (_event, id: string) => disposeTerminal(id))
}

/** 应用退出时中止所有流，避免 reader 悬挂 */
export function abortAllStreams(): void {
  for (const controller of activeStreams.values()) controller.abort()
  activeStreams.clear()
}
