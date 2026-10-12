import { useEffect, useRef, useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { IconButton, Spinner } from '@renderer/workbench/ui-primitives'
import { Select } from '@renderer/workbench/Select'
import { utilityChat } from '@renderer/core/engine/utility-chat'
import { MentionInput, type Mention, type MentionInputHandle } from '@renderer/contrib/chat/MentionInput'
import { preserveMentions } from '@renderer/contrib/chat/mention-context'
import { FileRefPalette } from '@renderer/contrib/chat/FileRefPalette'
import { ResourcePicker, type ResourceItem } from '@renderer/contrib/chat/ResourcePicker'
import { WorkAgentPicker, type WorkAgent } from './WorkAgentPicker'
import { WorkComposerPreferences } from './WorkComposerPreferences'
import { openAppSettings } from '../settings/app-settings-navigation'
import { useAppMode } from '@renderer/core/platform/app-mode'
import { toast } from '@renderer/core/toast'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { WorkAgentManager } from './WorkAgentManager'
import { CompletionPopover } from '@renderer/workbench/CompletionPopover'
import type { useWorkController } from './work-runtime'
import { flushWorkDrafts, useWorkDraft, type WorkDraft } from './work-state'

type WorkController = ReturnType<typeof useWorkController>

export function WorkComposer({ controller, home = false }: { controller: WorkController; home?: boolean }): JSX.Element {
  const filesRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<MentionInputHandle>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const draftState = useWorkDraft(controller.draftSource, controller.activeTask?.id ?? null)
  const userDraftRef = useRef<WorkDraft | null>(null)
  const mentionsRef = useRef<Mention[]>(draftState.mentions)
  mentionsRef.current = draftState.mentions
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [resourceQuery, setResourceQuery] = useState<string | null>(null)
  const [polishing, setPolishing] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const polishEpoch = useRef(0)
  const appMode = useAppMode()
  const draft = draftState.text
  const draftLiveRef = useRef(draft)
  const taskLiveRef = useRef(controller.activeTask?.id ?? 'home')
  const draftRevisionRef = useRef(0)
  draftLiveRef.current = draft
  taskLiveRef.current = controller.activeTask?.id ?? 'home'
  const awaitingAnswer = controller.pending.length > 0
  const busy = controller.streaming || controller.uploading || controller.loading || awaitingAnswer
  const submit = (): void => {
    if ((!draft.trim() && !controller.attachments.length) || busy || !controller.ready) return
    flushWorkDrafts(controller.draftSource)
    void (home ? controller.createTask(draft, mentionsRef.current) : controller.send(draft, mentionsRef.current)).catch(reportError)
  }
  useEffect(() => {
    mentionsRef.current = controller.mentions
    polishEpoch.current += 1
    setPolishing(false)
    setMentionQuery(null)
    setResourceQuery(null)
    setAgentsOpen(false)
    inputRef.current?.setDraft(controller.draft, mentionsRef.current)
    return () => { polishEpoch.current += 1; flushWorkDrafts(controller.draftSource) }
  }, [controller.activeTask?.id, controller.draftSource, home])
  useEffect(() => {
    // Rebuild chips only for an external edit; rebuilding typed text would reset the caret.
    if (userDraftRef.current?.text === draftState.text && userDraftRef.current.mentions === draftState.mentions) return
    userDraftRef.current = null
    inputRef.current?.setDraft(draftState.text, draftState.mentions)
  }, [draftState])
  useEffect(() => subscribeEngineSource(() => {
    polishEpoch.current += 1
    setPolishing(false)
    setAgentsOpen(false)
    setMentionQuery(null)
    setResourceQuery(null)
  }), [])
  useEffect(() => {
    if (appMode === 'work') return
    flushWorkDrafts(controller.draftSource)
    setMentionQuery(null)
    setResourceQuery(null)
    setAgentsOpen(false)
  }, [appMode, controller.draftSource])
  const polish = async (): Promise<void> => {
    if (!draft.trim() || polishing || !controller.ready) return
    const requestEpoch = ++polishEpoch.current
    const requestSource = getEngineSource()
    const requestTaskId = taskLiveRef.current
    const requestDraft = draft
    const requestRevision = draftRevisionRef.current
    setPolishing(true)
    try {
      const result = await utilityChat({ model: controller.utilityModel || controller.modelId || undefined, systemPrompt: '你是发给 AI 编程助手的指令润色器。把草稿改写得清晰、具体、可执行，保留原语言和 @引用；只输出润色后的文本。', userPrompt: requestDraft, temperature: 0.3, maxTokens: 1500 })
      if (requestSource !== getEngineSource() || requestEpoch !== polishEpoch.current || taskLiveRef.current !== requestTaskId || draftLiveRef.current !== requestDraft || draftRevisionRef.current !== requestRevision) return
      const polished = result.text.trim()
      if (polished && polished !== requestDraft) {
        const next = preserveMentions(polished, mentionsRef.current)
        mentionsRef.current = next.mentions
        controller.setDraft(next.text, next.mentions)
        inputRef.current?.setDraft(next.text, next.mentions)
        inputRef.current?.focus()
        toast.success('已润色输入内容')
      } else toast.info('润色结果与原文一致')
    } catch (error) {
      if (requestSource === getEngineSource() && requestEpoch === polishEpoch.current) toast.error(`AI 润色失败：${error instanceof Error ? error.message : '请稍后重试'}`)
    } finally { if (requestEpoch === polishEpoch.current) setPolishing(false) }
  }
  const selectResource = (item: ResourceItem): void => { controller.setResource(item.kind, item.id); inputRef.current?.completeSlash(`/${item.kind}:${item.id}`); setResourceQuery(null); inputRef.current?.focus() }
  const selectAgent = (agent: WorkAgent): void => {
    inputRef.current?.completeMention({ source: 'agent', displayText: agent.name, path: agent.id })
    setMentionQuery(null); inputRef.current?.focus()
  }
  return <div className={`work-composer-wrap${home ? ' work-composer-wrap--home' : ''}`} onBlurCapture={() => flushWorkDrafts(controller.draftSource)}>
    {controller.error ? <div className="work-error" role="alert"><Icon name="warning" size={15} /><span>{controller.error}</span>{controller.activeTask ? <button type="button" className="work-quiet-button" disabled={controller.streaming || controller.loading} onClick={() => void controller.retryHistory()}>重新加载</button> : <IconButton icon="close" label="关闭错误提示" onClick={controller.clearError} />}</div> : null}
    <div ref={composerRef} className="work-composer" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void controller.addFiles(Array.from(event.dataTransfer.files)).catch(reportError) } }}>
      <MentionInput ref={inputRef} value={draft} ariaLabel={home ? '任务目标' : '继续对话'} baseClassName="work-chat__input" includeMentionClass={false} disabled={false} placeholder={home ? '描述你想完成的工作；@ 引用文件或 Agent，/ 选择技能、MCP、知识库…' : '补充要求；@ 引用文件或 Agent，/ 选择资源…'} onChange={(text, mentions) => { draftRevisionRef.current += 1; draftLiveRef.current = text; mentionsRef.current = mentions; userDraftRef.current = { text, mentions }; controller.setDraft(text, mentions) }} onSubmit={submit} onPasteFiles={(files) => { void controller.addFiles(files).catch(reportError) }} onMentionQuery={(query) => { setMentionQuery(query); if (query !== null) setResourceQuery(null) }} onSlashQuery={(query) => { setResourceQuery(query); if (query !== null) setMentionQuery(null) }} />
      {controller.attachments.length ? <div className="work-attachments">{controller.attachments.map((file) => <span key={file.path} className="work-attachment" title={file.path}><Icon name="file" size={14} /><span>{file.name}</span><IconButton icon="close" label={`移除资料 ${file.name}`} size={12} onClick={() => controller.removeAttachment(file.path)} /></span>)}</div> : null}
      {(controller.resources.skills.length + controller.resources.mcpServers.length + controller.resources.knowledgeBases.length) > 0 ? <div className="work-resource-strip">{controller.resources.skills.map((id) => <button key={`skill:${id}`} type="button" className="work-resource-chip" onClick={() => controller.removeResource('skill', id)}>技能 · {id} ×</button>)}{controller.resources.mcpServers.map((id) => <button key={`mcp:${id}`} type="button" className="work-resource-chip" onClick={() => controller.removeResource('mcp', id)}>MCP · {id} ×</button>)}{controller.resources.knowledgeBases.map((id) => <button key={`kb:${id}`} type="button" className="work-resource-chip" onClick={() => controller.removeResource('kb', id)}>知识库 · {id} ×</button>)}</div> : null}
      <div className="work-composer__footer"><div className="work-composer__options">
        {appMode === 'work' ? <><input type="file" multiple ref={filesRef} className="work-file-input" tabIndex={-1} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void controller.addFiles(files).catch(reportError) }} /><button type="button" className="work-quiet-button work-attach-button" aria-label="添加资料" title="添加资料" onClick={() => filesRef.current?.click()} disabled={controller.uploading || controller.streaming}>{controller.uploading ? <Spinner /> : <Icon name="paperclip" size={16} />}</button></> : null}
        {!controller.workspaceLocked ? <button type="button" className="work-quiet-button work-folder-button" onClick={() => void controller.chooseWorkspace().catch(reportError)} disabled={controller.streaming || controller.uploading} title={controller.workspacePath ? controller.workspacePath : '未选择项目，任务会使用独立沙箱；点击可绑定本地项目'}><Icon name="folder-outline" size={16} /><span>{controller.workspacePath ? controller.workspacePath.split(/[\\/]/).pop() : '独立沙箱'}</span></button> : null}        <button type="button" className="work-quiet-button work-polish-button" onClick={() => void polish()} disabled={!draft.trim() || polishing || busy} title="AI 润色"><Icon name="sparkles" size={16} /><span>AI 润色</span></button>
        {!controller.agentLocked ? <button type="button" className="work-quiet-button work-agent-button" aria-label="管理与选择 Agent" onClick={() => setAgentsOpen(true)} disabled={!controller.ready} title="选择或创建自定义 Agent"><Icon name="account-outline" size={16} /><span>{controller.agentId ? controller.agentIdentity.name || (controller.agentIdentity.loading ? '读取 Agent…' : '查看 Agent') : 'Agent'}</span></button> : null}
        <WorkComposerPreferences sessionId={controller.securitySessionId} modelId={controller.modelId} thinkingMode={controller.thinkingMode} onThinkingChange={controller.setThinkingMode} />
      </div><div className="work-composer__actions"><Select className="work-model-select" ariaLabel="Work 使用的模型" title="选择任务模型" placement="up" width={280} value={controller.modelId} onChange={controller.setModel} disabled={controller.streaming || controller.loading || ['running', 'waiting'].includes(controller.activeTask?.status ?? '') || !controller.models.length} options={[{ value: '', label: '默认模型' }, ...controller.models.map((model) => ({ value: model.id, label: model.displayName || model.modelId }))]} /><button className="btn btn--primary work-send" type="button" onClick={submit} disabled={busy || !controller.ready || (!draft.trim() && !controller.attachments.length)}>{controller.loading ? <Spinner /> : <Icon name={home ? 'play' : 'send'} size={15} />}<span>{home ? '开始任务' : '发送'}</span></button></div></div>
      {mentionQuery !== null && appMode === 'work' ? <CompletionPopover anchorRef={composerRef} className="work-completion-popover" onClose={() => setMentionQuery(null)}>{mentionQuery.trim().toLowerCase().startsWith('agent') || mentionQuery.trim().startsWith('智能体') || !controller.workspacePath ? <WorkAgentPicker query={controller.workspacePath ? mentionQuery : `agent ${mentionQuery}`} onSelect={selectAgent} onClose={() => { setMentionQuery(null); inputRef.current?.focus() }} /> : <FileRefPalette root={controller.workspacePath} keyword={mentionQuery} onSelect={(mention) => { inputRef.current?.completeMention(mention); setMentionQuery(null) }} onClose={() => { setMentionQuery(null); inputRef.current?.focus() }} />}</CompletionPopover> : null}
      {resourceQuery !== null && appMode === 'work' ? <CompletionPopover anchorRef={composerRef} className="work-completion-popover" onClose={() => setResourceQuery(null)}><ResourcePicker query={resourceQuery} projectPath={controller.workspacePath ?? undefined} onSelect={selectResource} onClose={() => { setResourceQuery(null); inputRef.current?.focus() }} /></CompletionPopover> : null}
    </div>
    {agentsOpen ? <WorkAgentManager workspacePath={controller.workspacePath} selectedId={controller.agentId} locked={controller.agentLocked} onSelect={(agent) => { if (controller.setAgent(agent?.id ?? '')) setAgentsOpen(false) }} onClose={() => setAgentsOpen(false)} /> : null}
    <div className="work-composer__hint"><span>{!controller.ready ? '引擎尚未就绪，草稿会保留。' : controller.streaming ? '任务正在执行，补充内容暂存为草稿。' : controller.workspacePath ? '已绑定项目 · Enter 发送 · Shift + Enter 换行 · @ 文件 / @agent · / 技能、MCP、知识库' : '独立沙箱已就绪 · 无需先选项目 · Enter 发送 · Shift + Enter 换行 · @agent · / 技能、MCP、知识库'}</span>{!controller.ready ? <button type="button" onClick={() => openAppSettings('general')}>查看引擎设置</button> : null}</div>
  </div>
}
function reportError(error: unknown): void { console.error(error) }
