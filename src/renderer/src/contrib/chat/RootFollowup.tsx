import { useState, type JSX } from 'react'
import { useCollaborationController } from '@renderer/core/engine/useCollaborationController'
import { controllerSavedStatus } from '@renderer/core/engine/collaboration-contract'
import { ControllerTrackingRecovery } from './SubagentFollowup'

export function useRootFollowup(input: {
  sessionId: string | null; rootRunId?: string; source: number
  active: boolean; ready: boolean; toolProfile: 'code' | 'general'
}): ReturnType<typeof useCollaborationController> & {
  delivery: 'current' | 'next'; setDelivery: (value: 'current' | 'next') => void; immediate: boolean; refresh: () => void
} {
  const scope = JSON.stringify([input.source, input.sessionId, input.rootRunId])
  const [choice, setChoice] = useState<{ scope: string; value: 'current' | 'next' }>()
  const [refreshKey, setRefreshKey] = useState(0)
  const delivery = choice?.scope === scope ? choice.value : 'current'
  const controller = useCollaborationController({ ...input, kind: 'root', refreshKey })
  return { ...controller, delivery, setDelivery: value => setChoice({ scope, value }), immediate: input.active && delivery === 'current', refresh: () => setRefreshKey(value => value + 1) }
}

export function RootFollowupDelivery({ controller, disabled }: { controller: ReturnType<typeof useRootFollowup>; disabled: boolean }): JSX.Element {
  return <select className="input-composer__delivery" aria-label="发送方式" title="立即补充当前任务，或在当前任务结束后开始下一轮"
    value={controller.delivery} disabled={disabled || controller.busy || Boolean(controller.pending)}
    onChange={event => controller.setDelivery(event.target.value === 'next' ? 'next' : 'current')}>
    <option value="current">立即补充</option><option value="next">排到下一轮</option>
  </select>
}

/** Keep delivery status near the editor, with the original text available in
 * one collapsed row. An acceptance receipt does not prove model consumption. */
export function RootFollowupFeedback({ controller, active, limitation, canRestore, onRestore, onResolve }: {
  controller: ReturnType<typeof useRootFollowup>; active: boolean; limitation: string
  canRestore: boolean; onRestore: (message: string) => void
  onResolve: (operation: () => Promise<boolean>, message: string) => void
}): JSX.Element | null {
  const hint = controller.notice || (active && controller.delivery === 'current'
    ? limitation || (controller.capability === false ? '当前引擎未启用立即补充，可选择排到下一轮。' : controller.capability === undefined ? '正在确认立即补充能力…' : 'Enter 补充当前任务 · 在下一次模型调用前读取') : '')
  if (!hint && !controller.error && !controller.history.length && !controller.pending) return null
  return <div className="input-composer__followup" aria-label="当前任务补充状态">
    {controller.error ? <p role="alert">{controller.error}</p> : null}
    {hint ? <p role="status">{hint}</p> : null}
    {controller.pending ? <div className="input-composer__followup-actions">
      <button type="button" className="link" disabled={controller.busy} onClick={() => onResolve(controller.reconcile, controller.pending!.message)}>核对原请求</button>
      {controller.canRetry ? <button type="button" className="link" disabled={controller.busy} onClick={() => onResolve(controller.retry, controller.pending!.message)}>重试原请求</button> : null}
      <details><summary>查看待核对原文</summary><pre>{controller.pending.message}</pre></details>
      <ControllerTrackingRecovery message={controller.pending.message} disabled={controller.busy} onForget={controller.forgetTracking} />
    </div> : null}
    {active && controller.capability === false ? <button type="button" className="link" disabled={controller.busy} onClick={controller.refresh}>重新检查能力</button> : null}
    {controller.history.length ? <details className="input-composer__followup-history"><summary>补充记录 · {controller.history.length}</summary>
      {controller.history.map(item => <article key={item.requestKey}>
        <span>{controllerSavedStatus(item)}</span><pre>{item.message}</pre>
        <div className="input-composer__followup-actions">
          {item.kind === 'accepted' ? <button type="button" className="link" disabled={controller.busy} onClick={() => void controller.queryHistory(item)}>查询原回执</button> : null}
          <button type="button" className="link" disabled={!canRestore || controller.busy || Boolean(controller.pending)} onClick={() => onRestore(item.message)}>放回输入框</button>
        </div>
      </article>)}
    </details> : null}
  </div>
}
