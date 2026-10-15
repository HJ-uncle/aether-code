export interface WorkbenchVisibilityPorts {
  hidden: () => boolean
  onDocument: (listener: () => void) => () => void
  readNative: () => Promise<boolean>
  onNative: (listener: (visible: boolean) => void) => () => void
}

/** One ref-counted subscription, no timers. Unknown native state is paused. */
export function createWorkbenchVisibility(ports: WorkbenchVisibilityPorts) {
  const listeners = new Set<() => void>()
  let visible = false, nativeVisible = false, generation = 0, revision = 0
  let release: (() => void) | undefined
  const publish = (): void => {
    const next = nativeVisible && !ports.hidden()
    if (next === visible) return
    visible = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => visible,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) {
        const current = ++generation
        nativeVisible = false
        const offNative = ports.onNative(value => { if (current !== generation) return; revision++; nativeVisible = value; publish() })
        const offDocument = ports.onDocument(() => { if (current === generation) publish() })
        release = () => { offNative(); offDocument() }
        const requestedAt = revision
        // Subscribe first. A newer native event wins over a late initial read.
        void ports.readNative().then(value => {
          if (current !== generation || requestedAt !== revision) return
          nativeVisible = value
          publish()
        }).catch(() => { /* No native authority means collection remains paused. */ })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size !== 0) return
        generation++
        release?.(); release = undefined
        nativeVisible = false; visible = false
      }
    }
  }
}
