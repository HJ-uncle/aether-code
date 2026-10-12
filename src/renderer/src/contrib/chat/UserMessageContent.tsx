import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import {
  mentionTitle,
  parseMentionContent,
  userMessageText,
  type PromptRef
} from './mention-context'

const USER_COLLAPSED_LINES = 8

/** User-facing refs are restored by their persisted ranges, never by matching
 * display names. Both modes must hide snapshots and protocol metadata. */
export const UserMessageContent = memo(function UserMessageContent({ content, collapsible = true }: {
  content: string
  collapsible?: boolean
}): JSX.Element {
  const segments = useMemo(() => {
    const { body, refs } = parseMentionContent(content)
    if (!refs.length) return [{ text: userMessageText(content), ref: null }]
    const out: { text: string; ref: PromptRef | null }[] = []
    let cursor = 0
    for (const ref of refs) {
      if (ref.s > cursor) out.push({ text: body.slice(cursor, ref.s), ref: null })
      out.push({ text: ref.d, ref })
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
              className={`mention-chip mention-chip--${segment.ref.t}`}
              title={`${segment.ref.d}\n${mentionTitle({
                source: segment.ref.t,
                path: segment.ref.p,
                startLine: segment.ref.r?.[0],
                endLine: segment.ref.r?.[1]
              })}`}
            >
              {segment.ref.d}
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
