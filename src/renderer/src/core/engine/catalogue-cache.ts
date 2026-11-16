interface CatalogueEntry<T> {
  value?: T
  expiresAt: number
  pending?: Promise<T>
}

/** Small display catalogues only; never retain plugin source, runs or session history. */
export class CatalogueCache<T> {
  private readonly entries = new Map<string, CatalogueEntry<T>>()
  private readonly listeners = new Set<() => void>()
  private revision = 0

  constructor(private readonly capacity = 32, private readonly ttlMs = 30_000, private readonly now = Date.now) {}

  readonly getRevision = (): number => this.revision
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  peek(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry || entry.value === undefined || entry.expiresAt <= this.now()) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  load(key: string, fetchValue: () => Promise<T>): Promise<T> {
    const cached = this.peek(key)
    if (cached !== undefined) return Promise.resolve(cached)
    const pending = this.entries.get(key)?.pending
    if (pending) return pending
    const entry: CatalogueEntry<T> = { expiresAt: 0 }
    this.entries.set(key, entry)
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!)
    // A removed/replaced entry must never repopulate the cache when a late request completes.
    entry.pending = Promise.resolve().then(fetchValue).then(value => {
      if (this.entries.get(key) === entry) {
        entry.value = value
        entry.expiresAt = this.now() + this.ttlMs
        entry.pending = undefined
      }
      return value
    }, error => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    })
    return entry.pending
  }

  invalidate(): void {
    this.entries.clear()
    this.revision++
    for (const listener of this.listeners) listener()
  }
}
