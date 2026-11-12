/** Keep one read in flight across visibility/identity effect replacements.
 * When an old owner finishes, wake the current owner instead of waiting for
 * the next polling interval. Disposed owners can neither restart nor clear it. */
export function createMonitorReadFlight() {
  let pending: object | null = null
  let current: { owner: object; wake: () => void } | null = null
  return {
    bind(wake: () => void) {
      const owner = {}
      current = { owner, wake }
      return {
        acquire(): (() => void) | null {
          if (current?.owner !== owner || pending) return null
          const flight = {}
          pending = flight
          let finished = false
          return () => {
            if (finished || pending !== flight) return
            finished = true
            pending = null
            if (current && current.owner !== owner) current.wake()
          }
        },
        dispose() { if (current?.owner === owner) current = null }
      }
    }
  }
}
