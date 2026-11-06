import { controllerNeedsDeliveryRefresh, type ControllerSavedRecord } from './collaboration-contract'

/** A new root does not retire the older root's accepted receipts. Every read
 * still uses the frozen run, attempt and request key stored on that record. */
export function controllerDeliveryRecords(records: readonly ControllerSavedRecord[], target: {
  storageIdentity: string; rootSessionId: string; kind: 'root' | 'child'; childSessionId?: string
}): ControllerSavedRecord[] {
  return records.filter(item => item.storageIdentity === target.storageIdentity && item.rootSessionId === target.rootSessionId
    && (item.targetKind ?? 'child') === target.kind && item.childSessionId === target.childSessionId)
}

/** Receipt refresh is a read loop, separate from the composer send lock. */
export function startControllerDeliveryRefresh(options: {
  records(): ControllerSavedRecord[]
  current(): boolean
  busy(): boolean
  inspect(record: ControllerSavedRecord, assertCurrent: () => void): Promise<ControllerSavedRecord>
  onResult(record: ControllerSavedRecord): void
  onError(error: unknown): void
  schedule?(action: () => void, delay: number): ReturnType<typeof setTimeout>
  cancel?(timer: ReturnType<typeof setTimeout>): void
}): () => void {
  let disposed = false, cursor = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = options.schedule ?? setTimeout, cancel = options.cancel ?? clearTimeout
  const current = () => !disposed && options.current()
  const assertCurrent = () => { if (!current()) throw new Error('回执查询已不属于当前会话') }
  const refresh = async () => {
    try {
      if (!current() || options.busy()) return
      const pending = options.records().filter(controllerNeedsDeliveryRefresh)
      // Bound a refresh pass; rotate to prevent older pending receipts starving newer sends.
      const ordered = pending.length ? [...pending.slice(cursor % pending.length), ...pending.slice(0, cursor % pending.length)].slice(0, 8) : []
      cursor += ordered.length
      for (const record of ordered) {
        if (!current() || options.busy()) break
        const result = await options.inspect(record, assertCurrent)
        if (!current()) break
        options.onResult(result)
      }
    } catch (error) { if (current()) options.onError(error) }
    finally { if (current()) timer = schedule(() => { void refresh() }, 2000) }
  }
  timer = schedule(() => { void refresh() }, 250)
  return () => { disposed = true; if (timer !== undefined) cancel(timer) }
}
