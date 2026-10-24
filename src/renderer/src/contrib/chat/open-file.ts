import { activateDocument } from '@renderer/core/editor/editor-activation'
import { assertDocumentConnection, getDocument, openFile } from '@renderer/core/editor/editor-store'
import { getWorkspaceState } from '@renderer/core/workspace/workspace-store'
import { getSnapshot } from '@renderer/core/engine/client'
import { resolveChatPath } from './chat-file-path'
import { assertEngineSource, getEngineSource, isRemoteEngine } from '@renderer/core/engine/source'
import { paths, readLocalRecoveryFile, remoteWorkspaceContext, remoteWorkspaceRelativePath, resolveSessionFilePath, workspaceRecoveryCandidates } from '@renderer/core/workspace/fs-client'
import { assertWorkspaceTarget } from '@renderer/core/workspace/connection'
import { type ChatFileContext, type ChatLinkTarget } from './chat-link'
import { getAppMode } from '@renderer/core/platform/app-mode'
import { openExternalWorkPathResource, openWorkFileResource } from '../work/work-resource-store'
import { getWorkState } from '../work/work-state'
import { getEngineStorageKey } from '@renderer/core/engine/source'

function activateLoadedFile(filePath: string, source: number): void {
  assertEngineSource(source)
  const doc = getDocument(filePath)
  if (!doc || doc.loading) throw new Error('文件已关闭或尚未加载完成，请重试。')
  if (doc.error) throw new Error(doc.error)
  assertDocumentConnection(doc)
  activateDocument(doc.path)
}

/**
 * 从聊天里打开文件：读进编辑器标签并激活，可带行号定位。
 *
 * 这是聊天视图（FileChangeCard / 工具行 / Markdown 链接）与编辑器之间
 * 唯一的通道 —— 对齐 wuzu-client 里「消息内点文件路径 → store.openFile()」
 * 的用法，但收口成一个函数，调用方不用关心激活与跳行的细节。
 *
 * 路径约定：
 * - 引擎/模型给的多是工作区相对路径（fileChange 帧、工具参数、正文里的
 *   反引号路径），用工作区根拼成绝对路径；
 * - 已是绝对路径（含盘符或 / 开头）则原样使用；
 * - 尾部可带 :line 或 :line:column（用户截图里 `file.ts:15` 这种写法）。
 */
export async function openFileFromChat(rawPath: string, context?: ChatFileContext): Promise<void> {
  const source = getEngineSource()
  const mode = getAppMode()
  const assertOpeningContext = (): void => {
    assertEngineSource(source)
    if (getAppMode() !== mode || (mode === 'work' && context?.sessionId && getWorkState(getEngineStorageKey()).activeTaskId !== context.sessionId)) throw new Error('会话或模式已经切换，请返回文件所属会话后重试。')
  }
  const snapshot = await getSnapshot()
  assertOpeningContext()
  const remoteMode = snapshot.mode === 'remote' || isRemoteEngine()
  if (context?.sessionId && (getAppMode() === 'work' || context.sessionId.startsWith('work-') || (!remoteMode && !context.workspaceRoot))) {
    const match = /:(\d+)(?::(\d+))?$/.exec(rawPath.trim())
    const pathText = (match ? rawPath.trim().slice(0, match.index) : rawPath).trim().replace(/^[`'"<]+|[`'">]+$/g, '').replace(/^path:/i, '')
    let resolved: Awaited<ReturnType<typeof resolveSessionFilePath>> | null = null
    try {
      resolved = await resolveSessionFilePath(context.sessionId, pathText, context.workspaceRoot)
    } catch (error) {
      // A receipt may outlive its task workspace (or point at a sibling task).
      // Local users still need to inspect that file; route it to the read-only
      // external resource surface instead of making them open a folder first.
      if (remoteMode) throw error
      assertOpeningContext()
      if (getAppMode() === 'work') {
        const candidates = workspaceRecoveryCandidates(pathText, context.workspaceRoot)
        for (const candidate of candidates) {
          try {
            await readLocalRecoveryFile(candidate)
            assertOpeningContext()
            openExternalWorkPathResource(candidate, context.sessionId)
            return
          } catch {
            // Try the sibling task root before surfacing the original session
            // boundary error. The read is limited and has no write path.
          }
        }
        throw error
      }
      const candidates = workspaceRecoveryCandidates(pathText, context.workspaceRoot)
      const candidate = candidates[0] ?? null
      if (!candidate) throw error
      await openFile(candidate, match ? Number(match[1]) : undefined, match?.[2] ? Number(match[2]) : undefined)
      assertOpeningContext()
      activateLoadedFile(candidate, source)
      return
    }
    if (!resolved) return
    assertOpeningContext()
    if (getAppMode() === 'work') {
      if (getWorkState(getEngineStorageKey()).activeTaskId !== context.sessionId) throw new Error('会话已经切换，请返回文件所属会话后重试。')
      // The session may still expose its private scratch root even though the
      // task's persisted outputs live under the run's company root.  A
      // syntactically valid relative path would otherwise open a dead
      // scratch resource and only fail after the tab is created.  Probe the
      // bounded company candidates before handing the path to the session
      // resource store; this keeps viewer opening read-only and avoids a
      // viewer-side workspace rebind.
      if (!remoteMode && context.workspaceRoot && !paths.contains(context.workspaceRoot, resolved.path)) {
        for (const candidate of workspaceRecoveryCandidates(pathText, context.workspaceRoot)) {
          try {
            await readLocalRecoveryFile(candidate)
            assertOpeningContext()
            openExternalWorkPathResource(candidate, context.sessionId)
            return
          } catch { /* keep the authenticated session target as fallback */ }
        }
      }
      openWorkFileResource(resolved.path, resolved.target)
      return
    }
    await openFile(resolved.path, match ? Number(match[1]) : undefined, match?.[2] ? Number(match[2]) : undefined, undefined, resolved.target)
    assertOpeningContext()
    activateLoadedFile(resolved.path, source)
    return
  }
  if (remoteMode) {
    const remote = await remoteWorkspaceContext()
    assertOpeningContext()
    if (context?.sessionId && context.sessionId !== remote.sessionId) throw new Error('会话已经切换，请返回文件所属会话后重试。')
    const match = /:(\d+)(?::(\d+))?$/.exec(rawPath.trim())
    const pathText = (match ? rawPath.trim().slice(0, match.index) : rawPath).trim().replace(/^[`'"<]+|[`'">]+$/g, '')
    if (!pathText) return
    const absolute = /^(?:[/\\]|[A-Za-z]:)/.test(pathText)
    const filePath = absolute ? pathText.replace(/\\/g, '/') : `${remote.root}/${pathText}`
    remoteWorkspaceRelativePath(remote, filePath)
    await openFile(filePath, match ? Number(match[1]) : undefined, match?.[2] ? Number(match[2]) : undefined)
    assertWorkspaceTarget(remote.target)
    assertOpeningContext()
    activateLoadedFile(filePath, source)
    return
  }
  const target = resolveChatPath(rawPath, context ? context.workspaceRoot ?? null : getWorkspaceState().root)
  if (!target) return
  await openFile(target.filePath, target.line, target.column)
  assertOpeningContext()
  activateLoadedFile(target.filePath, source)
}

/** A download URL names a session artifact, not a local path or a navigation URL. */
export async function openArtifactFromChat(target: Extract<ChatLinkTarget, { kind: 'artifact' }>, context: ChatFileContext): Promise<void> {
  if (target.sessionId !== context.sessionId) throw new Error('文件链接不属于当前消息会话。')
  await openFileFromChat(target.path, context)
}
