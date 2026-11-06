import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { BrowserPreviewAccess } from './browser-preview'
import { engineRequest } from './engine/client'
import { engineHost } from './engine/host'
import { engineTargetError, type EngineIdentity } from './engine/protocol'

interface WorkspaceBinding { root?: unknown; bindingEpoch?: unknown; entries?: unknown }

/** The local engine is the authority for scratch workspaces that the user has
 * never opened in Code. Capturing its binding grants only this preview server. */
export async function sessionPreviewAccess(sessionId: string, expectedEngine: EngineIdentity): Promise<BrowserPreviewAccess> {
  const assertEngine = (): void => {
    const snapshot = engineHost.getSnapshot()
    if (expectedEngine.mode !== 'embedded' || snapshot.phase !== 'ready' || engineTargetError(snapshot, expectedEngine)) {
      throw new Error('引擎连接已变化，请在当前工作区重新运行')
    }
  }
  const binding = async (): Promise<{ root: string; epoch?: string }> => {
    assertEngine()
    const result = await engineRequest<WorkspaceBinding>({ method: 'GET', path: '/workspace/directory',
      query: { sessionId, path: '.' }, expectedEngine, toolProfile: 'general' })
    assertEngine()
    if (!result.ok) throw new Error(result.message || '无法确认当前会话的工作区')
    const root = result.data?.root, epoch = result.data?.bindingEpoch
    if (typeof root !== 'string' || !isAbsolute(root) || /[\u0000-\u001f\u007f]/.test(root) || !Array.isArray(result.data?.entries)) {
      throw new Error('引擎未提供有效的会话工作区')
    }
    return { root: resolve(root), epoch: typeof epoch === 'string' ? epoch : undefined }
  }
  const initial = await binding(), root = await realpath(initial.root)
  assertEngine()
  let revoked = false
  return {
    // A revoked preview must stay revoked; a fresh Run action gets a new
    // server rather than reusing the old server's failed binding closure.
    key: JSON.stringify([expectedEngine, sessionId, root, initial.epoch, randomUUID()]), root,
    async validate() {
      if (revoked) throw new Error('任务工作区已变化，请重新运行文件')
      try {
        const current = await binding()
        if (current.root !== initial.root || current.epoch !== initial.epoch || await realpath(current.root) !== root) {
          revoked = true
          throw new Error('任务工作区已变化，请重新运行文件')
        }
        assertEngine()
      } catch (error) {
        // Fail closed for this issued capability, even if a deleted session or
        // disconnected engine later reappears with the same path.
        revoked = true
        throw error
      }
    }
  }
}
