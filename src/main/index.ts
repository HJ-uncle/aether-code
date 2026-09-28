import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { engineHost } from './engine/host'
import * as fileService from './fs/file-service'
import { abortAllStreams, disposeLsp, registerIpcHandlers } from './ipc'
import { disposeAllTerminals } from './terminal/pty-service'
import { getSettings } from './settings-store'
import { existsSync } from 'node:fs'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // 自绘标题栏：去掉系统边框，最小化/最大化/关闭由渲染层的菜单栏按钮驱动
    // （Windows/Linux 生效；macOS 保留原生红绿灯更符合平台习惯）
    ...(process.platform === 'darwin' ? {} : { frame: false }),
    backgroundColor: '#1e1e1e',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 单实例：IDE 重复启动没有意义，且会造成两个引擎争抢端口
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.aether.ide')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerIpcHandlers()

    // 用英文输出，避免在非 UTF-8 控制台（Windows 默认 GBK）下显示成乱码
    console.log(
      '[aether-ide] Engine logs are shown in the IDE "Output" panel. ' +
        'Set AETHER_IDE_ECHO_ENGINE=1 to also echo them to this terminal.'
    )

    // 恢复上次打开的工作区并重新授权：
    // 授权集合保存在内存中，重启后必须显式恢复，否则文件树会因越界校验而报错
    const bootSettings = getSettings()
    if (bootSettings.lastFolder && existsSync(bootSettings.lastFolder)) {
      fileService.allowRoot(bootSettings.lastFolder)
    }

    createWindow()

    // 按设置自动拉起引擎；失败不影响窗口打开（UI 会显示错误状态）
    if (bootSettings.autoStartEngine) {
      void engineHost.start(bootSettings.engineMode, bootSettings.remoteBaseUrl).catch((err) => {
        console.error('[engine] 自动启动失败:', err)
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // 引擎是主进程的子进程：必须在这里显式回收，否则退出后会留下孤儿进程占着端口
  app.on('before-quit', () => {
    abortAllStreams()
    disposeAllTerminals()
    disposeLsp()
  })

  app.on('will-quit', (event) => {
    if (engineHost.getSnapshot().phase === 'idle') return
    // 异步关闭需要拦一次退出流程
    event.preventDefault()
    void engineHost.stop().finally(() => {
      app.exit(0)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
