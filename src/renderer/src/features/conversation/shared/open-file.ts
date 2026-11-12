import { getSnapshot } from '@renderer/core/engine/client'
import { assertEngineSource, getEngineSource, getEngineStorageKey, isEngineReady, isRemoteEngine } from '@renderer/core/engine/source'
import { paths, readLocalRecoveryFile, resolveSessionFilePath, workspaceRecoveryCandidates } from '@renderer/core/workspace/fs-client'
import { type ChatFileContext, type ChatLinkTarget } from './chat-link'
import { openExternalSessionPathResource, openSessionFileResource } from '../../workspace/resource-store'
import { getSessionState } from '../../sessions/state'

/** Message links keep the authenticated session target and never activate a legacy editor view. */
export async function openFileFromChat(rawPath: string, context?: ChatFileContext): Promise<void> {
  const source = getEngineSource()
  const state = getSessionState(getEngineStorageKey())
  const sessionId = context?.sessionId ?? state.activeTaskId ?? state.homeSessionId
  if (!sessionId) throw new Error('请先选择文件所属会话。')
  const workspaceRoot = context?.workspaceRoot ?? (state.activeTaskId
    ? state.tasks.find(task => task.id === state.activeTaskId)?.workspacePath : state.homeWorkspacePath)
  const assertOpeningContext = (): void => {
    if (source !== getEngineSource()) throw new Error('引擎连接已变化，请在当前会话重试')
    if (isRemoteEngine()) assertEngineSource(source)
    const current = getSessionState(getEngineStorageKey())
    if ((current.activeTaskId ?? current.homeSessionId) !== sessionId)
      throw new Error('会话已经切换，请返回文件所属会话后重试。')
  }
  const snapshot = await getSnapshot()
  assertOpeningContext()
  const remote = snapshot.mode === 'remote' || isRemoteEngine()
  const match = /:(\d+)(?::(\d+))?$/.exec(rawPath.trim())
  const pathText = (match ? rawPath.trim().slice(0, match.index) : rawPath).trim()
    .replace(/^[`'"<]+|[`'">]+$/g, '').replace(/^path:/i, '')
  if (!pathText) return
  let resolved: Awaited<ReturnType<typeof resolveSessionFilePath>>
  try {
    resolved = await resolveSessionFilePath(sessionId, pathText, workspaceRoot)
  } catch (error) {
    if (remote) throw error
    assertOpeningContext()
    // Offline recovery reads only the owning task's known directory. It never
    // rebinds the session or writes a recovered path into another workspace.
    const offline = !isEngineReady()
    const recoveryRoot = offline
      ? state.tasks.find(task => task.id === sessionId)?.workspacePath ?? (!state.activeTaskId ? state.homeWorkspacePath : null)
      : workspaceRoot
    const candidates = workspaceRecoveryCandidates(pathText, recoveryRoot)
      .filter(candidate => !offline || Boolean(recoveryRoot && paths.contains(recoveryRoot, candidate)))
    for (const candidate of candidates) {
      try {
        await readLocalRecoveryFile(candidate)
        assertOpeningContext()
        openExternalSessionPathResource(candidate, sessionId)
        return
      } catch { /* Try the next bounded candidate before surfacing the resolver error. */ }
    }
    throw error
  }
  assertOpeningContext()
  // Completed output roots can outlive a private scratch root. Prefer an
  // existing local output while keeping the session resolver as the fallback.
  if (!remote && workspaceRoot && !paths.contains(workspaceRoot, resolved.path)) {
    for (const candidate of workspaceRecoveryCandidates(pathText, workspaceRoot)) {
      try {
        await readLocalRecoveryFile(candidate)
        assertOpeningContext()
        openExternalSessionPathResource(candidate, sessionId)
        return
      } catch { /* Preserve the authenticated session target as fallback. */ }
    }
  }
  openSessionFileResource(resolved.path, resolved.target)
}

/** A download URL names a session artifact, not a local path or a navigation URL. */
export async function openArtifactFromChat(target: Extract<ChatLinkTarget, { kind: 'artifact' }>, context: ChatFileContext): Promise<void> {
  if (target.sessionId !== context.sessionId) throw new Error('文件链接不属于当前消息会话。')
  await openFileFromChat(target.path, context)
}
