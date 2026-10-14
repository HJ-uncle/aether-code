import { app, ipcMain, webContents } from 'electron'
import { join } from 'node:path'
import { WORK_QUEUE_IPC } from '../shared/work-next-turn-api'
import { NextTurnQueueStore } from './next-turn-queue-store'
import { EngineQueueGateway } from './next-turn-engine-gateway'
import { engineHost } from './engine/host'
import { createWorkNextTurnOwner } from './work-next-turn-owner'
import { NextTurnQueueWorkerFactory } from './next-turn-queue-worker-factory'
import { BUNDLED_QUEUE_WORKER } from 'virtual:aether-queue-worker'
import { NextTurnQueueError } from '../shared/next-turn-queue'

let owner: ReturnType<typeof createWorkNextTurnOwner> | undefined
export function registerWorkNextTurnQueue(): void {
  if (owner) throw new Error('Work next-turn owner is already installed')
  const nativeOptIn = process.env.AETHER_NEXT_TURN_BACKEND === 'sqlite-worker-opt-in'
  const workerDirectory = app.isPackaged && app.getAppPath().endsWith('.asar') ? join(app.getAppPath() + '.unpacked', 'out', 'main') : __dirname
  const store = nativeOptIn ? new NextTurnQueueWorkerFactory(join(app.getPath('userData'), 'next-turn-queue-native-v1'), {
    enabled: true, workerBundle: { path: join(workerDirectory, BUNDLED_QUEUE_WORKER.relativePath), sha256: BUNDLED_QUEUE_WORKER.sha256 },
    captureEpoch: () => {
      const snapshot = engineHost.getSnapshot(), signal = engineHost.requestSignal
      if (snapshot.phase !== 'ready' || !snapshot.instanceId || signal.aborted) throw new NextTurnQueueError('AUTHORITY', 'Native queue engine is not ready')
      return { generation: snapshot.instanceId, signal, source: { mode: snapshot.mode,
        endpoint: snapshot.mode === 'embedded' ? '' : new URL(snapshot.baseUrl).href.replace(/\/+$/, ''), accountId: snapshot.accountId ?? null } }
    }
  }) : new NextTurnQueueStore(join(app.getPath('userData'), 'next-turn-queue-v1'))
  owner = createWorkNextTurnOwner({
    gateway: new EngineQueueGateway(), store,
    engine: {
      snapshot: () => engineHost.getSnapshot(), signal: () => engineHost.requestSignal,
      subscribe: listener => { engineHost.on('snapshot', listener); return () => { engineHost.removeListener('snapshot', listener) } }
    },
    ipc: { handle: (channel, listener) => { ipcMain.handle(channel, listener) }, removeHandler: channel => { ipcMain.removeHandler(channel) } },
    changed: (scope, revision) => {
      for (const sender of webContents.getAllWebContents()) if (!sender.isDestroyed()) {
        try { sender.send(WORK_QUEUE_IPC.changed, { scope, revision }) } catch (error) { console.error('[next-turn] renderer delivery failed:', error instanceof Error ? error.message : 'unknown') }
      }
    }
  })
}
export function closeWorkNextTurnQueue(): Promise<void> { return owner?.close() ?? Promise.resolve() }
