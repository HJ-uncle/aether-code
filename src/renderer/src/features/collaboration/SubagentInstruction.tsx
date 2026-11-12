import { useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import { Icon } from '@renderer/ui/icons'
import { Popover } from '@renderer/ui/Popover'
import type { ChatFileContext } from '../conversation/shared/chat-link'
import { parseMentionContent, userMessageText } from '../conversation/shared/mention-context'
import { SessionUserMessageBody } from '../conversation/MessageContent'
import type { SubagentTranscriptMemory } from './SubagentTranscript'
import { sessionSubagentInstructionParts, sessionSubagentInstructionPreview, sessionSubagentInstructionTime } from './subagent-instruction'

export function SubagentInstruction({ message, memory, redraw, fileContext }: {
  message: ChatMessage
  memory: SubagentTranscriptMemory
  redraw: () => void
  fileContext: ChatFileContext
}): JSX.Element {
  const container = useRef<HTMLElement>(null)
  const collapseTop = useRef<number | null>(null)
  const id = `agent-user-${useId().replace(/:/g, '')}`
  const open = memory.opened.has(message.id)
  const [detailTab, setDetailTab] = useState<'context' | 'original'>('context')
  const presentation = useMemo(() => {
    const parts = sessionSubagentInstructionParts(message.content)
    const text = parts?.task ?? userMessageText(message.content)
    const preview = sessionSubagentInstructionPreview(text)
    const hasReferences = parseMentionContent(message.content).refs.length > 0
    return { parts, preview, hasReferences, time: sessionSubagentInstructionTime(message.createdAt) }
  }, [message.content, message.createdAt])
  const { parts, preview, hasReferences, time } = presentation
  const content = parts ? (open ? parts.task : preview.text)
    : open || !preview.truncated || hasReferences ? message.content : preview.text
  const displayMessage = useMemo(() => ({ ...message, content }), [message, content])

  const toggle = (key: string): void => {
    if (memory.opened.has(key)) {
      const article = container.current, scroll = article?.closest('.work-conversation__scroll')
      if (article && scroll && article.getBoundingClientRect().top < scroll.getBoundingClientRect().top)
        collapseTop.current = scroll.getBoundingClientRect().top
      memory.opened.delete(key)
    } else memory.opened.add(key)
    redraw()
  }
  useLayoutEffect(() => {
    if (collapseTop.current === null) return
    const article = container.current, scroll = article?.closest('.work-conversation__scroll')
    if (article && scroll) scroll.scrollTop += article.getBoundingClientRect().top - collapseTop.current
    collapseTop.current = null
  }, [open])

  return <article ref={container} className={`work-message work-message--user work-subagent-instruction${open ? ' is-open' : ''}`}
    data-message-id={message.id} data-delegated={parts ? 'true' : undefined} aria-label="用户消息">
    <div className="work-subagent-instruction__meta">
      <span>用户</span>
      {time ? <time dateTime={time.dateTime} title={time.title}>{time.label}</time> : null}
      {preview.truncated ? <button type="button" className="work-subagent-instruction__toggle" aria-expanded={open}
        aria-controls={`${id}-body`} aria-label={open ? '收起用户消息' : '展开用户消息全文'} onClick={() => toggle(message.id)}>
        {open ? '收起' : '展开全文'}<Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} /></button> : null}
      {parts ? <Popover label="用户消息详情" align="end" width={420} className="work-subagent-instruction__info"
        panelClassName="work-subagent-instruction__info-panel" onOpenChange={visible => { if (visible) setDetailTab('context') }}
        trigger={({ open: infoOpen }) => <button type="button" className="work-subagent-instruction__info-trigger"
          aria-label="用户消息详情" aria-expanded={infoOpen} title="用户消息详情"><Icon name="info" size={14} /></button>}>
        <div className="work-subagent-instruction__detail-tabs" role="tablist" aria-label="用户消息详情视图" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'context' : event.key === 'End' ? 'original' : detailTab === 'context' ? 'original' : 'context'
          setDetailTab(next)
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-detail-tab="${next}"]`)?.focus()
        }}>
          <button type="button" role="tab" id={`${id}-context-tab`} data-detail-tab="context" tabIndex={detailTab === 'context' ? 0 : -1}
            aria-selected={detailTab === 'context'} aria-controls={`${id}-detail-content`} onClick={() => setDetailTab('context')}>协作说明</button>
          <button type="button" role="tab" id={`${id}-original-tab`} data-detail-tab="original" tabIndex={detailTab === 'original' ? 0 : -1}
            aria-selected={detailTab === 'original'} aria-controls={`${id}-detail-content`} onClick={() => setDetailTab('original')}>原始消息</button>
        </div>
        <div key={detailTab} id={`${id}-detail-content`} className="work-subagent-instruction__detail-content" role="tabpanel"
          aria-labelledby={`${id}-${detailTab}-tab`} tabIndex={0}>
          {detailTab === 'context' ? <div className="work-subagent-instruction__context">
            {parts.request ? <section><h4>用户请求</h4><p>{parts.request}</p></section> : null}
            {parts.background ? <section><h4>对话背景</h4><p>{parts.background}</p></section> : null}
            <section><h4>执行约定</h4><p>{parts.guidance}</p></section>
          </div> : <pre className="work-subagent-instruction__original" aria-label="原始用户消息">{message.content}</pre>}
        </div>
      </Popover> : null}
    </div>
    <div className="work-subagent-instruction__bubble">
      <div id={`${id}-body`} className={`work-subagent-instruction__body${preview.truncated && !open ? ' work-subagent-instruction__body--preview' : ''}`}
        onFocusCapture={event => {
          // Referenced files keep their original range metadata and actions.
          // Keyboard focus on a clipped chip must reveal it before interaction.
          if (hasReferences && preview.truncated && !open && event.target instanceof HTMLElement && event.target.closest('.mention-chip')) {
            memory.opened.add(message.id)
            redraw()
          }
        }}>
        <SessionUserMessageBody message={displayMessage} root={fileContext.workspaceRoot ?? null} fileContext={fileContext} collapsible={false} />
      </div>
    </div>
  </article>
}
