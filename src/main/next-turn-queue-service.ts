import { randomUUID } from 'node:crypto'
import { createQueueCapabilityFence, revokeQueueCapability, type QueueAuthorityCheck } from './next-turn-queue-authority-fence'
import {
  NextTurnQueueError,
  type NextTurnQueueScope,
  type NextTurnQueueUserMutation,
  type NextTurnQueueOwnerMutation,
  type QueueCommitResult
} from '../shared/next-turn-queue'
import {
  assertQueueJsonValue,
  assertQueueScope,
  queueScopeIdentity,
  sameQueueScope
} from '../shared/next-turn-queue-state'
import type { QueueStoreRead } from './next-turn-queue-store'
import type { NextTurnQueueRepository } from './next-turn-queue-repository'

export interface TrustedQueueAuthorityLease {
  scope: NextTurnQueueScope
  generation: string
}
export interface TrustedQueueAuthority {
  /** Main-process owner resolves authenticated account/namespace/task facts, never renderer-reported scope. */
  capture(taskId: string): Promise<TrustedQueueAuthorityLease>
  /** Synchronous fence used immediately before filesystem publication. */
  assertCurrent(lease: TrustedQueueAuthorityLease): void
}
declare const queueCapabilityBrand: unique symbol
export interface QueueOwnerCapability {
  readonly [queueCapabilityBrand]: true
}
interface Binding {
  lease: TrustedQueueAuthorityLease
  scope: NextTurnQueueScope
  serviceGeneration: number
  fence: SharedArrayBuffer
  operations: Set<Promise<unknown>>
}
export interface NextTurnQueueServiceLimits {
  maxOwnedOperations: number
  maxPendingMutationBytes: number
}
const DEFAULT_SERVICE_LIMITS: Readonly<NextTurnQueueServiceLimits> = Object.freeze({
  maxOwnedOperations: 128,
  maxPendingMutationBytes: 16 * 1024 * 1024
})

/** No IPC exports are installed. Capabilities are object identities owned by this service instance. */
export class NextTurnQueueMutationService {
  private readonly bindings = new WeakMap<object, Binding>()
  private readonly activeBindings = new Set<object>()
  // Weak tombstones preserve idempotent release joins without retaining capabilities.
  private readonly releases = new WeakMap<object, Promise<void>>()
  private readonly mutations = new Map<string, Promise<unknown>>()
  private readonly operations = new Set<Promise<unknown>>()
  private generation = 0
  private closing = false
  private closePromise: Promise<void> | undefined
  private pendingMutationBytes = 0
  private readonly serviceLimits: Readonly<NextTurnQueueServiceLimits>
  constructor(
    private readonly store: NextTurnQueueRepository,
    private readonly authority: TrustedQueueAuthority,
    private readonly maxBindings = 200,
    serviceLimits: NextTurnQueueServiceLimits = DEFAULT_SERVICE_LIMITS
  ) {
    if (!Number.isSafeInteger(maxBindings) || maxBindings < 1)
      throw new NextTurnQueueError('INVALID', 'Capability budget is invalid')
    for (const key of ['maxOwnedOperations', 'maxPendingMutationBytes'] as const)
      if (!Number.isSafeInteger(serviceLimits[key]) || serviceLimits[key] < 1)
        throw new NextTurnQueueError('INVALID', 'Owned operation budget is invalid')
    this.serviceLimits = Object.freeze({ ...serviceLimits })
  }
  private owned<T>(operation: () => Promise<T>, pendingBytes = 0): Promise<T> {
    if (this.closing)
      return Promise.reject(new NextTurnQueueError('AUTHORITY', 'Queue owner is closing'))
    if (
      this.operations.size >= this.serviceLimits.maxOwnedOperations ||
      this.pendingMutationBytes + pendingBytes > this.serviceLimits.maxPendingMutationBytes
    )
      return Promise.reject(
        new NextTurnQueueError(
          'CAPACITY',
          'Owned queue operation or pending draft byte budget exceeded'
        )
      )
    this.pendingMutationBytes += pendingBytes
    const current = Promise.resolve().then(operation)
    this.operations.add(current)
    const joined = () => {
      this.operations.delete(current)
      this.pendingMutationBytes -= pendingBytes
    }
    current.then(joined, joined)
    return current
  }
  bind(taskId: string, expectedLease?: TrustedQueueAuthorityLease): Promise<QueueOwnerCapability> {
    return this.owned(async () => {
      if (this.closing) throw new NextTurnQueueError('AUTHORITY', 'Queue owner is closing')
      if (expectedLease) this.authority.assertCurrent(expectedLease)
      const generation = this.generation,
        lease = await this.authority.capture(taskId)
      if (this.closing || generation !== this.generation)
        throw new NextTurnQueueError('AUTHORITY', 'Queue owner changed during binding')
      assertQueueScope(lease.scope)
      if (
        lease.scope.taskId !== taskId ||
        typeof lease.generation !== 'string' ||
        !lease.generation
      )
        throw new NextTurnQueueError(
          'AUTHORITY',
          'Authority lease does not match the requested task'
        )
      this.authority.assertCurrent(lease)
      if (expectedLease) {
        this.authority.assertCurrent(expectedLease)
        if (lease.generation !== expectedLease.generation || !sameQueueScope(lease.scope, expectedLease.scope))
          throw new NextTurnQueueError('AUTHORITY', 'Queue authority changed before capability binding')
      }
      if (this.activeBindings.size >= this.maxBindings)
        throw new NextTurnQueueError(
          'CAPACITY',
          'Queue capability budget exceeded; release inactive task bindings'
        )
      const capability = Object.freeze({}) as QueueOwnerCapability
      this.bindings.set(capability, {
        lease,
        scope: structuredClone(lease.scope),
        serviceGeneration: generation, fence: createQueueCapabilityFence(), operations: new Set()
      })
      this.activeBindings.add(capability)
      return capability
    })
  }
  release(capability: QueueOwnerCapability): Promise<void> {
    const previous = this.releases.get(capability)
    if (previous) return previous
    const binding = this.bindings.get(capability)
    if (binding) revokeQueueCapability(binding.fence)
    this.bindings.delete(capability)
    this.activeBindings.delete(capability)
    // Revocation is synchronous, while every repeated ACK joins the original
    // captured operations. Mutation errors remain on their owning call/result.
    const released = Promise.allSettled([...(binding?.operations ?? [])]).then(() => {})
    if (capability && typeof capability === 'object') this.releases.set(capability, released)
    return released
  }
  private capabilityOwned<T>(capability: QueueOwnerCapability, operation: () => Promise<T>, bytes = 0): Promise<T> {
    const binding = this.bindings.get(capability), current = this.owned(operation, bytes)
    binding?.operations.add(current)
    const joined = (): void => { binding?.operations.delete(current) }
    current.then(joined, joined)
    return current
  }
  private check(capability: QueueOwnerCapability): QueueAuthorityCheck {
    const binding = this.binding(capability)
    return Object.assign(() => { this.binding(capability) }, { capabilityFence: binding.fence })
  }
  private binding(capability: QueueOwnerCapability): Binding {
    const binding =
      capability && typeof capability === 'object' ? this.bindings.get(capability) : undefined
    if (!binding || this.closing || binding.serviceGeneration !== this.generation)
      throw new NextTurnQueueError(
        'AUTHORITY',
        'Queue capability is missing, released, copied or from another owner'
      )
    this.authority.assertCurrent(binding.lease)
    if (!sameQueueScope(binding.scope, binding.lease.scope))
      throw new NextTurnQueueError('AUTHORITY', 'Authority scope changed after binding')
    return binding
  }
  private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this.mutations.set(key, current)
    try {
      return await current
    } finally {
      if (this.mutations.get(key) === current) this.mutations.delete(key)
    }
  }
  read(capability: QueueOwnerCapability): Promise<QueueStoreRead> {
    return this.capabilityOwned(capability, async () => {
      const binding = this.binding(capability),
        result = await this.store.read(binding.scope)
      this.binding(capability)
      return result
    })
  }
  mutate(
    capability: QueueOwnerCapability,
    expectedRevision: number,
    operationId: string,
    operation: NextTurnQueueUserMutation
  ): Promise<QueueCommitResult> {
    let captured: NextTurnQueueUserMutation
    let pendingBytes: number
    try {
      assertQueueJsonValue(operation, this.store.limits.maxStateBytes + 8192)
      pendingBytes = Buffer.byteLength(JSON.stringify(operation), 'utf8')
      captured = structuredClone(operation)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.capabilityOwned(capability, async () => {
      const binding = this.binding(capability)
      // Recovery is owner-only, even if an untyped caller bypasses the user-mutation union.
      if (
        !captured ||
        typeof captured !== 'object' ||
        !['enqueue', 'edit', 'move', 'remove', 'clear-pending', 'pause', 'resume'].includes(
          captured.kind
        )
      )
        throw new NextTurnQueueError(
          'AUTHORITY',
          'Lifecycle mutation requires the trusted recovery owner'
        )
      return this.serialized(queueScopeIdentity(binding.scope), () =>
        this.store.mutate(binding.scope, expectedRevision, operationId, captured, this.check(capability))
      )
    }, pendingBytes)
  }
  recover(capability: QueueOwnerCapability, at: number): Promise<QueueStoreRead> {
    return this.capabilityOwned(capability, async () => {
      const binding = this.binding(capability)
      return this.serialized(queueScopeIdentity(binding.scope), async () => {
        const current = await this.store.read(binding.scope)
        this.binding(capability)
        if (!current.state.entries.some((entry) => entry.phase === 'dispatching')) return current
        await this.store.mutate(
          binding.scope,
          current.state.revision,
          'recovery-' + randomUUID(),
          { kind: 'recover-interrupted-submissions', at },
          this.check(capability)
        )
        const recovered = await this.store.read(binding.scope)
        this.binding(capability)
        return recovered
      })
    })
  }
  /** Trusted dispatcher only; the IPC adapter exposes user mutations separately. */
  transition(capability: QueueOwnerCapability, expectedRevision: number, operationId: string, operation: NextTurnQueueOwnerMutation): Promise<QueueCommitResult> {
    assertQueueJsonValue(operation, this.store.limits.maxStateBytes + 8192)
    const captured = structuredClone(operation)
    return this.capabilityOwned(capability, async () => {
      const binding = this.binding(capability)
      return this.serialized(queueScopeIdentity(binding.scope), () => this.store.mutate(
        binding.scope, expectedRevision, operationId, captured, this.check(capability)
      ))
    }, Buffer.byteLength(JSON.stringify(captured)))
  }
  findReceipt(capability: QueueOwnerCapability, operationId: string) {
    return this.capabilityOwned(capability, async () => {
      const binding = this.binding(capability),
        result = await this.store.findReceipt(binding.scope, operationId)
      this.binding(capability)
      return result
    })
  }
  findCommitted(capability: QueueOwnerCapability, operationId: string) {
    return this.capabilityOwned(capability, async () => {
      const binding = this.binding(capability), result = await this.store.findCommitted(binding.scope, operationId)
      this.binding(capability); return result
    })
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    for (const capability of this.activeBindings) { const binding = this.bindings.get(capability); if (binding) revokeQueueCapability(binding.fence) }
    this.generation++
    // Include reads and in-flight authority capture: closed ACK must mean every owned operation has joined.
    this.closePromise = Promise.allSettled([...this.operations]).then(() => {
      this.activeBindings.clear()
    })
    return this.closePromise
  }
  diagnostics(): {
    bindings: number
    mutationBuckets: number
    ownedOperations: number
    pendingMutationBytes: number
    closing: boolean
  } {
    return {
      bindings: this.activeBindings.size,
      mutationBuckets: this.mutations.size,
      ownedOperations: this.operations.size,
      pendingMutationBytes: this.pendingMutationBytes,
      closing: this.closing
    }
  }
}
