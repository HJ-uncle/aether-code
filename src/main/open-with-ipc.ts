import { ipcMain, shell } from 'electron'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { IPC, OPEN_WITH_APP_IDS, type OpenWithAppId } from '../shared/ipc'
import { assertTrustedRenderer } from './ipc-security'
import { assertAllowed } from './fs/file-service'
import { getSettings } from './settings-store'
import { engineHost } from './engine/host'
import { detectOpenWithApplications, launchOpenWithApplication } from './open-with'

const applicationIds = new Set<OpenWithAppId>(OPEN_WITH_APP_IDS)

function assertLocalEngine(): void {
  if (getSettings().engineMode === 'remote' || engineHost.getSnapshot().mode === 'remote') {
    throw new Error('远程工作区不能使用本机的打开方式')
  }
}

export function registerOpenWithIpc(): void {
  ipcMain.handle(IPC.invoke.systemGetOpenWithApps, async event => {
    assertTrustedRenderer(event, '读取打开方式')
    return (await detectOpenWithApplications()).map(item => item.app)
  })
  ipcMain.handle(IPC.invoke.systemOpenWith, async (event, target: unknown, application: unknown) => {
    assertTrustedRenderer(event, '在外部应用中打开')
    assertLocalEngine()
    if (typeof application !== 'string' || !applicationIds.has(application as OpenWithAppId)) throw new Error('不支持此打开方式')
    if (typeof target !== 'string' || !target || target.includes('\0') || !path.isAbsolute(target)) throw new Error('请选择有效的本地工作区目录')
    const directory = assertAllowed(target)
    let isDirectory = false
    try { isDirectory = (await stat(directory)).isDirectory() } catch { /* A removed project needs a readable error. */ }
    if (!isDirectory) throw new Error('工作区目录不存在或已不可访问')
    if (application === 'file-explorer') {
      assertLocalEngine()
      assertTrustedRenderer(event, '在外部应用中打开')
      const error = await shell.openPath(directory)
      if (error) throw new Error(`无法打开项目目录：${error}`)
      return
    }
    const installation = (await detectOpenWithApplications()).find(item => item.app.id === application)
    if (!installation?.app.available) throw new Error(installation?.app.unavailableReason ?? '此应用已不可用，请重新打开菜单')
    // Detection may yield to a source switch; recheck before starting any local process.
    assertLocalEngine()
    assertTrustedRenderer(event, '在外部应用中打开')
    await launchOpenWithApplication(installation, directory)
  })
}
