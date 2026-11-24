import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'

const channel = 'aether:admin-window:1'
export interface AdminWindowLease { key: string; revoke(): void }
/** The private key stays in Electron memory. Only its digest travels over the owned child's IPC pipe. */
export function leaseAdminWindow(child: ChildProcess, signal: AbortSignal): Promise<AdminWindowLease | undefined> {
  const id = randomUUID(), key = 'aether_admin_' + randomBytes(32).toString('base64url')
  const digest = createHash('sha256').update(key).digest('hex')
  return new Promise((resolve, reject) => {
    const send = (message: object, callback: (error: Error | null) => void): void => {
      try { if (child.connected) child.send(message, callback); else callback(new Error()) } catch { callback(new Error()) }
    }
    let revoked = false
    const revoke = (): void => {
      if (revoked) return
      revoked = true
      signal.removeEventListener('abort', revoke)
      send({ channel, action: 'close', id }, () => {})
    }
    const cleanup = (): void => {
      clearTimeout(timer); child.off('message', message); child.off('disconnect', failed); child.off('exit', failed); signal.removeEventListener('abort', failed)
    }
    const failed = (): void => { cleanup(); revoke(); reject(new Error('未能连接本机管理窗口。请重新连接引擎后再打开。')) }
    const message = (msg: unknown): void => {
      if (!msg || typeof msg !== 'object') return
      const ack = msg as Record<string, unknown>
      if (ack.channel !== channel || ack.action !== 'opened' || ack.id !== id || typeof ack.enabled !== 'boolean') return
      cleanup()
      if (!ack.enabled) { resolve(undefined); return }
      signal.addEventListener('abort', revoke, { once: true })
      resolve({ key, revoke })
    }
    const timer = setTimeout(failed, 4000); timer.unref()
    if (signal.aborted || !child.connected) { failed(); return }
    child.on('message', message); child.once('disconnect', failed); child.once('exit', failed); signal.addEventListener('abort', failed, { once: true })
    send({ channel, action: 'open', id, digest }, error => { if (error) failed() })
  })
}
