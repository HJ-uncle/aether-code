import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Icon, ResourceIcon } from '@renderer/ui/icons'
import { ToolkitIcon } from './toolkit-icons'
import { agentReferenceIcon } from './agent-mention-icon'
import {
  mentionTitle,
  isResourceMention,
  isResourceSource,
  contentFromBody,
  parseMentionContent,
  refToMention,
  userMessageText,
  type Mention
} from './mention-context'

const USER_COLLAPSED_LINES = 8

/** User-facing refs are restored by their persisted ranges, never by matching
 * display names. Both modes must hide snapshots and protocol metadata. */
export const UserMessageContent = memo(function UserMessageContent({ content, collapsible = true, onOpenMention }: {
  content: string
  collapsible?: boolean
  onOpenMention?: (mention: Mention) => void
}): JSX.Element {
  const segments = useMemo(() => {
    const { body, refs } = parseMentionContent(content)
    if (!refs.length) return [{ text: userMessageText(content), ref: null }]
    const out: { text: string; ref: Mention | null }[] = []
    let cursor = 0
    for (const ref of refs) {
      if (ref.s > cursor) out.push({ text: body.slice(cursor, ref.s), ref: null })
      out.push({ text: ref.d, ref: refToMention(ref, contentFromBody(body, ref)) })
      cursor = ref.e
    }
    if (cursor < body.length) out.push({ text: body.slice(cursor), ref: null })
    return out
  }, [content])

  const contentRef = useRef<HTMLDivElement>(null)
  const contentId = `user-message-content-${useId().replace(/:/g, '')}`
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    setExpanded(false)
    if (!collapsible) {
      setOverflowing(false)
      return
    }
    const element = contentRef.current
    if (!element) return

    const measure = (): void => {
      const style = getComputedStyle(element)
      const lineHeight = Number.parseFloat(style.lineHeight)
      const maxHeight = Number.isFinite(lineHeight) ? lineHeight * USER_COLLAPSED_LINES : element.clientHeight
      setOverflowing(element.scrollHeight > maxHeight + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [content, collapsible])

  return (
    <>
      <div
        id={contentId}
        ref={contentRef}
        className={`message__bubble-content${collapsible && overflowing && !expanded ? ' is-collapsed' : ''}`}
      >
        {segments.map((segment, index) =>
          segment.ref ? (
            <span
              key={index}
              className={`mention-chip mention-chip--${segment.ref.source}`}
              title={segment.ref.origin === 'attachment' && /^粘贴文本(?: · |$)/.test(segment.ref.displayText)
                ? `${segment.ref.displayText}\n长文本已折叠，点击查看全文`
                : segment.ref.source === 'conversation' ? mentionTitle(segment.ref) : `${segment.ref.displayText}\n${mentionTitle(segment.ref)}`}
              role={onOpenMention && segment.ref.source !== 'toolkit' && !isResourceMention(segment.ref) ? 'button' : undefined}
              tabIndex={onOpenMention && segment.ref.source !== 'toolkit' && !isResourceMention(segment.ref) ? 0 : undefined}
              aria-label={segment.ref.source === 'toolkit' || isResourceMention(segment.ref) ? mentionTitle(segment.ref) : onOpenMention ? `查看引用：${segment.ref.displayText}` : undefined}
              onClick={onOpenMention && segment.ref.source !== 'toolkit' && !isResourceMention(segment.ref) ? () => onOpenMention(segment.ref!) : undefined}
              onKeyDown={onOpenMention && segment.ref.source !== 'toolkit' && !isResourceMention(segment.ref) ? (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                event.stopPropagation()
                onOpenMention(segment.ref!)
              } : undefined}
            >
              {segment.ref.source === 'conversation' ? <Icon name="chat-outline" size={14} className="mention-chip__icon" /> : null}
              {segment.ref.source === 'agent' ? <Icon name={agentReferenceIcon(segment.ref.path)} size={16} className="mention-chip__icon mention-chip__icon--agent" /> : null}
              {segment.ref.source === 'toolkit' ? <ToolkitIcon id={segment.ref.path} size={16} className="mention-chip__icon mention-chip__icon--toolkit" /> : null}
              {isResourceSource(segment.ref.source) ? <ResourceIcon kind={segment.ref.source} className="mention-chip__icon" /> : null}
              <span className="mention-chip__label">{segment.ref.displayText}</span>
            </span>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
      </div>
      {collapsible && overflowing ? (
        <button
          type="button"
          className="message__collapse-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded(value => !value)}
        >
          <span>{expanded ? '收起' : '显示更多'}</span>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
      ) : null}
    </>
  )
})
