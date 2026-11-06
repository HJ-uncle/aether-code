/** Manual monitor lifecycle: no clock/polling dependency, one entry read,
 * single-flight refresh, hidden/source-change late results cannot be displayed. */
import { expect, test } from '@playwright/test'
import { createManualDiagnosticsReader } from '../src/renderer/src/contrib/work/manual-diagnostics'

const turn = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('enter once, hide/show stays quiet, explicit refresh passes force and coalesces', async () => {
  const calls: boolean[] = [], values: number[] = [], busy: boolean[] = []
  let complete!: (value: number) => void
  const reader = createManualDiagnosticsReader({ current: () => true,
    read: refresh => { calls.push(refresh); return new Promise<number>(resolve => { complete = resolve }) },
    publish: value => values.push(value), error: cause => { throw cause }, busy: value => busy.push(value) })
  reader.setVisible(true); await turn(); expect(calls).toEqual([false])
  complete(1); await turn(); expect(values).toEqual([1])
  reader.setVisible(false); reader.setVisible(true); await turn(); expect(calls).toEqual([false])
  const first = reader.refresh(), duplicate = reader.refresh()
  expect(duplicate).toBe(first); await turn(); expect(calls).toEqual([false, true])
  complete(2); await first; expect(values).toEqual([1, 2]); expect(busy).toEqual([true, false, true, false])
  reader.dispose()
})

test('hide discards an in-flight result and showing again does not secretly reread', async () => {
  let calls = 0, complete!: (value: string) => void
  const values: string[] = [], busy: boolean[] = []
  const reader = createManualDiagnosticsReader({ current: () => true,
    read: () => { calls++; return new Promise<string>(resolve => { complete = resolve }) },
    publish: value => values.push(value), error: cause => { throw cause }, busy: value => busy.push(value) })
  reader.setVisible(true); await turn(); reader.setVisible(false); reader.setVisible(true)
  complete('late'); await turn(); expect(values).toEqual([]); expect(calls).toBe(1); expect(busy.at(-1)).toBe(false)
  const refresh = reader.refresh(); await turn(); complete('current'); await refresh
  expect(values).toEqual(['current']); reader.dispose()
})

test('engine switch or disposal rejects stale success and error without a follow-up request', async () => {
  let current = true, reject!: (cause: unknown) => void, calls = 0
  const outputs: unknown[] = []
  const reader = createManualDiagnosticsReader({ current: () => current,
    read: () => { calls++; return new Promise<unknown>((_resolve, fail) => { reject = fail }) },
    publish: value => outputs.push(value), error: cause => outputs.push(cause), busy: () => {} })
  reader.setVisible(true); await turn(); current = false; reader.dispose(); reject(new Error('old engine'))
  await turn(); reader.setVisible(true); await reader.refresh(); expect(calls).toBe(1); expect(outputs).toEqual([])
})
