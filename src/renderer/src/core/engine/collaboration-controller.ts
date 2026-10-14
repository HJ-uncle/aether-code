import { request } from './client'
import { assertEngineSource, getEngineSource, getExpectedEngine } from './source'
import { CONTROLLER_OUTBOX_KEY, CONTROLLER_HISTORY_KEY, controllerConnectionIdentity } from './collaboration-contract'
import { CollaborationController, type ControllerEnvironment, type ControllerConnection } from './collaboration-controller-core'
export type { ControllerConnection, ControllerOutcome } from './collaboration-controller-core'

const OUTBOX_EVENT = 'aether:controller-outbox'
async function withControllerLock<T>(action: () => T | Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('当前窗口无法安全保存发送记录，请更新或重新打开应用')
  return await navigator.locks.request(CONTROLLER_OUTBOX_KEY, action)
}
export function captureControllerConnection(toolProfile: 'code' | 'general'): ControllerConnection {
  return { source: getEngineSource(), expectedEngine: getExpectedEngine(), toolProfile }
}
function defaultEnvironment(): ControllerEnvironment {
  return {
    request, storage: window.localStorage,
    // Serialize renderer windows before persisting an ambiguous delivery.
    lock: withControllerLock,
    current: connection => {
      assertEngineSource(connection.source)
      if (controllerConnectionIdentity(connection.expectedEngine) !== controllerConnectionIdentity(getExpectedEngine()))
        throw new Error('引擎连接或账号已变化，请在当前会话核对结果')
    },
    notify: () => window.dispatchEvent(new Event(OUTBOX_EVENT)), uuid: () => crypto.randomUUID(), now: Date.now
  }
}
export function subscribeControllerOutbox(notify: () => void): () => void {
  const storage = (event: StorageEvent): void => { if (event.key === null || event.key === CONTROLLER_OUTBOX_KEY || event.key === CONTROLLER_HISTORY_KEY) notify() }
  window.addEventListener(OUTBOX_EVENT, notify)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(OUTBOX_EVENT, notify); window.removeEventListener('storage', storage) }
}

export function createCollaborationController(): CollaborationController { return new CollaborationController(defaultEnvironment()) }
