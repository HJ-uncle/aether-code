import { emptyServiceNotifications, type ServiceNotificationState } from './service-model'

/** Rail and sidebar instances share read state while one of them is kept alive. */
export class ServiceNotificationMemory {
  private value = emptyServiceNotifications
  private readonly listeners = new Set<() => void>()
  constructor(private readonly onIdle: () => void = () => {}) {}
  readonly getSnapshot = (): ServiceNotificationState => this.value
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener); this.onIdle() }
  }
  get observed(): boolean { return this.listeners.size > 0 }
  update(change: (previous: ServiceNotificationState) => ServiceNotificationState): void {
    const next = change(this.value)
    if (next === this.value) return
    this.value = next
    for (const listener of this.listeners) listener()
  }
}

/** Global plugin notices follow the app; session notices keep their owning task. */
export class ServiceNotificationStore {
  private readonly scopes = new Map<string, ServiceNotificationMemory>()
  constructor(private readonly retainedScopes = 25) {}
  get size(): number { return this.scopes.size }
  scope(source: number, sessionId: string | null): ServiceNotificationMemory {
    const key = JSON.stringify([source, sessionId])
    const memory = this.scopes.get(key) ?? new ServiceNotificationMemory(() => this.trim())
    this.scopes.delete(key)
    this.scopes.set(key, memory)
    this.trim(key)
    return memory
  }
  clear(): void {
    const previous = [...this.scopes.values()]
    this.scopes.clear()
    for (const memory of previous) memory.update(() => emptyServiceNotifications)
  }
  private trim(keep?: string): void {
    for (const [key, memory] of this.scopes) {
      if (this.scopes.size <= this.retainedScopes) break
      if (key !== keep && !memory.observed) this.scopes.delete(key)
    }
  }
}
