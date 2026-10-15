/** Pure native + DOM visibility contract: shared listeners, initial-read races
 * and disposed generations must never resume hidden workbench collectors. */
import { expect, test } from '@playwright/test'
import { createWorkbenchVisibility } from '../src/renderer/src/core/platform/visibility-state'

function fixture() {
  let hidden = false, native: (visible: boolean) => void = () => {}, document: () => void = () => {}
  let nativeReads = 0, nativeSubscriptions = 0, documentSubscriptions = 0
  const pending: Array<(visible: boolean) => void> = []
  const natives: Array<(visible: boolean) => void> = []
  const store = createWorkbenchVisibility({
    hidden: () => hidden,
    onNative: listener => { native = listener; natives.push(listener); nativeSubscriptions++; return () => { nativeSubscriptions-- } },
    onDocument: listener => { document = listener; documentSubscriptions++; return () => { documentSubscriptions-- } },
    readNative: () => { nativeReads++; return new Promise<boolean>(done => pending.push(done)) }
  })
  return { store, pending, natives, native: (visible: boolean) => native(visible), document: (value: boolean) => { hidden = value; document() },
    counts: () => ({ nativeReads, nativeSubscriptions, documentSubscriptions }) }
}

test('unknown stays paused; all collectors share one native read and two listeners', async () => {
  const f = fixture(), changes: boolean[] = []
  expect(f.store.getSnapshot()).toBe(false)
  const offOne = f.store.subscribe(() => changes.push(f.store.getSnapshot())), offTwo = f.store.subscribe(() => {})
  expect(f.counts()).toEqual({ nativeReads: 1, nativeSubscriptions: 1, documentSubscriptions: 1 })
  f.pending[0](true); await Promise.resolve()
  expect(f.store.getSnapshot()).toBe(true)
  f.document(true); expect(f.store.getSnapshot()).toBe(false)
  f.native(false); f.document(false); expect(f.store.getSnapshot()).toBe(false)
  f.native(true); expect(f.store.getSnapshot()).toBe(true)
  expect(changes).toEqual([true, false, true])
  offOne(); expect(f.counts().nativeSubscriptions).toBe(1)
  offTwo(); expect(f.counts()).toEqual({ nativeReads: 1, nativeSubscriptions: 0, documentSubscriptions: 0 })
  expect(f.store.getSnapshot()).toBe(false)
})

test('a newer hide event wins over a delayed visible initial reply', async () => {
  const f = fixture(), off = f.store.subscribe(() => {})
  f.native(false); f.pending[0](true); await Promise.resolve()
  expect(f.store.getSnapshot()).toBe(false)
  off()
})

test('unmounted reads and callbacks cannot change a later subscription generation', async () => {
  const f = fixture(), off = f.store.subscribe(() => {})
  off(); const offCurrent = f.store.subscribe(() => {})
  f.pending[0](true); await Promise.resolve()
  expect(f.store.getSnapshot()).toBe(false)
  f.pending[1](true); await Promise.resolve()
  expect(f.store.getSnapshot()).toBe(true)
  f.natives[0](false)
  expect(f.store.getSnapshot()).toBe(true)
  expect(f.counts()).toEqual({ nativeReads: 2, nativeSubscriptions: 1, documentSubscriptions: 1 })
  offCurrent()
})
