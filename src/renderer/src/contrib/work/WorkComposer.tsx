import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { IconButton, Spinner } from '@renderer/workbench/ui-primitives'
import { utilityChat } from '@renderer/core/engine/utility-chat'
import { type Mention, type MentionInputHandle } from '@renderer/contrib/chat/MentionInput'
import {
  InputComposer,
  ComposerInput,
  ComposerPolish,
  ComposerToolbar,
  ComposerSend
} from '@renderer/contrib/chat/InputComposer'
import { ContextUsageIndicator } from '@renderer/contrib/chat/ContextUsageIndicator'
import {
  contextPresentation,
  contextPresentationLimit
} from '@renderer/contrib/chat/context-presentation'
import { DEFAULT_CONTEXT_WINDOW_BUDGET } from '@renderer/core/engine/models'
import { ModelPicker } from '@renderer/contrib/models/ModelPicker'
import { preserveMentions, userMessageDraft } from '@renderer/contrib/chat/mention-context'
import { RootFollowupDelivery, RootFollowupFeedback, useRootFollowup } from '@renderer/contrib/chat/RootFollowup'
import { rootFollowupCanSubmit, rootFollowupLimitation, rootFollowupMessage, rootFollowupRun } from '@renderer/contrib/chat/root-followup'
import { MentionRefPicker } from '@renderer/contrib/chat/MentionRefPicker'
import { ResourcePicker, type ResourceItem } from '@renderer/contrib/chat/ResourcePicker'
import { WorkComposerPreferences } from './WorkComposerPreferences'
import { WorkComposerWorkspace } from './WorkComposerWorkspace'
import { openAppSettings } from '../settings/app-settings-navigation'
import { useAppMode } from '@renderer/core/platform/app-mode'
import { toast } from '@renderer/core/toast'
import { getEngineSource, isRemoteEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { WorkAgentManager } from './WorkAgentManager'
import { CompletionPopover } from '@renderer/workbench/CompletionPopover'
import type { useWorkController } from './work-runtime'
import { flushWorkDrafts, getWorkDraft, useWorkDraft, type WorkDraft } from './work-state'
import {
  AttachmentPreviewDialog,
  type AttachmentPreview
} from '../chat/AttachmentChip'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { shouldAttachPastedText } from '../chat/useAttachments'
import { useWorkReferenceNavigation } from './WorkReferenceNavigation'
import { parseConversationLink } from '@shared/conversation-link'
import { resolveConversationReference } from './work-conversation-reference'
import { useImageConversation } from '../chat/image-conversation'
import { ipcErrorMessage } from '@renderer/core/ipc-error'
import { AttachmentStrip } from '../chat/AttachmentStrip'
import { attachmentIdentity, attachmentMention, attachmentReferences, referencesAttachment } from '../chat/attachment-references'
import { mergeWorkAttachments } from './work-attachments'
import { sameToolkits, toolkitName } from '@shared/toolkits'
import { appendWorkMentions } from './work-reference-draft'
import { draftToolkitIds } from './work-toolkit-mentions'
import { draftResourceBindings, hasNonResourceContent, resourceMention, sameResourceBindings } from '../chat/resource-mentions'
import { useResourceMentions } from '../chat/useResourceMentions'
import { workResourceFollowupChanges, workResourceSelection } from './work-resource-selection'

type WorkController = ReturnType<typeof useWorkController>

export function WorkComposer({
  controller,
  home = false,
  onPreserveReading
}: {
  controller: WorkController
  home?: boolean
  onPreserveReading?: () => void
}): JSX.Element {
  const filesRef = useRef<HTMLInputElement>(null)
  const addingFilesRef = useRef(false)
  const [resolvingReference, setResolvingReference] = useState(false)
  const inputRef = useRef<MentionInputHandle>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const references = useWorkReferenceNavigation()
  const imageConversation = useImageConversation()
  const draftState = useWorkDraft(controller.draftSource, controller.activeTask?.id ?? null)
  const userDraftRef = useRef<WorkDraft | null>(null)
  const restoredToolkitDraftScopes = useRef(new Set<string>())
  const mentionsRef = useRef<Mention[]>(draftState.mentions)
  const [mentionRevision, refreshMentionLabels] = useState(0)
  mentionsRef.current = draftState.mentions
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [resourceQuery, setResourceQuery] = useState<string | null>(null)
  const [polishing, setPolishing] = useState(false)
  const [sendingDraft, setSendingDraft] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const previewScope = JSON.stringify([getEngineSource(), controller.activeTask?.id ?? 'home', controller.workspacePath])
  // Pending local uploads are written directly into the selected project;
  // the home session remains unbound until send. Match that write location
  // without rebinding a session merely to preview a draft attachment.
  const attachmentPreviewSessionId = !isRemoteEngine() && controller.workspacePath
    ? undefined : controller.securitySessionId ?? undefined
  const [previewState, setPreview] = useState<(AttachmentPreview & { scope: string }) | null>(null)
  const preview = previewState?.scope === previewScope ? previewState : null
  const polishEpoch = useRef(0)
  const appMode = useAppMode()
  const draft = draftState.text
  const hasPrompt = hasNonResourceContent(draftState)
  const referencedAttachments = controller.attachmentsForMentions(draftState.mentions)
  const currentAttachmentReferences = attachmentReferences(mergeWorkAttachments(controller.attachments, referencedAttachments))
  // Applying image edits preserves identity; its historical path remains a
  // valid inline reference but must not become another pending upload card.
  const pendingAttachmentReferences = currentAttachmentReferences.filter(reference =>
    controller.attachments.some(file => attachmentIdentity(file) === reference.id &&
      file.path.replace(/\\/g, '/') === reference.file.path.replace(/\\/g, '/')))
  const imageAttachmentReferences = pendingAttachmentReferences.filter(reference => reference.file.type.startsWith('image/'))
  const draftLiveRef = useRef(draft)
  const taskLiveRef = useRef(controller.activeTask?.id ?? 'home')
  const draftRevisionRef = useRef(0)
  draftLiveRef.current = draft
  taskLiveRef.current = controller.activeTask?.id ?? 'home'
  const awaitingAnswer = controller.pending.length > 0
  const terminal = controller.currentRun && !['running', 'waiting'].includes(controller.currentRun.status)
  const taskActive = !home && (controller.launching || controller.pendingInitialStart || !terminal &&
    (controller.streaming || awaitingAnswer || ['running', 'waiting'].includes(controller.activeTask?.status ?? '')))
  const selectedToolkits = controller.resources.toolkits ?? []
  const toolkitChangePending = Boolean(taskActive && controller.resources.toolkits !== undefined &&
    !sameToolkits(selectedToolkits, controller.currentRun?.requestConfig?.toolkits))
  const toolkitLimitation = toolkitChangePending ? '工具包变更将在下一轮生效，请选择排到下一轮。' : ''
  const resourceChangePending = taskActive && workResourceFollowupChanges({
    skills: workResourceSelection(controller.resources, 'skills'),
    mcpServers: workResourceSelection(controller.resources, 'mcpServers'),
    knowledgeBases: workResourceSelection(controller.resources, 'knowledgeBases')
  }, controller.currentRun?.requestConfig)
  useEffect(() => {
    if (mentionQuery !== null && controller.resources.toolkits === undefined) controller.retryToolkitSelection()
  }, [mentionQuery !== null, controller.activeTask?.id, controller.draftSource, controller.retryToolkitSelection])
  const followupRun = useMemo(() => rootFollowupRun(controller.messages, controller.activeTask?.id ?? null, controller.workspaceRunId), [controller.messages, controller.activeTask?.id, controller.workspaceRunId])
  // Approval pauses close the current controller attempt. Keep the draft until
  // the resumed run can supply a fresh target instead of posting to a dead one.
  const rootWaiting = awaitingAnswer || followupRun?.status === 'waiting'
  const rootAccepting = taskActive && !controller.stopping && !rootWaiting && followupRun?.status === 'running'
  const rootFollowup = useRootFollowup({ sessionId: controller.activeTask?.id ?? null, rootRunId: followupRun?.runId,
    source: getEngineSource(), active: rootAccepting, ready: controller.ready && controller.historyReady && appMode === 'work', toolProfile: 'general' })
  const immediateIntent = taskActive && rootFollowup.delivery === 'current'
  const busy = controller.streaming || controller.uploading || controller.loading || !controller.historyReady || awaitingAnswer || controller.messageActionBusy || controller.workspaceSelectionBusy
  const queueIntent = !home && !immediateIntent && (taskActive || controller.nextTurnQueue.pendingCount > 0 || controller.nextTurnQueue.state?.entries.some(entry => ['dispatching', 'admission-unknown', 'accepted'].includes(entry.phase))) && !controller.pendingInitialStart
  const queueBusy = controller.uploading || controller.loading || !controller.historyReady || controller.restartPending || controller.nextTurnQueue.saving || !controller.nextTurnQueue.ready
  const canAddFiles = controller.ready && !(queueIntent ? queueBusy : taskActive || busy)
  const addFiles = (files: File[]): void => {
    if (!files.length) return
    if (!canAddFiles || addingFilesRef.current) {
      toast.info(controller.uploading || addingFilesRef.current ? '资料正在添加，请稍候。'
        : !controller.ready ? '连接恢复后可添加资料，草稿会保留。' : '正在准备任务，请稍后添加资料。')
      return
    }
    addingFilesRef.current = true
    void controller.addFiles(files).catch(reportError).finally(() => { addingFilesRef.current = false })
  }
  const contextDisplay = useMemo(
    () => contextPresentation(controller.messages),
    [controller.messages]
  )
  const contextUsage = contextDisplay.primary
  const contextLimit = contextPresentationLimit(
    contextUsage,
    controller.models,
    controller.modelId || controller.defaultModelId,
    DEFAULT_CONTEXT_WINDOW_BUDGET
  )
  const resolveRootFollowup = (operation: () => Promise<boolean>, sentMessage: string): void => {
    const sessionId = controller.activeTask?.id
    if (!sessionId) return
    const source = getEngineSource(), original = getWorkDraft(controller.draftSource, sessionId), revision = draftRevisionRef.current
    const sentResources = controller.resources
    let sameDraft = false
    try { sameDraft = rootFollowupMessage(original.text, original.mentions, controller.attachmentsForMentions(original.mentions), resourceChangePending) === sentMessage } catch { /* Keep later attachment edits. */ }
    flushWorkDrafts(controller.draftSource)
    void operation().then(accepted => {
      if (!accepted || !sameDraft || source !== getEngineSource() || taskLiveRef.current !== sessionId || draftRevisionRef.current !== revision
        || getWorkDraft(controller.draftSource, sessionId) !== original) return
      controller.consumeDraftResources(original, sentResources)
      controller.setDraft('', []); inputRef.current?.setDraft('', [])
      mentionsRef.current = []; draftLiveRef.current = ''
      flushWorkDrafts(controller.draftSource)
    })
  }
  const submit = (): void => {
    onPreserveReading?.()
    if (addingFilesRef.current || rootFollowup.busy || rootFollowup.pending || controller.stopping) return
    if (immediateIntent) {
      if (toolkitChangePending) { toast.info(toolkitLimitation); return }
      if (mentionQuery !== null || resourceQuery !== null || !hasPrompt || !controller.ready || controller.uploading || controller.loading || !controller.historyReady || !rootFollowupCanSubmit(rootAccepting, rootFollowup.capability)) return
      let message: string
      try { message = rootFollowupMessage(draft, mentionsRef.current, controller.attachmentsForMentions(mentionsRef.current), resourceChangePending) }
      catch (cause) { reportError(cause); return }
      resolveRootFollowup(() => rootFollowup.send(message), message)
      return
    }
    if (mentionQuery !== null || resourceQuery !== null || (!hasPrompt && !referencedAttachments.length) || !controller.ready || (queueIntent ? queueBusy : taskActive || busy)) return
    flushWorkDrafts(controller.draftSource)
    setSendingDraft(true)
    void (
      queueIntent ? controller.enqueueNextTurn(draft, mentionsRef.current, draftRevisionRef.current) : home
        ? controller.createTask(draft, mentionsRef.current)
        : controller.send(draft, mentionsRef.current)
    ).catch(reportError).finally(() => setSendingDraft(false))
  }
  useEffect(() => {
    mentionsRef.current = controller.mentions
    polishEpoch.current += 1
    setPolishing(false)
    setMentionQuery(null)
    setResourceQuery(null)
    setAgentsOpen(false)
    inputRef.current?.setDraft(controller.draft, mentionsRef.current)
    return () => {
      polishEpoch.current += 1
      flushWorkDrafts(controller.draftSource)
    }
  }, [controller.activeTask?.id, controller.draftSource, home])
  useEffect(() => {
    // Rebuild chips only for an external edit; rebuilding typed text would reset the caret.
    if (
      userDraftRef.current?.text === draftState.text &&
      userDraftRef.current.mentions === draftState.mentions
    )
      return
    userDraftRef.current = null
    inputRef.current?.setDraft(draftState.text, draftState.mentions)
  }, [draftState])
  useEffect(() => {
    if (!inputRef.current || controller.workspaceSelectionBusy) return
    controller.inlinePendingFiles(file => {
      const reference = attachmentReferences([file])[0]
      return mentionsRef.current.some(mention => referencesAttachment(mention, reference)) ||
        inputRef.current?.insertMention(attachmentMention(reference)) === true
    })
  }, [controller.attachments, controller.inlinePendingFiles, controller.workspaceSelectionBusy, draftState, mentionRevision])
  useResourceMentions({ scope: JSON.stringify([controller.draftSource, controller.activeTask?.id ?? null]),
    active: appMode === 'work' && !controller.workspaceSelectionBusy && !controller.loading && !sendingDraft && !controller.launching &&
      !controller.pendingInitialStart && !controller.nextTurnQueue.saving && !rootFollowup.busy && (home || controller.historyReady),
    projectPath: controller.workspacePath ?? undefined, bindings: controller.resources,
    consumedKnowledgeBases: controller.resources.knowledgeBaseMentionsConsumed,
    mentions: draftState.mentions, insert: mention => inputRef.current?.insertMention(mention) === true })
  useEffect(() => {
    const request = controller.draftFocusRequest
    if (request?.source === controller.draftSource && request.taskId === (controller.activeTask?.id ?? null)) inputRef.current?.focus()
  }, [controller.draftFocusRequest])
  useEffect(() => {
    const scope = JSON.stringify([controller.draftSource, controller.activeTask?.id ?? null])
    if (restoredToolkitDraftScopes.current.has(scope) || controller.resources.toolkits === undefined ||
      controller.loading || controller.streaming || controller.launching || !home && !controller.historyReady) return
    restoredToolkitDraftScopes.current.add(scope)
    const draft = getWorkDraft(controller.draftSource, controller.activeTask?.id ?? null)
    const existing = draftToolkitIds(draft)
    const missing = selectedToolkits.filter(id => !existing.includes(id) && !controller.currentRun?.requestConfig?.toolkits?.includes(id))
    if (!missing.length) return
    // Restore selections authored with the earlier resource-strip UI as editable inline labels.
    const restored = appendWorkMentions(draft, missing.map(id => ({ source: 'toolkit', path: id, displayText: toolkitName(id) })))
    controller.setDraft(restored.text, restored.mentions)
  }, [controller.draftSource, controller.activeTask?.id, controller.resources.toolkits, controller.currentRun,
    controller.loading, controller.streaming, controller.launching, controller.historyReady, home])
  useEffect(
    () =>
      subscribeEngineSource(() => {
        polishEpoch.current += 1
        setPolishing(false)
        setAgentsOpen(false)
        setMentionQuery(null)
        setResourceQuery(null)
      }),
    []
  )
  useEffect(() => {
    if (appMode === 'work') return
    flushWorkDrafts(controller.draftSource)
    setMentionQuery(null)
    setResourceQuery(null)
    setAgentsOpen(false)
  }, [appMode, controller.draftSource])
  const polish = async (): Promise<void> => {
    if (!hasPrompt || polishing || !controller.ready) return
    const requestEpoch = ++polishEpoch.current
    const requestSource = getEngineSource()
    const requestTaskId = taskLiveRef.current
    const requestDraft = draft
    const requestRevision = draftRevisionRef.current
    setPolishing(true)
    try {
      const result = await utilityChat({
        model:
          controller.utilityModel || controller.modelId || controller.defaultModelId || undefined,
        systemPrompt:
          '你是发给 AI 编程助手的指令润色器。把草稿改写得清晰、具体、可执行，保留原语言和 @引用；只输出润色后的文本。',
        userPrompt: requestDraft,
        temperature: 0.3,
        maxTokens: 1500
      })
      if (
        requestSource !== getEngineSource() ||
        requestEpoch !== polishEpoch.current ||
        taskLiveRef.current !== requestTaskId ||
        draftLiveRef.current !== requestDraft ||
        draftRevisionRef.current !== requestRevision
      )
        return
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
      if (requestSource === getEngineSource() && requestEpoch === polishEpoch.current)
        toast.error(`AI 润色失败：${error instanceof Error ? error.message : '请稍后重试'}`)
    } finally {
      if (requestEpoch === polishEpoch.current) setPolishing(false)
    }
  }
  const selectResource = (item: ResourceItem): void => {
    if (item.kind === 'kb' && controller.resources.knowledgeBases.includes(item.id)) {
      if (inputRef.current?.removeSlashResource(resourceMention(item.kind, item.id, item.label))) {
        controller.removeResource('kb', item.id)
        setResourceQuery(null)
      }
      return
    }
    if (inputRef.current?.completeSlash(resourceMention(item.kind, item.id, item.label))) setResourceQuery(null)
  }
  return (
    <div
      className={`work-composer-wrap${home ? ' work-composer-wrap--home' : ''}`}
      onBlurCapture={() => flushWorkDrafts(controller.draftSource)}
    >
      {controller.actionError ? (
        <div className="work-error" role="alert">
          <Icon name="alert-circle" size={15} />
          <span>{controller.actionError}</span>
          <IconButton icon="close" label="关闭错误提示" onClick={controller.clearError} />
        </div>
      ) : null}
      <InputComposer
        ref={composerRef}
        className="work-composer"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            event.dataTransfer.dropEffect = canAddFiles ? 'copy' : 'none'
          }
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault()
            addFiles(Array.from(event.dataTransfer.files))
          }
        }}
      >
        {imageAttachmentReferences.length ? (
          <div className="work-attachments">
              <AttachmentStrip
                sessionId={attachmentPreviewSessionId}
                root={controller.workspacePath ?? null}
                references={imageAttachmentReferences}
                mentions={draftState.mentions}
                onPreview={(target: ChatAttachment, src: string | null) =>
                  references && !target.type.startsWith('image/') ? references.openMention({ source: 'file', origin: 'attachment', path: target.path, displayText: target.name }, undefined, target)
                    : setPreview({ file: target, src, scope: previewScope })
                }
                onRemove={file => { inputRef.current?.removeAttachmentReferences(attachmentIdentity(file)); controller.removeAttachment(file.path) }}
                onReorder={controller.reorderAttachments}
              />
          </div>
        ) : null}
        <ComposerInput
          ref={inputRef}
          value={draft}
          attachmentReferences={currentAttachmentReferences}
          attachmentRoot={controller.workspacePath ?? null}
          attachmentSessionId={controller.securitySessionId ?? undefined}
          ariaLabel={home ? '任务目标' : '继续对话'}
          baseClassName="work-chat__input"
          includeMentionClass={false}
          disabled={controller.workspaceSelectionBusy}
          placeholder={
            home
              ? '想完成什么？@ 引用文件或 Agent，/ 添加资源'
              : '补充要求；@ 添加引用、Agent 或工具包…'
          }
          onChange={(text, mentions) => {
            if (!controller.editDraft(text, mentions)) {
              inputRef.current?.setDraft(controller.draft, controller.mentions)
              return
            }
            const previousToolkits = mentionsRef.current.filter(mention => mention.source === 'toolkit').map(mention => mention.path)
            const nextToolkits = mentions.filter(mention => mention.source === 'toolkit').map(mention => mention.path)
            const resourceChanged = !sameResourceBindings(draftResourceBindings({ text: draftLiveRef.current, mentions: mentionsRef.current }), draftResourceBindings({ text, mentions }))
            if (taskActive && (resourceChanged || previousToolkits.length !== nextToolkits.length || previousToolkits.some(id => !nextToolkits.includes(id)))) rootFollowup.setDelivery('next')
            draftRevisionRef.current += 1
            draftLiveRef.current = text
            mentionsRef.current = mentions
            userDraftRef.current = { text, mentions }
            // Finishing or cancelling IME can leave the text unchanged while uploads await insertion.
            refreshMentionLabels(revision => revision + 1)
          }}
          onSubmit={submit}
          onPasteFiles={addFiles}
          onOpenMention={references?.openMention}
          onPasteText={(text, insertion) => {
            if (parseConversationLink(text.trim())) {
              if (!controller.ready || addingFilesRef.current) {
                toast.info('请等待连接或资料读取完成后再粘贴会话链接。')
                insertion.cancel()
                return true
              }
              const source = getEngineSource(), taskId = taskLiveRef.current
              addingFilesRef.current = true
              setResolvingReference(true)
              void resolveConversationReference(text.trim()).then(({ mention, notice }) => {
                if (source !== getEngineSource() || taskLiveRef.current !== taskId) { insertion.cancel(); return }
                if (insertion.insertMention(mention)) toast.info(notice)
                else toast.info('草稿位置已变化，请重新粘贴会话链接。')
              }).catch(error => {
                insertion.cancel()
                if (source === getEngineSource() && taskLiveRef.current === taskId) toast.error(ipcErrorMessage(error))
              }).finally(() => { addingFilesRef.current = false; setResolvingReference(false) })
              return true
            }
            if (!shouldAttachPastedText(text)) return false
            if (!canAddFiles || addingFilesRef.current) {
              toast.info(controller.uploading || addingFilesRef.current ? '资料正在添加，请稍候再粘贴。' : '暂时无法添加资料，请稍后重试；已有草稿已保留。')
              insertion.cancel()
              return true
            }
            const source = getEngineSource(), taskId = taskLiveRef.current
            addingFilesRef.current = true
            void controller.addPastedText(text).then(file => {
              if (source !== getEngineSource() || taskLiveRef.current !== taskId) { insertion.cancel(); return }
              if (!insertion.insertMention({ source: 'file', origin: 'attachment', attachmentId: attachmentIdentity(file), path: file.path, displayText: file.name })) {
                toast.info('原文已保存到任务资料，草稿已变化，可从资料中重新引用。')
              }
            }).catch(error => {
              insertion.cancel()
              if (source === getEngineSource() && taskLiveRef.current === taskId)
                toast.error(`粘贴的文本未能保存：${ipcErrorMessage(error)}。已有草稿已保留，可重新粘贴。`)
            }).finally(() => { addingFilesRef.current = false })
            return true
          }}
          onMentionQuery={(query) => {
            setMentionQuery(query)
            if (query !== null) setResourceQuery(null)
          }}
          onSlashQuery={(query) => {
            setResourceQuery(query)
            if (query !== null) setMentionQuery(null)
          }}
        />
        <ComposerToolbar
          leading={
            <>
              {appMode === 'work' ? (
                <>
                  <input
                    type="file"
                    multiple
                    ref={filesRef}
                    className="work-file-input"
                    tabIndex={-1}
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? [])
                      event.target.value = ''
                      addFiles(files)
                    }}
                  />
                  <button
                    type="button"
                    className="work-quiet-button work-attach-button"
                    aria-label="添加资料"
                    title="添加资料"
                    onClick={() => filesRef.current?.click()}
                    disabled={!canAddFiles}
                    aria-busy={controller.uploading}
                  >
                    {controller.uploading ? <Spinner /> : <Icon name="plus" size={16} />}
                  </button>
                </>
              ) : null}
              {!controller.agentLocked ? (
                <button
                  type="button"
                  className="work-quiet-button work-agent-button"
                  aria-label="管理与选择 Agent"
                  onClick={() => setAgentsOpen(true)}
                  disabled={!controller.ready}
                  title="选择或创建自定义 Agent"
                >
                  <Icon name="account-outline" size={16} />
                  <span>
                    {controller.agentId
                      ? controller.agentIdentity.name ||
                        (controller.agentIdentity.loading ? '读取 Agent…' : '查看 Agent')
                      : 'Agent'}
                  </span>
                </button>
              ) : null}
              <WorkComposerPreferences
                home={home}
                sessionId={controller.securitySessionId}
                workspacePath={controller.workspacePath ?? undefined}
                modelId={controller.modelId}
                thinkingMode={controller.thinkingMode}
                onThinkingChange={controller.setThinkingMode}
              />
            </>
          }
          trailing={
            <>
              <ComposerPolish busy={polishing} disabled={!hasPrompt || busy || !controller.ready}
                title="AI 润色" onClick={() => void polish()} />
              {contextUsage !== null || controller.contextCompaction ? (
                <ContextUsageIndicator
                  owner="work"
                  key={`${controller.draftSource}:${controller.activeTask?.id ?? 'home'}`}
                  used={contextUsage?.used ?? 0}
                  limit={contextLimit}
                  estimated={contextUsage?.estimated}
                  provisional={contextUsage?.provisional}
                  usageKnown={contextUsage !== null}
                  requestEstimate={contextDisplay.requestEstimate}
                  compaction={controller.contextCompaction}
                  streaming={controller.streaming}
                />
              ) : null}
              <ModelPicker
                active={appMode === 'work'}
                scopeKey={controller.activeTask?.id ?? 'home'}
                ariaLabel="Work 使用的模型"
                value={queueIntent ? controller.nextQueueModelId : controller.modelId}
                defaultModelId={controller.defaultModelId}
                onChange={queueIntent ? controller.setNextQueueModel : controller.setModel}
                disabled={
                  !controller.ready ||
                  immediateIntent ||
                  !controller.modelReady ||
                  (!queueIntent && controller.streaming) ||
                  controller.loading ||
                  (!queueIntent && ['running', 'waiting'].includes(controller.activeTask?.status ?? ''))
                }
                onManage={() => openAppSettings('models')}
              />
              {taskActive ? <RootFollowupDelivery controller={rootFollowup} disabled={controller.stopping || !controller.ready} /> : null}
              {/* The task heading owns cancellation; this action only submits the saved draft. */}
              <ComposerSend
                className="work-send"
                label={immediateIntent ? '立即补充' : queueIntent ? '排到下一轮' : home ? '开始任务' : '发送'}
                loading={resolvingReference || rootFollowup.busy || (queueIntent ? controller.nextTurnQueue.saving : !taskActive && controller.loading)}
                loadingLabel={resolvingReference ? '正在读取引用会话…' : immediateIntent ? '正在提交补充…' : queueIntent ? '正在加入下一轮…' : '正在发送…'}
                onClick={submit}
                disabled={
                  resolvingReference || controller.stopping || Boolean(rootFollowup.pending) || (immediateIntent
                    ? controller.uploading || controller.loading || !controller.historyReady || !rootFollowupCanSubmit(rootAccepting, rootFollowup.capability) || Boolean(toolkitLimitation || rootFollowupLimitation(mentionsRef.current, referencedAttachments, resourceChangePending))
                    : queueIntent ? queueBusy : taskActive || busy) || !controller.ready || (!hasPrompt && !referencedAttachments.length)
                }
              />
            </>
          }
        />
          <CompletionPopover
            open={mentionQuery !== null && appMode === 'work'}
            anchorRef={composerRef}
            className="work-completion-popover"
            onClose={() => setMentionQuery(null)}
          >
              <MentionRefPicker
                open={mentionQuery !== null && appMode === 'work'}
                root={controller.workspacePath ?? null}
                sessionId={attachmentPreviewSessionId}
                toolkitSessionId={controller.activeTask?.id}
                toolkitAgentId={controller.agentId || undefined}
                toolkitSelectionReady={controller.resources.toolkits !== undefined}
                attachments={pendingAttachmentReferences}
                query={mentionQuery ?? ''}
                selectedToolkits={selectedToolkits}
                onSelectToolkit={(id, name) => {
                  if (!inputRef.current) return
                  // Explicit selection also enables an existing, restored chip without duplicating it.
                  if (!controller.setResource('toolkit', id)) return
                  inputRef.current.completeMention({ source: 'toolkit', path: id, displayText: name })
                  if (taskActive) rootFollowup.setDelivery('next')
                  setMentionQuery(null)
                }}
                onSelect={(mention) => {
                  inputRef.current?.completeMention({ ...mention, origin: mention.origin ?? (mention.source === 'agent' ? undefined : 'workspace') })
                  setMentionQuery(null)
                }}
                onClose={() => {
                  setMentionQuery(null)
                  inputRef.current?.focus()
                }}
              />
          </CompletionPopover>
          <CompletionPopover
            open={resourceQuery !== null && appMode === 'work'}
            anchorRef={composerRef}
            className="work-completion-popover"
            onClose={() => setResourceQuery(null)}
          >
            <ResourcePicker
              query={resourceQuery ?? ''}
              projectPath={controller.workspacePath ?? undefined}
              selectedKnowledgeBases={controller.resources.knowledgeBases}
              onSelect={selectResource}
              onClose={() => {
                setResourceQuery(null)
                inputRef.current?.focus()
              }}
            />
          </CompletionPopover>
      </InputComposer>
      <RootFollowupFeedback key={JSON.stringify([getEngineSource(), controller.activeTask?.id])} controller={rootFollowup} active={taskActive} limitation={rootWaiting ? '请先处理上方确认，任务恢复后可立即补充；草稿已保留。' : !rootAccepting && taskActive ? '正在确认当前任务是否可接收补充，草稿已保留。' : toolkitLimitation || rootFollowupLimitation(mentionsRef.current, referencedAttachments, resourceChangePending)}
        onFocusInput={() => inputRef.current?.focus()}
        fallbackHint={!controller.ready ? '引擎尚未就绪，草稿会保留。' : toolkitChangePending ? '工具包变更将在下一轮生效' : queueIntent ? 'Enter 排到下一轮 · Shift + Enter 换行' : taskActive ? '任务正在准备，草稿会保留。' : 'Enter 发送 · Shift + Enter 换行'}
        footerAction={<>
          {home && controller.sources.length ? <button type="button" className="input-composer__history-button" onClick={references?.openSources}>资料 · {controller.sources.length}</button> : null}
          <WorkComposerWorkspace key={JSON.stringify([getEngineSource(), controller.securitySessionId, home])}
            sessionId={controller.activeTask?.id ?? null} selectedPath={controller.workspacePath}
            runId={controller.workspaceRunId} draft={home || controller.activeTask?.status === 'draft'}
            ready={controller.ready} active={appMode === 'work'} remote={controller.remote}
            selection={home || controller.activeTask?.status === 'draft' ? {
              history: controller.workspaceHistory,
              defaultPath: controller.defaultWorkspacePath,
              busy: controller.workspaceSelectionBusy,
              reason: controller.workspaceSelectionReason,
              onSelect: controller.selectWorkspace,
              onBrowse: controller.chooseWorkspace
            } : undefined} />
          {!controller.ready ? <button type="button" className="input-composer__history-button" onClick={() => openAppSettings('general')}>引擎设置</button> : null}
        </>}
        onResolve={resolveRootFollowup}
        canRestore={!hasPrompt && !referencedAttachments.length} onRestore={message => {
          if (draftLiveRef.current.trim()) return
          const recovered = userMessageDraft(message)
          controller.restoreDraftResources(recovered)
          draftRevisionRef.current += 1; draftLiveRef.current = recovered.text; mentionsRef.current = recovered.mentions
          controller.setDraft(recovered.text, recovered.mentions); inputRef.current?.setDraft(recovered.text, recovered.mentions)
          inputRef.current?.focus()
        }} />
      {agentsOpen ? (
        <WorkAgentManager
          workspacePath={controller.workspacePath}
          selectedId={controller.agentId}
          locked={controller.agentLocked}
          onSelect={(agent) => {
            if (controller.setAgent(agent?.id ?? '')) setAgentsOpen(false)
          }}
          onClose={() => setAgentsOpen(false)}
        />
      ) : null}
      {preview && appMode === 'work' ? (
        <AttachmentPreviewDialog
          sessionId={attachmentPreviewSessionId}
          root={controller.workspacePath ?? null}
          preview={preview}
          images={controller.attachments.filter((a) => a.type.startsWith('image/'))}
          onNavigate={(file) => setPreview({ file, src: null, scope: previewScope })}
          onApply={imageConversation ? file => imageConversation.addImage(file, preview.file.path) : undefined}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  )
}
function reportError(error: unknown): void {
  console.error(error)
}
