import { useEffect, useRef } from 'react'
import { getEngineSource } from '@renderer/core/engine/source'
import { publishExtensionEvent } from '../extensions'
import { observeExtensionMessages, type ExtensionMessage, type ExtensionMessageState } from './extension-message-events'

/** Observe the owning live controller, never virtualized message DOM mount/unmount. */
export function useExtensionMessageEvents(sessionId: string, workspacePath: string | null | undefined, messages: readonly ExtensionMessage[], ready: boolean, active: boolean): void {
  const source = getEngineSource(), scope = `${source}:${sessionId}`
  const observation = useRef<{ scope: string; state: ExtensionMessageState | null }>({ scope, state: null })
  useEffect(() => {
    if (!active || !ready) { observation.current = { scope, state: null }; return }
    const previous = observation.current.scope === scope ? observation.current.state : null
    const result = observeExtensionMessages(previous, messages)
    observation.current = { scope, state: result.state }
    for (const { name, message } of result.events) publishExtensionEvent(name, { sessionId, workspacePath, engineReady: true, messageId: message.id, messageRole: message.role },
      { status: message.status, content: message.content.slice(0, 4000), truncated: message.content.length > 4000 })
  }, [scope, sessionId, workspacePath, messages, ready, active])
}
