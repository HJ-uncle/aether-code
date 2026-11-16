import { useEffect, useMemo, useState, type JSX, type MouseEvent } from 'react'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import { createCollaborationController, subscribeControllerOutbox } from '@renderer/core/engine/collaboration-controller'
import { controllerStorageIdentity } from '@renderer/core/engine/collaboration-contract'
import { getExpectedEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { projectRootFollowupDisplay, type RootFollowupDisplay } from '@renderer/core/engine/root-followup-display'
import { SessionUserMessageBody } from './MessageContent'
import type { ChatFileContext } from './shared/chat-link'
import './root-followup-receipts.css'

export function useRootFollowupReceipts(sessionId: string, messages: readonly ChatMessage[]): RootFollowupDisplay[] {
  const [revision, setRevision] = useState(0)
  const controller = useMemo(() => createCollaborationController(), [])
  useEffect(() => {
    const update = (): void => setRevision(value => value + 1)
    const offRecords = subscribeControllerOutbox(update), offEngine = subscribeEngineSource(update)
    return () => { offRecords(); offEngine() }
  }, [])
  const records = useMemo(() => {
    try {
      return { pending: controller.records(), history: controller.history() }
    } catch { return { pending: [], history: [] } } // The composer owns storage errors and recovery actions.
  }, [controller, revision])
  const storageIdentity = controllerStorageIdentity(getExpectedEngine())
  return useMemo(() => projectRootFollowupDisplay({ sessionId, messages, storageIdentity, ...records }),
    [sessionId, messages, storageIdentity, records])
}

export function RootFollowupReceipt({ item, fileContext, onFileLink }: {
  item: RootFollowupDisplay; fileContext: ChatFileContext; onFileLink?: (event: MouseEvent<HTMLElement>) => void
}): JSX.Element {
  return <div className="work-message--user work-root-followup-receipt" role="group" aria-label="用户补充消息"
    data-request-key={item.requestKey} data-delivery-state={item.state} onClickCapture={onFileLink}>
    <SessionUserMessageBody message={item.message} root={fileContext.workspaceRoot ?? null} fileContext={fileContext}>
      <p className="work-root-followup-receipt__status" role="status">{item.label}</p>
    </SessionUserMessageBody>
  </div>
}
