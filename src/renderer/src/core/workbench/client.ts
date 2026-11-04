import { useEffect, useRef } from 'react'
import { request } from '../engine/client'
import { getEngineSource, getExpectedEngine, getEngineStorageKey } from '../engine/source'
import { getAppMode, onAppModeChanged, type AppMode } from '../platform/app-mode'
import { documentKey, getEditorState, getDocument, getDocumentIdentity, isDirty, isDocumentConnectionCurrent, onEditorChanged, openFile, type OpenDocument } from '../editor/editor-store'
import { activateGroupTab, getEditorGroups } from '../editor/editor-groups'
import { captureSessionFileTarget, type SessionFileTarget } from '../workspace/fs-client'
import { getTerminalState, getSessionStatus } from '../../contrib/terminal/terminal-store'
import { PREVIEW_FORMATS, WORKBENCH_ACTIONS, setWorkbenchConnected } from './capabilities'
import { deferredWorkPreview, isWorkbenchOwnerCurrent } from './connection-scope'

export interface WorkbenchCommand {
  requestId: string; sessionId: string; action: typeof WORKBENCH_ACTIONS[number]; args: { path?: string; line?: number; terminalId?: string; maxLines?: number }
  execution: { rootSessionId: string; rootRunId: string; ownerRunId: string }; expiresAt: number
}
export interface WorkbenchAdapter {
  context(): Record<string, unknown> | Promise<Record<string, unknown>>
  open(path: string, line: number | undefined, current: () => boolean): Promise<Record<string, unknown>>
}
interface Registration { clientId: string; clientToken: string }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** User PTYs have their own owner; a model cannot read another session's terminal. */
export function sessionTerminals(sessionId: string) {
  const source = getEngineStorageKey()
  return getTerminalState().sessions.filter(item => item.source === source && item.sessionId === sessionId)
}
export function terminalSnapshot(sessionId: string, terminalId?: string, maxLines = 80): Record<string, unknown> {
  const sessions = sessionTerminals(sessionId)
  if (!terminalId) return { terminals: sessions.slice(0, 100).map(item => ({ id: item.id, title: item.title, cwd: item.cwd, status: getSessionStatus(item.id) })), hasMoreTerminals: sessions.length > 100,
    commandExecution: 'execute_cmd / command_output / cancel_command 管理 AI 命令任务；这里是所属会话的用户终端，只读。' }
  const session = sessions.find(item => item.id === terminalId)
  if (!session) throw new Error('终端不存在或不属于当前会话。请先查询工作台终端列表。')
  const buffer = session.term.buffer.active
  const count = Math.max(1, Math.min(200, maxLines))
  const start = Math.max(0, buffer.length - count)
  const lines: string[] = []
  for (let i = start; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  const output = lines.join('\n')
  return { terminalId, title: session.title, status: getSessionStatus(terminalId), output: output.slice(-24000), truncated: start > 0 || output.length > 24000 }
}

function insideSessionRoot(path: string, root: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  let candidate = normalize(path), base = normalize(root)
  if (/^(?:[A-Za-z]:|\/\/)/.test(base)) { candidate = candidate.toLowerCase(); base = base.toLowerCase() }
  if (candidate.split('/').some(part => part === '.' || part === '..')) return false
  return candidate.startsWith(base + '/')
}

function belongsToCodeSession(doc: OpenDocument, target: SessionFileTarget): boolean {
  return isDocumentConnectionCurrent(doc) && insideSessionRoot(doc.path, target.root)
    && (!doc.sessionFileTarget || doc.sessionFileTarget.key === target.key)
}

/** Existing loading buffers do not make openFile await their original read. */
function waitForCodeDocument(path: string, instance: number | undefined, target: SessionFileTarget, current: () => boolean): Promise<OpenDocument> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (doc?: OpenDocument, error?: Error) => {
      if (settled) return
      settled = true; unsubscribe(); clearInterval(interval); clearTimeout(timer)
      if (error) reject(error); else resolve(doc!)
    }
    const check = () => {
      if (!current()) return finish(undefined, new Error('会话或引擎已切换，文件未确认打开。'))
      const doc = getDocument(path)
      if (!doc || instance === undefined || getDocumentIdentity(path)?.instance !== instance)
        return finish(undefined, new Error('文件已关闭或重新打开，请重新读取工作台状态。'))
      if (!belongsToCodeSession(doc, target)) return finish(undefined, new Error('文件已不属于当前任务工作区。'))
      if (doc.error) return finish(undefined, new Error(doc.error))
      if (!doc.loading) finish(doc)
    }
    const unsubscribe = onEditorChanged(check)
    const interval = setInterval(check, 50)
    const timer = setTimeout(() => finish(undefined, new Error('文件读取未及时完成，请查询工作台状态。')), 10_000)
    check()
  })
}

export function codeWorkbenchAdapter(sessionId: string): WorkbenchAdapter {
  return {
    async context() {
      const target = await captureSessionFileTarget(sessionId)
      const state = getEditorState()
      const docs = [...state.docs.values()].filter(item => belongsToCodeSession(item, target))
      return { mode: 'code', workspaceRoot: target.root, activePath: docs.some(item => item.path === state.activePath) ? state.activePath : null,
        files: docs.slice(0, 100).map(item => ({ path: item.path, name: item.name, loading: item.loading, error: item.error, dirty: isDirty(item) })), hasMoreFiles: docs.length > 100 }
    },
    async open(path, line, current) {
      const target = await captureSessionFileTarget(sessionId)
      if (!current()) throw new Error('会话或引擎已切换，文件未打开。')
      if (!insideSessionRoot(path, target.root)) throw new Error('文件不属于当前任务工作区。')
      const existing = getDocument(path)
      if (existing && !belongsToCodeSession(existing, target)) throw new Error('此文件由其他工作区会话打开，请先核对当前工作区。')
      // Keep the buffer's owner, especially for ordinary Code tabs with unsaved edits.
      const opening = openFile(path, line, undefined, undefined, existing ? existing.sessionFileTarget : target)
      const instance = getDocumentIdentity(path)?.instance
      await opening
      const doc = await waitForCodeDocument(path, instance, target, current)
      if (!current()) throw new Error('会话或引擎已切换，请重新读取工作台状态。')
      activateGroupTab(getEditorGroups().focusedGroupId, documentKey(doc.path))
      if (getEditorState().activePath !== doc.path) throw new Error('文件尚未激活，请重新读取工作台状态。')
      const foreground = getAppMode() === 'code'
      return { path: doc.path, opened: true, foreground, dirty: isDirty(doc), contentSource: 'editor-buffer', readStatus: doc.tooLarge ? 'too-large' : doc.truncated ? 'partial' : 'ready', renderStatus: foreground ? 'preview-requested' : 'deferred-until-visible', visualVerification: false }
    }
  }
}

/** Readiness acknowledges the actual selected preview, not just a setState call. */
export function waitForWorkPreview(sessionId: string, path: string, current: () => boolean, revision?: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value?: Record<string, unknown>, error?: Error) => {
      if (settled) return
      settled = true; observer.disconnect(); unsubscribeMode(); clearTimeout(timer)
      if (error) reject(error); else resolve(value!)
    }
    const check = () => {
      if (!current()) return finish(undefined, new Error('会话或引擎已切换，请重新查询工作台。'))
      // Hidden Work panes intentionally suspend document reads. Keep the
      // requested selection without stealing focus or claiming it was rendered.
      if (getAppMode() !== 'work') return finish(deferredWorkPreview(path))
      const panel = [...document.querySelectorAll<HTMLElement>('[data-document-path][data-file-read-status]')]
        .find(item => item.dataset.documentSession === sessionId && item.dataset.documentPath === path && item.getClientRects().length > 0 && item.dataset.documentActive !== 'false'
          && (revision === undefined || item.dataset.workbenchRequest === String(revision)))
      if (!panel || panel.dataset.fileReadStatus === 'loading') return
      const readStatus = panel.dataset.fileReadStatus
      if (readStatus === 'unavailable' || readStatus === 'receipt') return finish(undefined, new Error('已打开预览位置，但无法读取当前文件。请检查文件路径或文件是否已变化。'))
      finish({ path, opened: true, foreground: true, readStatus, renderStatus: 'preview-requested', visualVerification: false })
    }
    const observer = new MutationObserver(check)
    const unsubscribeMode = onAppModeChanged(check)
    const timer = setTimeout(() => finish(undefined, new Error('预览未及时确认。请查询工作台状态，不要把请求发出当作内容已显示。')), 10_000)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-file-read-status', 'data-document-path', 'data-document-active', 'data-workbench-request', 'style', 'class'] })
    check()
  })
}

/** Each mounted mode retains its own session bridge while the other mode is visible. */
export function useWorkbenchClient(sessionId: string | null, enabled: boolean, mode: AppMode, adapter: WorkbenchAdapter): void {
  const source = getEngineSource()
  const latest = useRef({ adapter, sessionId, source, mode, enabled })
  latest.current = { adapter, sessionId, source, mode, enabled }
  useEffect(() => {
    if (!enabled || !sessionId) return
    const expectedEngine = getExpectedEngine()
    let disposed = false
    let registration: Registration | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const owner = crypto.randomUUID()
    let retryDelay = 3000
    let unsupported = false
    const current = () => isWorkbenchOwnerCurrent({ source, sessionId, mode, enabled }, latest.current, getEngineSource(), disposed)
    const send = async <T,>(path: string, body: unknown): Promise<T> => {
      const result = await request<T>({ method: 'POST', path, body, expectedEngine, toolProfile: mode === 'work' ? 'general' : 'code' })
      if (!result.ok) {
        if (path === '/workbench/clients' && (result.code === 404 || result.code === 40400)) unsupported = true
        throw new Error(result.message || '工作台连接失败。')
      }
      return result.data as T
    }
    const disconnect = async (client: Registration) => {
      await send(`/workbench/clients/${client.clientId}/disconnect`, { clientToken: client.clientToken }).catch(() => {})
    }
    const run = async () => {
      try {
        const client = await send<Registration>('/workbench/clients', { sessionId, actions: WORKBENCH_ACTIONS })
        if (!client || typeof client.clientId !== 'string' || typeof client.clientToken !== 'string') throw new Error('工作台连接响应无效。')
        if (!current()) { await disconnect(client); return }
        registration = client; retryDelay = 3000; setWorkbenchConnected(source, sessionId, owner, true)
        while (current()) {
          const batch = await send<{ commands: WorkbenchCommand[] }>(`/workbench/clients/${client.clientId}/poll`, { clientToken: client.clientToken })
          if (!Array.isArray(batch?.commands)) throw new Error('工作台操作响应无效。')
          for (const command of batch.commands) {
            if (!current()) break
            const prefix = `/workbench/clients/${client.clientId}`
            const envelope = { clientToken: client.clientToken, requestId: command.requestId, execution: command.execution }
            const commandCurrent = () => current() && command.expiresAt > Date.now()
            const state = await send<{ active: boolean }>(`${prefix}/state`, envelope)
            if (!commandCurrent() || !state.active || command.sessionId !== sessionId || command.execution.rootSessionId !== sessionId) continue
            let result: { success: boolean; output: string; metadata: { code: string; operationPerformed: boolean | 'unknown' } }
            try {
              const data = command.action === 'workspace.context'
                ? { ...await latest.current.adapter.context(), foreground: mode === getAppMode(), ...terminalSnapshot(sessionId), previewFormats: PREVIEW_FORMATS, actions: WORKBENCH_ACTIONS }
                : command.action === 'terminal.read'
                  ? terminalSnapshot(sessionId, command.args.terminalId, command.args.maxLines)
                  : command.action === 'artifact.open' && typeof command.args.path === 'string'
                    ? await latest.current.adapter.open(command.args.path, command.args.line, commandCurrent)
                    : (() => { throw new Error('工作台不支持此操作。') })()
              const output = JSON.stringify(data)
              if (output.length > 64000) throw new Error('工作台状态超过单次返回范围，请缩小查询范围。')
              result = { success: true, output, metadata: { code: 'WORKBENCH_COMPLETED', operationPerformed: true } }
            } catch (error) {
              result = { success: false, output: message(error), metadata: { code: 'WORKBENCH_OPERATION_FAILED', operationPerformed: command.action === 'artifact.open' ? 'unknown' : false } }
            }
            if (commandCurrent()) await send(`${prefix}/results`, { ...envelope, result })
          }
        }
      } catch { /* Older engines do not expose this optional bridge; retry without blocking chat. */ }
      finally {
        setWorkbenchConnected(source, sessionId, owner, false)
        const previous = registration; registration = undefined
        if (previous) await disconnect(previous)
        if (current() && !unsupported) {
          retry = setTimeout(() => { void run() }, retryDelay)
          retryDelay = Math.min(retryDelay * 2, 30000)
        }
      }
    }
    void run()
    return () => {
      disposed = true; clearTimeout(retry); setWorkbenchConnected(source, sessionId, owner, false)
      if (registration) void disconnect(registration)
    }
  }, [sessionId, enabled, source, mode])
}
