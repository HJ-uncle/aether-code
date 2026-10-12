export interface DraftPersistenceClock {
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

/** Continuous typing needs a bounded save deadline as well as a pause debounce. */
export function createDraftPersistenceScheduler(
  commit: () => void,
  clock: DraftPersistenceClock = {
    // Chromium requires the native timer receiver to stay on the global object.
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer)
  }
): { schedule: () => void; flush: () => void; cancel: () => void } {
  let debounce: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const cancel = (): void => {
    if (debounce !== undefined) clock.clearTimeout(debounce)
    if (deadline !== undefined) clock.clearTimeout(deadline)
    debounce = deadline = undefined
  }
  const flush = (): void => {
    if (debounce === undefined && deadline === undefined) return
    cancel()
    commit()
  }
  return {
    schedule: () => {
      if (debounce !== undefined) clock.clearTimeout(debounce)
      debounce = clock.setTimeout(flush, 300)
      deadline ??= clock.setTimeout(flush, 2000)
    },
    flush,
    cancel
  }
}
