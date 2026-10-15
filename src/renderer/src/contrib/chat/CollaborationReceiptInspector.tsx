import { useEffect, useRef, useState, type JSX } from 'react'
import { request } from '@renderer/core/engine/client'
import { captureControllerConnection } from '@renderer/core/engine/collaboration-controller'
import { controllerConnectionIdentity, type ControllerTarget } from '@renderer/core/engine/collaboration-contract'
import { collaborationReceiptState, loadCollaborationInspection, type CollaborationInspection } from '@renderer/core/engine/collaboration-inspection'
import { getEngineSource, getExpectedEngine } from '@renderer/core/engine/source'
import { Spinner } from '@renderer/workbench/ui-primitives'
import './subagent-followup.css'

/** No timer or background discovery: the user chooses which scoped page to inspect. */
export function CollaborationReceiptInspector({ target, source, ready, visible }: {
  target: ControllerTarget; source: number; ready: boolean; visible: boolean
}): JSX.Element {
  const identity = JSON.stringify([source, target.rootRunId, target.rootSessionId, target.childSessionId, target.invocationRunId])
  const identityRef = useRef(identity), mounted = useRef(true), pending = useRef(false)
  identityRef.current = identity
  const [view, setView] = useState<{ identity: string; inspection?: CollaborationInspection; loading?: boolean; error?: string }>({ identity })
  const current = view.identity === identity ? view : { identity }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const read = async (next = false): Promise<void> => {
    if (pending.current || !ready || !visible) return
    pending.current = true
    const connection = captureControllerConnection('general')
    const verify = (): void => {
      if (!mounted.current || identityRef.current !== identity || source !== getEngineSource()
        || controllerConnectionIdentity(connection.expectedEngine) !== controllerConnectionIdentity(getExpectedEngine())) throw new Error('任务、账号或引擎已切换，请在当前代理重新读取')
    }
    setView({ ...current, identity, loading: true, error: undefined })
    try {
      verify()
      const inspection = await loadCollaborationInspection(target, input => request({ ...input, expectedEngine: connection.expectedEngine, toolProfile: 'general' }), verify, next ? current.inspection : undefined)
      verify(); setView({ identity, inspection })
    } catch (cause) {
      if (mounted.current && identityRef.current === identity && source === getEngineSource()) setView({ ...current, identity, error: cause instanceof Error ? cause.message : '暂时无法读取协作回执，请重试' })
    } finally { pending.current = false }
  }
  const inspection = current.inspection
  return <details className="collaboration-inspector" aria-busy={current.loading === true}>
    <summary>协作回执与能力{inspection ? <span>版本 {inspection.page.revision}</span> : null}</summary>
    <p>按需读取当前代理收到的协作请求。持久接纳仅证明入队；引擎尚未提供已读取、已执行或内容无冲突的证明。</p>
    <div className="collaboration-inspector__actions">
      <button type="button" className="link" disabled={!ready || !visible || current.loading} onClick={() => void read()}>{current.loading ? <><Spinner size={12} />正在读取…</> : inspection ? '重新读取第一页' : '读取协作回执'}</button>
      {inspection?.page.hasMore ? <button type="button" className="link" disabled={!ready || !visible || current.loading} onClick={() => void read(true)}>下一页回执</button> : null}
    </div>
    {inspection ? <>
      <dl className="collaboration-inspector__capabilities">
        <div><dt>持久回执</dt><dd>{inspection.capabilities.durableQueueReceipts ? '可用' : '未启用'}</dd></div>
        <div><dt>运行中通讯</dt><dd>{inspection.capabilities.runtimeCommunication ? '引擎已启用' : '引擎未启用'}</dd></div>
        <div><dt>消费确认</dt><dd>{inspection.capabilities.mailboxConsumer ? '消费者已启用，回执仍不提供消费状态' : '引擎未启用'}</dd></div>
        <div><dt>用户补充要求</dt><dd>{inspection.capabilities.userControllerMutation ? '引擎已启用' : '引擎未启用'}</dd></div>
      </dl>
      <p>第 {inspection.pageNumber} 页 · 此页 {inspection.page.entries.length} 条{inspection.page.hasMore ? ' · 还有更多' : ' · 已到此版本末尾'}。只保留当前页，刷新会读取新版本。</p>
      <div className="collaboration-inspector__list">
        {inspection.page.entries.length ? inspection.page.entries.map(receipt => <details key={receipt.messageId}>
          <summary><span>{collaborationReceiptState(receipt)}</span><span>#{receipt.acceptedSeq}</span></summary>
          <dl className="collaboration-inspector__evidence">
            <div><dt>发送方</dt><dd>{receipt.senderParticipantId}</dd></div>
            <div><dt>请求标识</dt><dd>{receipt.requestKey}</dd></div>
            <div><dt>接纳序号</dt><dd>{receipt.acceptedSeq}</dd></div>
            <div><dt>正文大小</dt><dd>{receipt.payloadBytes} B</dd></div>
            <div><dt>SHA-256</dt><dd>{receipt.payloadHash}</dd></div>
            <div><dt>根执行</dt><dd>{receipt.rootRunId}</dd></div>
            <div><dt>尝试标识</dt><dd>{receipt.rootAttemptId}</dd></div>
            {receipt.reason ? <div><dt>引擎原因</dt><dd>{receipt.reason}</dd></div> : null}
          </dl>
        </details>) : <p>此代理在当前版本没有协作回执。这不代表其他任务没有通讯。</p>}
      </div>
    </> : null}
    {current.error ? <p className="subagent-followup__error" role="alert">{current.error}</p> : null}
  </details>
}
