import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type MouseEvent, type ReactNode } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import type { FinalResult } from '@shared/final-result'
import type { ChatAttachment, ChatMessage } from '@renderer/core/engine/useChat'
import { finalAnswerForMessage, getMessageFinalResult } from '@renderer/core/engine/final-result'
import { getEngineSource, getExpectedEngine } from '@renderer/core/engine/source'
import { toast } from '@renderer/core/toast'
import { Icon } from '@renderer/ui/icons'
import { ContextMenu } from '@renderer/ui/ContextMenu'
import { ExtensionSlot, useExtensionMenuItems } from '../extensions'
import { extensionIcon } from '@renderer/app/navigation'
import { isEngineReady } from '@renderer/core/engine/source'
import { MotionPresence } from '@renderer/ui/MotionPresence'
import { AttachmentChip, AttachmentPreviewDialog, type AttachmentPreview } from './shared/AttachmentChip'
import type { ChatFileContext } from './shared/chat-link'
import { Markdown } from './shared/Markdown'
import { ThinkingRow } from './shared/ThinkingRow'
import { UserMessageContent } from './shared/UserMessageContent'
import { useCollapseMemory } from './shared/useCollapseMemory'
import { useSessionThinkingVisible } from './shared/session-display-store'
import { CollaborationSummary } from '../collaboration/CollaborationSummary'
import { InlineActivity } from './InlineActivity'
import { ProcessPanel } from './ProcessPanel'
import { ProcessSection } from './ProcessSection'
import { sessionProcessSections, type ProcessItem } from './process-sections'
import { ToolActivity } from './ToolActivity'
import { sessionActivityState } from './inline-activity-state'
import { captureSessionCollaborationMembership, sessionMessageTimeline, sessionMessagePresentation, sessionTranscriptPresentation, type SessionCollaborationMembership, type SessionMessageSegment, type SessionPresentationSegment } from './message-timeline'
import { sessionMessageRunning } from './tool-presentation'
import { sessionDeliveryProse } from './delivery-prose'
import { parseMentionContent } from './shared/mention-context'
import { useSessionReferenceNavigation } from './ReferenceNavigation'
import { sessionChangePathKey } from '../artifacts/file-changes'

export interface MessageContentProps {
  message: ChatMessage
  sessionId: string
  fileContext: ChatFileContext
  active: boolean
  onFileLink?: (event: MouseEvent<HTMLElement>) => void
  onOpenFile?: (path: string) => void
  onOpenChange?: (change: EngineFileChange) => void
  revealTool?: { toolId: string; revision: number } | null
  turnSegments?: SessionMessageSegment[]
  processKey?: string
  defaultProcessOpen?: boolean
  showAllContent?: boolean
  finalAnswer?: { text: string } | false
  deliveryResult?: FinalResult
  readOnly?: boolean
  userActions?: ReactNode
  replyActions?: ReactNode
  usage?: ReactNode
  children?: ReactNode
}

/** Message presentation is shared; the owning conversation supplies its actions and approvals. */
export const MessageContent = memo(function MessageContent({
  message, sessionId, fileContext, active, onFileLink, onOpenFile, onOpenChange,
  revealTool = null, turnSegments, processKey, defaultProcessOpen, showAllContent = false, finalAnswer, deliveryResult, readOnly = false,
  userActions, replyActions, usage, children
}: MessageContentProps): JSX.Element {
  const extensionContext = { sessionId, workspacePath: fileContext.workspaceRoot, engineReady: active && isEngineReady(), messageId: message.id, messageRole: message.role }
  const pluginActions = useExtensionMenuItems('message.actions', extensionContext)
  const [pluginMenu, setPluginMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => { setPluginMenu(null) }, [active, sessionId, message.id])
  const pluginButton = active && !readOnly && pluginActions.length ? <button type="button" className="message__action" aria-label="消息插件操作" title="插件操作" aria-haspopup="menu" aria-expanded={Boolean(pluginMenu)} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setPluginMenu({ x: rect.right, y: rect.bottom }) }}><Icon name="dots-horizontal" size={14} /></button> : null
  const segments = useMemo(() => turnSegments ?? sessionMessageTimeline(message), [message, turnSegments])
  const processTools = useMemo(() => segments.flatMap(segment => segment.kind === 'tools' ? segment.tools : []), [segments])
  const collaborationMembership = useRef<SessionCollaborationMembership | undefined>(undefined)
  const finalResult = getMessageFinalResult(message, sessionId)
  const turnRunning = sessionMessageRunning(message)
  const presentation = useMemo(() => showAllContent ? sessionTranscriptPresentation(segments) : sessionMessagePresentation(segments, collaborationMembership.current,
    finalAnswer === undefined ? finalAnswerForMessage(message, sessionId) : finalAnswer, turnRunning), [segments, message, sessionId, finalAnswer, turnRunning, showAllContent])
  const answerText = presentation.flatMap(segment => segment.kind === 'answer' ? [segment.text] : []).join('\n\n')
  const canCopy = Boolean(answerText) && !['streaming', 'waiting'].includes(message.status)
  const preserveCollaborationLayout = (): void => {
    // A neighbouring completion must not unmount a card or control the user
    // is reading. This choice lasts only for this mounted message.
    collaborationMembership.current ??= captureSessionCollaborationMembership(presentation)
  }
  const [thinkingOpen] = useSessionThinkingVisible(fileContext.receiptParentSessionId ?? sessionId)
  const hasProcess = presentation.some(segment => segment.kind === 'process' &&
    segment.segments.some(item => item.kind !== 'thinking' || thinkingOpen))
  const hasReplyContent = presentation.some(segment => segment.kind === 'answer' || segment.kind === 'content')
  const executionSegments = presentation.flatMap(segment => segment.kind === 'process' ? segment.segments : [])
  const failureCount = processTools.filter(tool => ['error', 'interrupted'].includes(sessionActivityState(tool))).length
  // Live inspection must not pin the finished turn open, including completion
  // while this row is unmounted. Settled history keeps its own reading choices.
  const processScope = `${getEngineSource()}:${sessionId}:${processKey ?? message.id}`
  const processPhase = turnRunning ? 'running' : 'settled'
  const [processMemory, setProcessOpen] = useCollapseMemory(`work-message:${processScope}:${processPhase}`)
  const processOpen = processMemory ?? defaultProcessOpen ?? turnRunning
  const processId = `work-process-${useId().replace(/:/g, '')}`
  const article = useRef<HTMLElement>(null)
  const processBar = useRef<HTMLDivElement>(null)
  const collapseAnchor = useRef<number | null>(null)
  const toggleProcess = (): void => {
    const bar = processBar.current
    const scroll = bar?.closest('.work-conversation__scroll')
    if (processOpen && bar && scroll && bar.parentElement!.getBoundingClientRect().top < scroll.getBoundingClientRect().top) {
      collapseAnchor.current = bar.getBoundingClientRect().top
    }
    setProcessOpen(!processOpen)
  }
  useLayoutEffect(() => {
    if (processOpen || collapseAnchor.current === null) return
    const bar = processBar.current, scroll = bar?.closest('.work-conversation__scroll')
    // Restore the collapsed header without moving the reader to an unrelated turn.
    if (bar && scroll) scroll.scrollTop += bar.getBoundingClientRect().top - collapseAnchor.current
    collapseAnchor.current = null
  }, [processOpen])
  const consumedReveal = useRef<{ scope: string; toolId: string; revision: number } | null>(null)
  useLayoutEffect(() => {
    if (!revealTool) return
    const previous = consumedReveal.current
    // A phase change updates the memory setter; it is not a fresh reveal request.
    if (previous?.scope === processScope && previous.toolId === revealTool.toolId && previous.revision === revealTool.revision) return
    consumedReveal.current = { scope: processScope, toolId: revealTool.toolId, revision: revealTool.revision }
    setProcessOpen(true)
  }, [processScope, revealTool, setProcessOpen])
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])
  const renderProcessItem = (item: ProcessItem): ReactNode => item.kind === 'tools' ? (
    <InlineActivity key={item.key} tools={item.tools} fileContext={fileContext} onOpenFile={onOpenFile} onOpenChange={onOpenChange}
      revealTool={revealTool} expanded contained={!showAllContent} groupRepeated={false} turnRunning={turnRunning} active={active && processOpen} readOnly={readOnly} />
  ) : item.kind === 'tool' ? (
    <ToolActivity key={item.key} tool={item.tool} fileContext={fileContext} onOpenFile={onOpenFile} onOpenChange={onOpenChange}
      revealRevision={revealTool?.toolId === item.tool.id ? revealTool.revision : undefined} turnRunning={turnRunning} active={active && processOpen} readOnly={readOnly} />
  ) : item.kind === 'collaboration' ? (
    <CollaborationSummary key={item.key} tools={item.tools} fileContext={fileContext} revealTool={revealTool} active={active && processOpen} readOnly={readOnly} />
  ) : item.kind === 'thinking' ? (
    <MotionPresence key={item.key} className="work-message__thinking" show={thinkingOpen}>
      <ThinkingRow text={item.text} autoOpen={false} memoryKey={`work-thinking:${getEngineSource()}:${sessionId}:${processKey ?? message.id}:${item.key}`} />
    </MotionPresence>
  ) : item.kind === 'followup' ? (
    <FollowupMessage key={item.key} message={item.message} sessionId={sessionId} fileContext={fileContext} active={active && processOpen} readOnly={readOnly} />
  ) : (
    <div key={item.key} className={showAllContent ? undefined : 'work-message__process-note'}>
      <SessionAssistantContent text={item.text} streaming={message.status === 'streaming'} fileContext={fileContext} renderImages={showAllContent} />
    </div>
  )
  const renderProcess = (segment: Extract<SessionPresentationSegment, { kind: 'process' }>): ReactNode => sessionProcessSections(segment.segments).map(item => item.kind === 'section' ? (
    <ProcessSection key={item.key} section={item} memoryKey={`${processScope}:${item.key}`} running={turnRunning}
      showThinking={thinkingOpen} revealTool={revealTool}>
      {item.segments.map(renderProcessItem)}
    </ProcessSection>
  ) : renderProcessItem(item))
  return (
    <article
      ref={article}
      className={`work-message work-message--${message.role}`}
      aria-label={message.role === 'user' ? '用户消息' : 'AI 回复'}
      data-message-id={message.id}
      data-process-expanded={hasProcess && processOpen ? 'true' : undefined}
      data-process-view={message.role === 'assistant' && !showAllContent ? 'focused' : undefined}
      onClickCapture={onFileLink}
    >
      {message.role === 'user' ? (
        <SessionUserMessageBody message={message} root={fileContext.workspaceRoot ?? null} fileContext={fileContext}>
          {readOnly || !userActions && !pluginButton ? null : <div className="work-message__user-controls">{userActions}{pluginButton ? <div className="work-message__actions">{pluginButton}</div> : null}</div>}
        </SessionUserMessageBody>
      ) : (
        <>
          {hasProcess ? <div ref={processBar} className="work-message__process-bar" data-expanded={processOpen ? 'true' : undefined}><button
            type="button"
            className="work-message__process-toggle"
            aria-expanded={processOpen}
            aria-controls={processId}
            aria-label={processOpen ? '收起过程' : '展开过程'}
            onClick={toggleProcess}
          >
            <span>过程</span>
            {processTools.length ? <small>{processTools.length} 步</small> : null}
            {failureCount ? <small className="work-message__process-failures">{failureCount} 步未通过</small> : null}
            <Icon className="work-message__process-chevron" name="chevron-right" size={12} />
          </button>
            {processOpen && !showAllContent ? <div className="work-message__process-navigation" role="group" aria-label="过程导航">
              {(['first', 'latest'] as const).map(direction => <button key={direction} type="button" className="work-message__process-jump"
                aria-label={direction === 'first' ? '查看最早步骤' : '查看最新步骤'} title={direction === 'first' ? '查看最早步骤' : '查看最新步骤'}
                onClick={() => {
                  const viewport = article.current?.querySelector<HTMLElement>('.work-message__process-viewport')
                  if (viewport) { viewport.dispatchEvent(new Event(`work-process-${direction}`)); viewport.focus({ preventScroll: true }) }
                }}><Icon name={direction === 'first' ? 'chevron-double-up' : 'chevron-double-down'} size={15} /></button>)}
            </div> : null}
          </div> : null}
          <div id={processId} className="work-message__timeline" onPointerDownCapture={preserveCollaborationLayout}
            onFocusCapture={preserveCollaborationLayout} onKeyDownCapture={preserveCollaborationLayout}>
            {!showAllContent && hasProcess ? <MotionPresence className="work-message__process" show={processOpen}>
              <ProcessPanel running={turnRunning} memoryKey={`${processScope}:${processPhase}`}>
                {renderProcess({ kind: 'process', key: processScope, segments: executionSegments })}
              </ProcessPanel>
            </MotionPresence> : null}
            {!showAllContent && hasProcess && hasReplyContent ? <hr className="work-message__process-divider" /> : null}
            {presentation.filter(segment => showAllContent || segment.kind !== 'process').map(segment => segment.kind === 'tool' ? (
              <ToolActivity key={segment.key} tool={segment.tool} fileContext={fileContext} onOpenFile={onOpenFile} onOpenChange={onOpenChange}
                revealRevision={revealTool?.toolId === segment.tool.id ? revealTool.revision : undefined} turnRunning={turnRunning} active={active} readOnly={readOnly} />
            ) : segment.kind === 'collaboration' ? (
              <CollaborationSummary key={segment.key} tools={segment.tools} fileContext={fileContext} revealTool={revealTool} active={active} readOnly={readOnly} />
            ) : segment.kind === 'answer' ? (
              <div key={segment.key} className="work-message__answer"><SessionAssistantContent text={segment.text} streaming={message.status === 'streaming'} fileContext={fileContext} renderImages={!finalResult} deliveryResult={deliveryResult} /></div>
            ) : segment.kind === 'content' ? (
              <div key={segment.key} className="work-message__body"><SessionAssistantContent text={segment.text} streaming={message.status === 'streaming'} fileContext={fileContext} /></div>
            ) : (
              <MotionPresence key={segment.key} className="work-message__process" show={processOpen}>
                {renderProcess(segment)}
              </MotionPresence>
            ))}
          </div>
        </>
      )}
      {children}
      {active ? <ExtensionSlot location="message.inline" context={extensionContext} /> : null}
      {message.role === 'assistant' && (usage || canCopy || replyActions || pluginButton) ? <div className="work-message__reply-actions">
        {usage}
        {canCopy || replyActions || pluginButton ? <div className="work-message__reply-controls" role="group" aria-label="回复操作">
          {canCopy ? <button type="button" className="message__action" aria-label={copied ? '已复制回复' : '复制回复'} title={copied ? '已复制' : '复制回复'}
            onClick={() => { void navigator.clipboard.writeText(answerText).then(() => setCopied(true), error => toast.error(error instanceof Error ? error.message : String(error))) }}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
          </button> : null}
          {readOnly ? null : replyActions}
          {pluginButton}
        </div> : null}
      </div> : null}
      {active && pluginMenu ? <ContextMenu x={pluginMenu.x} y={pluginMenu.y} anchor={article.current} items={pluginActions.map(item => ({ ...item, icon: item.icon ? <Icon name={extensionIcon(item.icon)} size={14} /> : undefined }))} onClose={() => setPluginMenu(null)} /> : null}
    </article>
  )
})

function FollowupMessage({ message, sessionId, fileContext, active, readOnly }: Pick<MessageContentProps, 'message' | 'sessionId' | 'fileContext' | 'active' | 'readOnly'>): JSX.Element {
  const context = { sessionId, workspacePath: fileContext.workspaceRoot, engineReady: active && isEngineReady(), messageId: message.id, messageRole: message.role }
  const actions = useExtensionMenuItems('message.actions', context)
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(null)
  useEffect(() => { setMenu(null) }, [active, sessionId, message.id])
  return <div className="work-message--user work-message__followup" role="group" aria-label="用户消息" data-message-id={message.id}>
    <SessionUserMessageBody message={message} root={fileContext.workspaceRoot ?? null} fileContext={fileContext}>
      {active && !readOnly && actions.length ? <div className="work-message__actions"><button type="button" className="message__action" aria-label="消息插件操作" title="插件操作" aria-haspopup="menu" aria-expanded={Boolean(menu)}
        onClick={event => { const anchor = event.currentTarget, rect = anchor.getBoundingClientRect(); setMenu({ x: rect.right, y: rect.bottom, anchor }) }}><Icon name="dots-horizontal" size={14} /></button></div> : null}
    </SessionUserMessageBody>
    {active ? <ExtensionSlot location="message.inline" context={context} /> : null}
    {active && menu ? <ContextMenu {...menu} items={actions.map(item => ({ ...item, icon: item.icon ? <Icon name={extensionIcon(item.icon)} size={14} /> : undefined }))} onClose={() => setMenu(null)} /> : null}
  </div>
}

function SessionAttachment({ file, root, group, fileContext }: {
  file: ChatAttachment
  root: string | null
  group?: ChatAttachment[]
  fileContext?: ChatFileContext
}): JSX.Element {
  const references = useSessionReferenceNavigation()
  const [preview, setPreview] = useState<AttachmentPreview | null>(null)
  const images = (group ?? [file]).filter((a) => a.type.startsWith('image/'))
  return (
    <>
      <AttachmentChip root={root} file={file} referenceLabel={file.referenceLabel} sessionId={fileContext?.sessionId} onPreview={(target, src) => references && !target.type.startsWith('image/')
        ? references.openMention({ source: 'file', origin: 'attachment', path: target.path, displayText: target.name }, fileContext, target)
        : setPreview({ file: target, src })} />
      {preview ? <AttachmentPreviewDialog root={root} sessionId={fileContext?.sessionId} preview={preview} images={images}
        onNavigate={(next) => setPreview({ file: next, src: null })} onClose={() => setPreview(null)} /> : null}
    </>
  )
}

export function SessionUserMessageBody({ message, root, fileContext, children, collapsible = true }: {
  message: ChatMessage
  root: string | null
  fileContext?: ChatFileContext
  children?: ReactNode
  collapsible?: boolean
}): JSX.Element {
  const references = useSessionReferenceNavigation()
  const attachments = useMemo(() => {
    const { refs } = parseMentionContent(message.content)
    return message.attachments?.filter(file => !refs.some(ref => ref.t === 'file' && sessionChangePathKey(ref.p, root) === sessionChangePathKey(file.path, root))) ?? []
  }, [message.content, message.attachments, root])
  return <div className="work-message__user">
    {attachments.length ? (
      <div className="work-message__attachments" aria-label="附件">
        {attachments.map(file => <SessionAttachment key={file.path} file={file} root={root} group={attachments} fileContext={fileContext} />)}
      </div>
    ) : null}
    <div className="message__bubble"><UserMessageContent content={message.content} collapsible={collapsible}
      onOpenMention={references ? mention => references.openMention(mention, fileContext,
        message.attachments?.find(file => sessionChangePathKey(file.path, root) === sessionChangePathKey(mention.path ?? '', root))) : undefined} /></div>
    {children}
  </div>
}

export function SessionAssistantContent({ text, streaming, fileContext, renderImages = true, deliveryResult }: {
  text: string
  streaming: boolean
  fileContext: ChatFileContext
  renderImages?: boolean
  deliveryResult?: FinalResult
}): JSX.Element {
  const engineBaseUrl = getExpectedEngine().baseUrl
  const displayText = useMemo(() => sessionDeliveryProse(text, deliveryResult, fileContext, engineBaseUrl), [text, deliveryResult, fileContext, engineBaseUrl])
  return <div className="work-assistant-content-wrap">
    <div className="work-assistant-content">
      <Markdown text={displayText} streaming={streaming} fileContext={fileContext} renderImages={renderImages} />
    </div>
  </div>
}
