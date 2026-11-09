import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { getEngineSource } from '@renderer/core/engine/source'
import { TextPreview } from '@renderer/core/editor/TextPreview'
import { DocumentMenuProvider } from '@renderer/core/editor/useDocumentContextMenu'
import { Dialog } from '@renderer/workbench/Dialog'
import { requestOrThrow } from '@renderer/core/engine/client'
import { BUILTIN_AGENTS, parseBuiltinAgentReference } from '@shared/builtin-agents'
import type { AgentReferenceIdentity } from '../chat/agent-references'
import type { Mention } from '../chat/mention-context'
import type { ChatFileContext } from '../chat/chat-link'
import { FileGlyph } from '../explorer/FileGlyph'
import { WorkSourcePreview } from './WorkSourcePreview'
import { workChangePathKey } from './work-file-changes'
import type { useWorkController } from './work-runtime'

interface SourceSelection {
  sessionId: string
  source: ChatAttachment
  revision: number
}
interface ReferenceNavigation {
  openMention: (mention: Mention, context?: ChatFileContext, receipt?: ChatAttachment) => void
  openSources: () => void
  sourceSelection: SourceSelection | null
}
const NavigationContext = createContext<ReferenceNavigation | null>(null)
export const useWorkReferenceNavigation = (): ReferenceNavigation | null => useContext(NavigationContext)

/** Keep original snapshots and session-owned files distinct from live workspace files. */
export function WorkReferenceProvider({ controller, onSources, onWorkspaceFile, onArtifact, onBrowser, onAgent, onConversation, children }: {
  controller: ReturnType<typeof useWorkController>
  onSources: () => void
  onWorkspaceFile: (path: string) => void
  onArtifact: (id: string) => void
  onBrowser: (tabId: string) => void
  onAgent: () => void
  onConversation: (url: string) => void
  children: ReactNode
}): JSX.Element {
  const scope = JSON.stringify([getEngineSource(), controller.activeTask?.id ?? null, controller.securitySessionId])
  const dialogRevision = useRef(0)
  const [library, setLibrary] = useState<{ scope: string; revision: number } | null>(null)
  const [selection, setSelection] = useState<{ scope: string; value: SourceSelection } | null>(null)
  const [preview, setPreview] = useState<{ scope: string; revision: number; mention: Mention; source: ChatAttachment; root: string | null; context?: ChatFileContext } | null>(null)
  const openMention = useCallback((mention: Mention, context?: ChatFileContext, receipt?: ChatAttachment): void => {
    if (mention.source === 'conversation') { onConversation(mention.path ?? ''); return }
    const sessionId = context?.sessionId ?? controller.securitySessionId ?? undefined
    const root = context ? context.workspaceRoot ?? null : controller.workspacePath ?? null
    const currentTask = Boolean(controller.activeTask && sessionId === controller.activeTask.id)
    const path = mention.path ?? ''
    const samePath = (file: { path: string }): boolean => workChangePathKey(file.path, root) === workChangePathKey(path, root)
    const knownSource = sessionId === controller.securitySessionId ? [...controller.sources, ...controller.attachments].find(samePath) : undefined
    const source: ChatAttachment = receipt ?? knownSource ?? { path, name: mention.displayText, type: 'text/plain', size: 0 }
    const showOriginal = (): void => setPreview({ scope, revision: ++dialogRevision.current, mention, source, root, context: sessionId ? { sessionId, workspaceRoot: root } : undefined })

    // A snapshot must continue to show what was sent even after its original tab changes.
    if (mention.content !== undefined) { showOriginal(); return }
    if (mention.source === 'agent') { showOriginal(); return }
    if (mention.source === 'browser') { onBrowser(path); return }
    if (currentTask && knownSource && (!mention.origin || mention.origin === 'attachment')) {
      setSelection(previous => ({ scope, value: { sessionId: sessionId!, source, revision: (previous?.value.revision ?? 0) + 1 } }))
      onSources()
      return
    }
    if (mention.origin === 'attachment') { showOriginal(); return }
    if (currentTask && path) {
      const artifact = mention.origin === 'artifact' ? controller.artifacts.find(samePath) : undefined
      if (artifact) onArtifact(artifact.id)
      else onWorkspaceFile(path)
      return
    }
    // Home drafts and child transcripts have their own file ownership; do not open the parent's workspace.
    showOriginal()
  }, [controller, scope, onSources, onWorkspaceFile, onArtifact, onBrowser, onConversation])
  const openSources = useCallback((): void => {
    if (controller.activeTask) onSources()
    else setLibrary({ scope, revision: ++dialogRevision.current })
  }, [controller.activeTask, onSources, scope])
  const value = useMemo(() => ({ openMention, openSources, sourceSelection: selection?.scope === scope ? selection.value : null }), [openMention, openSources, selection, scope])
  const visiblePreview = preview?.scope === scope ? preview : null
  return <NavigationContext.Provider value={value}>
    {children}
    {library?.scope === scope ? <Dialog key={library.revision} title="任务资料" width={640} onClose={() => setLibrary(current => current === library ? null : current)}>
      <div className="work-reference-library">
        {controller.sources.map(file => <div key={file.path} className="work-reference-library__row">
          <button type="button" className="work-quiet-button" onClick={() => openMention({ source: 'file', origin: 'attachment', path: file.path, displayText: file.name }, undefined, file)}><FileGlyph name={file.name} size={16} />{file.name}</button>
          <button type="button" className="work-quiet-button" onClick={() => { controller.addSourceReference(file); setLibrary(null) }}>添加到对话</button>
          <button type="button" className="work-quiet-button" aria-label={`移除资料 ${file.name}`} onClick={() => controller.removeSource(file.path)}>移除</button>
        </div>)}
        {!controller.sources.length ? <p>还没有添加资料</p> : null}
      </div>
    </Dialog> : null}
    {visiblePreview ? <Dialog key={visiblePreview.revision} title={visiblePreview.mention.displayText}
      width={860} className="work-reference-preview" onClose={() => setPreview(current => current === visiblePreview ? null : current)}
      footer={visiblePreview.mention.source === 'browser' ? <button type="button" className="work-quiet-button" onClick={() => { onBrowser(visiblePreview.mention.path ?? ''); setPreview(null) }}>打开浏览器</button>
        : visiblePreview.mention.source === 'agent' ? <button type="button" className="work-quiet-button" onClick={() => { onAgent(); setPreview(null) }}>管理 Agent</button> : undefined}>
      <div className="work-reference-preview__body">
        {visiblePreview.mention.content !== undefined
          ? visiblePreview.mention.source === 'file' || visiblePreview.mention.source === 'code'
            ? <DocumentMenuProvider value={{ identity: JSON.stringify([visiblePreview.scope, visiblePreview.revision]),
              path: visiblePreview.mention.path, root: visiblePreview.root }}>
              <TextPreview content={visiblePreview.mention.content} name={visiblePreview.mention.displayText} />
            </DocumentMenuProvider>
            : <TextPreview content={visiblePreview.mention.content} name={visiblePreview.mention.displayText} />
          : visiblePreview.mention.source === 'agent' ? <AgentReferencePreview id={visiblePreview.mention.path ?? ''} />
          : <WorkSourcePreview source={visiblePreview.source} root={visiblePreview.context?.workspaceRoot ?? null} sessionId={visiblePreview.context?.sessionId} />}
      </div>
    </Dialog> : null}
  </NavigationContext.Provider>
}

function AgentReferencePreview({ id }: { id: string }): JSX.Element {
  const builtin = BUILTIN_AGENTS.find(item => item.role === parseBuiltinAgentReference(id)?.builtinRole)
  const [agent, setAgent] = useState<AgentReferenceIdentity | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (builtin) return
    let current = true
    const source = getEngineSource()
    setAgent(null); setError('')
    void requestOrThrow<AgentReferenceIdentity[] | { list?: AgentReferenceIdentity[] }>({ method: 'GET', path: '/agents' }).then(result => {
      if (!current || source !== getEngineSource()) return
      const match = (Array.isArray(result) ? result : result.list ?? []).find(item => item.id === id)
      if (match) setAgent(match)
      else setError('此 Agent 已不存在，历史引用仍保留。')
    }).catch(reason => { if (current && source === getEngineSource()) setError(reason instanceof Error ? reason.message : '无法读取 Agent') })
    return () => { current = false }
  }, [id, builtin])
  if (error) return <p role="alert">{error}</p>
  if (builtin) return <p>{builtin.description}</p>
  if (!agent) return <p role="status">正在读取 Agent…</p>
  return <div className="work-reference-agent"><p>{agent.description || agent.name}</p>
    {agent.model ? <p>模型：{agent.model}</p> : null}
    {agent.systemPrompt ? <TextPreview content={agent.systemPrompt} name="Agent 指令.txt" /> : null}
  </div>
}
