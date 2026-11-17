import { classifyChatLink, type ChatLinkTarget } from './shared/chat-link'

/** Share literal-path handling between left click and the file context menu. */
export function conversationFileLink(element: EventTarget | null, sessionId: string, engineUrl: string): {
  anchor: HTMLAnchorElement
  target: ChatLinkTarget
} | null {
  const anchor = element instanceof Element ? element.closest('a') : null
  const href = anchor?.getAttribute('href')
  if (!anchor || !href) return null
  const literal = anchor.getAttribute('data-work-file-path')
  const target = literal ? { kind: 'file' as const, path: literal }
    : classifyChatLink(href, sessionId, engineUrl)
  if (target.kind === 'file' || target.kind === 'artifact') {
    // Receipt paths are already literal, including #, %, and numeric suffixes.
    return { anchor, target: { ...target, path: literal ? target.path.replace(/\\/g, '/')
      : target.path.replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, '') } }
  }
  return { anchor, target }
}
