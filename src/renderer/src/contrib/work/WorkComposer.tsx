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
import type { useWorkController } from './work-runtime'

type WorkController = ReturnType<typeof useWorkController>

export function WorkComposer({ controller, home = false }: { controller: WorkController; home?: boolean }): JSX.Element {
  const filesRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<MentionInputHandle>(null)
  const mentionsRef = useRef<Mention[]>(controller.activeTask?.mentions ?? [])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [resourceQuery, setResourceQuery] = useState<string | null>(null)
  const [polishing, setPolishing] = useState(false)
  const awaitingAnswer = controller.pending.length > 0
  const busy = controller.streaming || controller.uploading || controller.loading || awaitingAnswer
  const draft = controller.draft
  const submit = (): void => {
    if ((!draft.trim() && !controller.attachments.length) || busy || !controller.ready) return
    void (home ? controller.createTask(draft, mentionsRef.current) : controller.send(draft, mentionsRef.current)).catch(reportError)
  }
  useEffect(() => {
    mentionsRef.current = controller.activeTask?.mentions ?? []
    inputRef.current?.setDraft(controller.draft, mentionsRef.current)
  }, [controller.activeTask?.id])
  const polish = async (): Promise<void> => {
    if (!draft.trim() || polishing || !controller.ready) return
    setPolishing(true)
    try {
      const result = await utilityChat({ model: controller.modelId || undefined, systemPrompt: '你是发给 AI 编程助手的指令润色器。把草稿改写得清晰、具体、可执行，保留原语言和 @引用；只输出润色后的文本。', userPrompt: draft, temperature: 0.3, maxTokens: 1500 })
      const polished = result.text.trim()
      if (polished && polished !== draft) {
        const next = preserveMentions(polished, mentionsRef.current)
        mentionsRef.current = next.mentions
        controller.setDraft(next.text, next.mentions)
        inputRef.current?.setDraft(next.text, next.mentions)
        inputRef.current?.focus()
      }
    } catch (error) { reportError(error) } finally { setPolishing(false) }
  }
  const selectResource = (item: ResourceItem): void => { controller.setResource(item.kind, item.id); inputRef.current?.completeSlash(`/${item.kind}:${item.id}`); setResourceQuery(null); inputRef.current?.focus() }
  const selectAgent = (agent: WorkAgent): void => { controller.setAgent(agent.id); inputRef.current?.completeMention({ source: 'agent', displayText: agent.name, path: agent.id }); setMentionQuery(null); inputRef.current?.focus() }
  return <div className={`work-composer-wrap${home ? ' work-composer-wrap--home' : ''}`}>
    {controller.error ? <div className="work-error" role="alert"><Icon name="warning" size={15} /><span>{controller.error}</span><IconButton icon="close" label="关闭错误提示" onClick={controller.clearError} /></div> : null}
    <div className="work-composer" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void controller.addFiles(Array.from(event.dataTransfer.files)).catch(reportError) } }}>
      <MentionInput ref={inputRef} value={draft} disabled={!controller.ready} placeholder={home ? '描述你想完成的工作；@ 引用文件或 Agent，/ 选择技能、MCP、知识库…' : '补充要求；@ 引用文件或 Agent，/ 选择资源…'} onChange={(text, mentions) => { mentionsRef.current = mentions; controller.setDraft(text, mentions) }} onSubmit={submit} onPasteFiles={(files) => { void controller.addFiles(files).catch(reportError) }} onMentionQuery={(query) => { setMentionQuery(query); if (query !== null) setResourceQuery(null) }} onSlashQuery={(query) => { setResourceQuery(query); if (query !== null) setMentionQuery(null) }} />
      {controller.attachments.length ? <div className="work-attachments">{controller.attachments.map((file) => <span key={file.path} className="work-attachment" title={file.path}><Icon name="file" size={14} /><span>{file.name}</span><IconButton icon="close" label={`移除资料 ${file.name}`} size={12} onClick={() => controller.removeAttachment(file.path)} /></span>)}</div> : null}
      {(controller.resources.skills.length + controller.resources.mcpServers.length + controller.resources.knowledgeBases.length) > 0 ? <div className="work-resource-strip">{controller.resources.skills.map((id) => <button key={`skill:${id}`} type="button" className="work-resource-chip" onClick={() => controller.removeResource('skill', id)}>技能 · {id} ×</button>)}{controller.resources.mcpServers.map((id) => <button key={`mcp:${id}`} type="button" className="work-resource-chip" onClick={() => controller.removeResource('mcp', id)}>MCP · {id} ×</button>)}{controller.resources.knowledgeBases.map((id) => <button key={`kb:${id}`} type="button" className="work-resource-chip" onClick={() => controller.removeResource('kb', id)}>知识库 · {id} ×</button>)}</div> : null}
      <div className="work-composer__footer"><div className="work-composer__options">
        <input type="file" multiple ref={filesRef} className="work-file-input" tabIndex={-1} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void controller.addFiles(files).catch(reportError) }} />
        <button type="button" className="work-quiet-button" onClick={() => filesRef.current?.click()} disabled={controller.uploading || controller.streaming}>{controller.uploading ? <Spinner /> : <Icon name="paperclip" size={16} />}<span>添加资料</span></button>
        <button type="button" className="work-quiet-button work-folder-button" onClick={() => void controller.chooseWorkspace().catch(reportError)} disabled={controller.streaming || controller.remote} title={controller.remote ? '远端任务使用独立沙箱' : controller.workspacePath ? controller.workspacePath : '未选择项目，任务会使用独立沙箱；点击可绑定本地项目'}><Icon name="folder-outline" size={16} /><span>{controller.remote ? '远端沙箱' : controller.workspacePath ? controller.workspacePath.split(/[\\/]/).pop() : '独立沙箱'}</span></button>
        <Select className="work-model-select" ariaLabel="Work 使用的模型" title="选择任务模型" placement="up" width={280} value={controller.modelId} onChange={controller.setModel} disabled={controller.streaming || controller.loading || !controller.models.length} options={[{ value: '', label: '默认模型' }, ...controller.models.map((model) => ({ value: model.id, label: model.displayName || model.modelId }))]} />
        <button type="button" className="work-quiet-button work-polish-button" onClick={() => void polish()} disabled={!draft.trim() || polishing || busy} title="AI 润色"><Icon name="sparkles" size={16} /><span>AI 润色</span></button>
        <WorkComposerPreferences sessionId={controller.securitySessionId} onManage={() => openAppSettings('security')} />
      </div><button className="btn btn--primary work-send" type="button" onClick={submit} disabled={busy || !controller.ready || (!draft.trim() && !controller.attachments.length)}>{controller.loading ? <Spinner /> : <Icon name={home ? 'play' : 'send'} size={15} />}<span>{home ? '开始任务' : '发送'}</span></button></div>
      {mentionQuery !== null ? (mentionQuery.trim().toLowerCase().startsWith('agent') || mentionQuery.trim().startsWith('智能体') ? <WorkAgentPicker query={mentionQuery} onSelect={selectAgent} onClose={() => { setMentionQuery(null); inputRef.current?.focus() }} /> : controller.workspacePath ? <FileRefPalette root={controller.workspacePath} keyword={mentionQuery} onSelect={(mention) => { inputRef.current?.completeMention(mention); setMentionQuery(null) }} onClose={() => { setMentionQuery(null); inputRef.current?.focus() }} /> : null) : null}
      {resourceQuery !== null ? <ResourcePicker query={resourceQuery} projectPath={controller.workspacePath ?? undefined} onSelect={selectResource} onClose={() => { setResourceQuery(null); inputRef.current?.focus() }} /> : null}
    </div>
    <div className="work-composer__hint"><span>{!controller.ready ? '引擎尚未就绪，草稿会保留。' : controller.streaming ? '任务正在执行，补充内容暂存为草稿。' : controller.workspacePath ? '已绑定项目 · Ctrl / ⌘ + Enter 发送 · @ 文件 / @agent · / 技能、MCP、知识库' : '独立沙箱已就绪 · 无需先选项目 · Ctrl / ⌘ + Enter 发送 · @agent · / 技能、MCP、知识库'}</span>{!controller.ready ? <button type="button" onClick={() => openAppSettings('general')}>查看引擎设置</button> : null}</div>
  </div>
}
function reportError(error: unknown): void { console.error(error) }
