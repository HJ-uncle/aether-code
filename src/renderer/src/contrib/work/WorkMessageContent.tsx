import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type MouseEvent, type ReactNode } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import type { ChatAttachment, ChatMessage } from '@renderer/core/engine/useChat'
import { finalAnswerForMessage, getMessageFinalResult } from '@renderer/core/engine/final-result'
import { getEngineSource } from '@renderer/core/engine/source'
import { toast } from '@renderer/core/toast'
import { Icon } from '@renderer/workbench/icons'
import { MotionPresence } from '@renderer/workbench/MotionPresence'
import { AttachmentChip, AttachmentPreviewDialog, type AttachmentPreview } from '../chat/AttachmentChip'
import type { ChatFileContext } from '../chat/chat-link'
import { Markdown } from '../chat/Markdown'
import { ThinkingRow } from '../chat/ThinkingRow'
import { UserMessageContent } from '../chat/UserMessageContent'
import { useCollapseMemory } from '../chat/useCollapseMemory'
import { WorkCollaborationSummary } from './WorkCollaborationSummary'
import { WorkInlineActivity } from './WorkInlineActivity'
import { WorkToolActivity } from './WorkToolActivity'
import { workActivityState } from './work-inline-activity-state'
import { captureWorkCollaborationMembership, workMessageTimeline, workMessagePresentation, type WorkCollaborationMembership, type WorkMessageSegment } from './work-message-timeline'
import { workMessageRunning } from './work-tool-presentation'

export interface WorkMessageContentProps {
  message: ChatMessage
  sessionId: string
  fileContext: ChatFileContext
  active: boolean
  onFileLink?: (event: MouseEvent<HTMLElement>) => void
  onOpenFile?: (path: string) => void
  onOpenChange?: (change: EngineFileChange) => void
  revealTool?: { toolId: string; revision: number } | null
  turnSegments?: WorkMessageSegment[]
  processKey?: string
  defaultProcessOpen?: boolean
  finalAnswer?: { text: string } | false
  readOnly?: boolean
  userActions?: ReactNode
  children?: ReactNode
}

/** Message presentation is shared; the owning conversation supplies its actions and approvals. */
export const WorkMessageContent = memo(function WorkMessageContent({
  message, sessionId, fileContext, active, onFileLink, onOpenFile, onOpenChange,
  revealTool = null, turnSegments, processKey, defaultProcessOpen, finalAnswer, readOnly = false,
  userActions, children
}: WorkMessageContentProps): JSX.Element {
  const segments = useMemo(() => turnSegments ?? workMessageTimeline(message), [message, turnSegments])
  const processTools = useMemo(() => segments.flatMap(segment => segment.kind === 'tools' ? segment.tools : []), [segments])
  const collaborationMembership = useRef<WorkCollaborationMembership | undefined>(undefined)
  const finalResult = getMessageFinalResult(message, sessionId)
  const presentation = useMemo(() => workMessagePresentation(segments, collaborationMembership.current,
    finalAnswer === undefined ? finalAnswerForMessage(message, sessionId) : finalAnswer), [segments, message, sessionId, finalAnswer])
  const answerText = presentation.flatMap(segment => segment.kind === 'answer' ? [segment.text] : []).join('\n\n')
  const preserveCollaborationLayout = (): void => {
    // A neighbouring completion must not unmount a card or control the user
    // is reading. This choice lasts only for this mounted message.
    collaborationMembership.current ??= captureWorkCollaborationMembership(presentation)
  }
  const hasProcess = presentation.some(segment => segment.kind === 'process')
  const thinkingCount = segments.filter(segment => segment.kind === 'thinking').length
  const failureCount = processTools.filter(tool => ['error', 'interrupted'].includes(workActivityState(tool))).length
  const turnRunning = workMessageRunning(message)
  const [processMemory, setProcessOpen] = useCollapseMemory(`work-message:${getEngineSource()}:${sessionId}:${processKey ?? message.id}`)
  const processOpen = processMemory ?? defaultProcessOpen ?? turnRunning
  const [thinkingMemory, setThinkingOpen] = useCollapseMemory(`work-message-thinking:${getEngineSource()}:${sessionId}:${processKey ?? message.id}`)
  // Pure reasoning replies still have useful content when their process is opened.
  const thinkingOpen = thinkingMemory ?? processTools.length === 0
  const processId = `work-process-${useId().replace(/:/g, '')}`
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
  useLayoutEffect(() => { if (revealTool) setProcessOpen(true) }, [revealTool, setProcessOpen])
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <article
      className={`work-message work-message--${message.role}`}
      aria-label={message.role === 'user' ? '用户消息' : 'AI 回复'}
      data-message-id={message.id}
      data-process-expanded={hasProcess && processOpen ? 'true' : undefined}
      onClickCapture={onFileLink}
    >
      {message.role === 'user' ? (
        <WorkUserMessageBody message={message} root={fileContext.workspaceRoot ?? null}>
          {readOnly ? null : userActions}
        </WorkUserMessageBody>
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
            <Icon className="work-message__process-chevron" name="chevron-right" size={12} />
            <span>过程</span>
            {processTools.length ? <small>{processTools.length} 步</small> : null}
            {failureCount ? <small className="work-message__process-failures">{failureCount} 步未通过</small> : null}
          </button>
            {thinkingCount ? <button type="button" className="work-message__thinking-toggle"
              aria-label={thinkingOpen ? '隐藏思考' : '显示思考'} aria-pressed={thinkingOpen}
              title={`${thinkingOpen ? '隐藏' : '显示'} ${thinkingCount} 段思考`}
              onClick={() => { setThinkingOpen(!thinkingOpen); if (!thinkingOpen) setProcessOpen(true) }}>
              <Icon name="brain" size={13} /><span>思考</span>
            </button> : null}
          </div> : null}
          <div id={processId} className="work-message__timeline" onPointerDownCapture={preserveCollaborationLayout}
            onFocusCapture={preserveCollaborationLayout} onKeyDownCapture={preserveCollaborationLayout}>
            {presentation.map(segment => segment.kind === 'tool' ? (
              <WorkToolActivity key={segment.key} tool={segment.tool} fileContext={fileContext} onOpenFile={onOpenFile} onOpenChange={onOpenChange} turnRunning={turnRunning} active={active} readOnly={readOnly} />
            ) : segment.kind === 'collaboration' ? (
              <WorkCollaborationSummary key={segment.key} tools={segment.tools} fileContext={fileContext} revealTool={revealTool} active={active} readOnly={readOnly} />
            ) : segment.kind === 'answer' ? (
              <WorkAssistantContent key={segment.key} text={segment.text} streaming={message.status === 'streaming'} fileContext={fileContext} renderImages={!finalResult} />
            ) : (
              <MotionPresence key={segment.key} className="work-message__process" show={processOpen}>
                {segment.segments.map(item => item.kind === 'tools' ? (
                  <WorkInlineActivity key={item.key} tools={item.tools} fileContext={fileContext} onOpenFile={onOpenFile} onOpenChange={onOpenChange} revealTool={revealTool} expanded turnRunning={turnRunning} active={active} readOnly={readOnly} />
                ) : item.kind === 'thinking' ? (
                  <MotionPresence key={item.key} className="work-message__thinking" show={thinkingOpen}>
                    <ThinkingRow text={item.text} autoOpen={false} memoryKey={`work-thinking:${getEngineSource()}:${sessionId}:${processKey ?? message.id}:${item.key}`} />
                  </MotionPresence>
                ) : item.kind === 'followup' ? (
                  <div key={item.key} className="work-message--user work-message__followup" role="group" aria-label="用户消息" data-message-id={item.message.id}>
                    <WorkUserMessageBody message={item.message} root={fileContext.workspaceRoot ?? null} />
                  </div>
                ) : (
                  <WorkAssistantContent key={item.key} text={item.text} streaming={message.status === 'streaming'} fileContext={fileContext} />
                ))}
              </MotionPresence>
            ))}
          </div>
          {answerText && !['streaming', 'waiting'].includes(message.status) ? <div className="work-message__reply-actions">
            <button type="button" className="message__action" aria-label={copied ? '已复制回复' : '复制回复'} title={copied ? '已复制' : '复制回复'}
              onClick={() => { void navigator.clipboard.writeText(answerText).then(() => setCopied(true), error => toast.error(error instanceof Error ? error.message : String(error))) }}>
              <Icon name={copied ? 'check' : 'copy'} size={14} />
            </button>
          </div> : null}
        </>
      )}
      {children}
    </article>
  )
})

function WorkAttachment({ file, root, group }: {
  file: ChatAttachment
  root: string | null
  group?: ChatAttachment[]
}): JSX.Element {
  const [preview, setPreview] = useState<AttachmentPreview | null>(null)
  const images = (group ?? [file]).filter((a) => a.type.startsWith('image/'))
  return (
    <>
      <AttachmentChip root={root} file={file} onPreview={(target, src) => setPreview({ file: target, src })} />
      {preview ? <AttachmentPreviewDialog root={root} preview={preview} images={images}
        onNavigate={(next) => setPreview({ file: next, src: null })} onClose={() => setPreview(null)} /> : null}
    </>
  )
}

export function WorkUserMessageBody({ message, root, children, collapsible = true }: {
  message: ChatMessage
  root: string | null
  children?: ReactNode
  collapsible?: boolean
}): JSX.Element {
  return <div className="work-message__user">
    {message.attachments?.length ? (
      <div className="work-message__attachments" aria-label="附件">
        {message.attachments.map(file => <WorkAttachment key={file.path} file={file} root={root} group={message.attachments} />)}
      </div>
    ) : null}
    <div className="message__bubble"><UserMessageContent content={message.content} collapsible={collapsible} /></div>
    {children}
  </div>
}

export function WorkAssistantContent({ text, streaming, fileContext, renderImages = true }: {
  text: string
  streaming: boolean
  fileContext: ChatFileContext
  renderImages?: boolean
}): JSX.Element {
  return <div className="work-assistant-content-wrap">
    <div className="work-assistant-content">
      <Markdown text={text} streaming={streaming} fileContext={fileContext} renderImages={renderImages} />
    </div>
  </div>
}
