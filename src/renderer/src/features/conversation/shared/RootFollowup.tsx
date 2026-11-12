import { useLayoutEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import { useCollaborationController } from '@renderer/core/engine/useCollaborationController'
import { Popover } from '@renderer/ui/Popover'
import { Select } from '@renderer/ui/Select'
import { Icon } from '@renderer/ui/icons'
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
  return <Select className="input-composer__delivery" ariaLabel="发送方式" title="发送方式"
    placement="up" align="end" width={260} panelClassName="input-composer__delivery-menu"
    value={controller.delivery} disabled={disabled || controller.busy || Boolean(controller.pending)}
    onChange={value => controller.setDelivery(value === 'next' ? 'next' : 'current')}
    options={[
      { value: 'current', label: '立即补充', description: '补充当前任务，沿用当前模型和设置' },
      { value: 'next', label: '排到下一轮', description: '当前任务结束后发送，可单独选择模型' }
    ]} />
}

/** A reserved row outside the editor keeps asynchronous receipts from moving
 * the draft. Full errors and recovery stay accessible in an anchored panel. */
export function RootFollowupFeedback({ controller, active, limitation, canRestore, onRestore, onResolve, fallbackHint, footerAction, onFocusInput }: {
  controller: ReturnType<typeof useRootFollowup>; active: boolean; limitation: string
  canRestore: boolean; onRestore: (message: string) => void
  onResolve: (operation: () => Promise<boolean>, message: string) => void
  fallbackHint: string; footerAction?: ReactNode
  onFocusInput: () => void
}): JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsButton = useRef<HTMLButtonElement>(null)
  const detailsCloseButton = useRef<HTMLButtonElement>(null)
  const hint = controller.error || controller.notice || (active && controller.delivery === 'current'
    ? limitation || (controller.capability === false ? '当前引擎未启用立即补充，可选择排到下一轮。' : controller.capability === undefined ? '正在确认立即补充能力…' : 'Enter 补充当前任务 · Shift + Enter 换行') : '') || fallbackHint
  const needsDetails = Boolean(controller.error || controller.pending || controller.restoredDraft || (active && controller.capability === false))
  const closeDetails = (): void => {
    setDetailsOpen(false)
    if (needsDetails) detailsButton.current?.focus({ preventScroll: true })
    else onFocusInput()
  }
  useLayoutEffect(() => {
    if (!detailsOpen || needsDetails) return
    const focused = document.activeElement
    const panel = detailsCloseButton.current?.closest('[role="dialog"]')
    setDetailsOpen(false)
    // Successful delivery or a new root must not leave a stale recovery
    // entry behind, or steal focus from a draft the user has already resumed.
    if (focused === detailsButton.current || focused && panel?.contains(focused)) onFocusInput()
  }, [detailsOpen, needsDetails, onFocusInput])
  useFeedbackPopoverFocus(detailsOpen, detailsButton, detailsCloseButton)
  return <div className="input-composer__followup" aria-label="当前任务补充状态">
    <div className="input-composer__followup-row">
      <p role={controller.error ? 'alert' : 'status'} title={hint}>{hint}</p>
      {footerAction}
      {needsDetails || detailsOpen ? <Popover placement="up" align="end" width={380} flush label="补充详情"
        panelClassName="root-followup-details" open={detailsOpen} onOpenChange={setDetailsOpen}
        trigger={({ open }) => <button ref={detailsButton} type="button" className="input-composer__history-button"
          aria-haspopup="dialog" aria-expanded={open}>
          <Icon name={controller.pending || controller.error ? 'alert-circle' : 'info'} size={14} />
          <span>{controller.pending ? '核对补充' : '查看详情'}</span>
        </button>}>
        <div onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDetails() } }}>
          <div className="root-followup-history__header"><strong>{controller.pending ? '核对补充' : '补充详情'}</strong>
            <button ref={detailsCloseButton} type="button" className="ui-icon-button" aria-label="关闭补充详情" onClick={closeDetails}><Icon name="close" size={14} /></button>
          </div>
          <div className="root-followup-details__body">
            <p>{hint}</p>
            {controller.pending ? <>
              <div className="input-composer__followup-actions">
                <button type="button" className="btn btn--sm" disabled={controller.busy} onClick={() => { closeDetails(); onResolve(controller.reconcile, controller.pending!.message) }}>核对原请求</button>
                {controller.canRetry ? <button type="button" className="btn btn--sm" disabled={controller.busy} onClick={() => { closeDetails(); onResolve(controller.retry, controller.pending!.message) }}>重试原请求</button> : null}
              </div>
              <details><summary>查看待核对原文</summary><pre>{controller.pending.message}</pre></details>
              <ControllerTrackingRecovery message={controller.pending.message} disabled={controller.busy} onForget={async () => {
                const cleared = await controller.forgetTracking()
                if (cleared) { setDetailsOpen(false); onFocusInput() }
                return cleared
              }} />
            </> : null}
            {controller.restoredDraft && !controller.pending ? <>
              <details><summary>查看待恢复原文</summary><pre>{controller.restoredDraft.message}</pre></details>
              <button type="button" className="btn btn--sm" disabled={!canRestore || controller.busy} onClick={() => {
                if (!canRestore || controller.busy || controller.pending || !controller.restoredDraft) return
                const message = controller.restoredDraft.message
                setDetailsOpen(false)
                onRestore(message)
              }}>放回输入框</button>
            </> : null}
            {active && controller.capability === false ? <button type="button" className="btn btn--sm" disabled={controller.busy} onClick={() => { closeDetails(); controller.refresh() }}>重新检查能力</button> : null}
          </div>
        </div>
      </Popover> : null}
    </div>
  </div>
}

/** Portalled panels start hidden for measurement; native autoFocus runs before
 * that measurement. Focus once visible, without stealing a later user action. */
function useFeedbackPopoverFocus(open: boolean, trigger: RefObject<HTMLButtonElement | null>, close: RefObject<HTMLButtonElement | null>): void {
  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    const focus = (): void => {
      if (document.activeElement !== trigger.current) return
      const button = close.current
      if (!button || getComputedStyle(button).visibility === 'hidden' || !button.getClientRects().length) {
        frame = requestAnimationFrame(focus)
        return
      }
      button.focus({ preventScroll: true })
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [open, trigger, close])
}
