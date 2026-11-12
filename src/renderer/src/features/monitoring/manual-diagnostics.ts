/** A page gets one initial read. Visibility restores never become a polling
 * mechanism; only an explicit refresh can replace an already requested sample. */
export function createManualDiagnosticsReader<T>(options: {
  current: () => boolean
  read: (refresh: boolean) => Promise<T>
  publish: (value: T) => void
  error: (cause: unknown) => void
  busy: (value: boolean) => void
}) {
  let visible = false, attempted = false, disposed = false, generation = 0
  let pending: Promise<void> | undefined
  const live = () => !disposed && visible && options.current()
  const read = (refresh: boolean): Promise<void> => {
    if (!live()) return Promise.resolve()
    if (pending) return pending
    attempted = true
    const epoch = generation
    options.busy(true)
    pending = Promise.resolve().then(async () => {
      if (!live() || epoch !== generation) return
      try {
        const value = await options.read(refresh)
        if (live() && epoch === generation) options.publish(value)
      } catch (cause) {
        if (live() && epoch === generation) options.error(cause)
      }
    }).finally(() => {
      pending = undefined
      if (!disposed && options.current()) options.busy(false)
    })
    return pending
  }
  return {
    setVisible(value: boolean) {
      if (disposed || visible === value) return
      visible = value
      if (!value) generation++
      else if (!attempted) void read(false)
    },
    refresh: () => read(true),
    dispose() { disposed = true; visible = false; generation++ }
  }
}
