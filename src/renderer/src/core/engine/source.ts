import type { EngineSnapshot } from '@shared/ipc'

type SourceSnapshot = Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId' | 'phase'>
let snapshot: SourceSnapshot = { mode: 'embedded', baseUrl: '', phase: 'idle' }
let generation = 0
let storageSource = ''
const listeners = new Set<() => void>()

/** Transport identities expire at restart; persisted preferences keep the endpoint identity. */
export function engineConnectionKey(value: SourceSnapshot): string {
  return JSON.stringify([value.mode, value.baseUrl.replace(/\/+$/, ''), value.instanceId ?? null])
}
export function engineStorageKey(value: Pick<SourceSnapshot, 'mode' | 'baseUrl'>): string {
  return value.mode === 'embedded' ? '' : 'remote:' + value.baseUrl.replace(/\/+$/, '')
}
export function getEngineStorageKey(): string { return storageSource }
export function getEngineSource(): number { return generation }
export function getExpectedEngine(): Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId'> {
  return { mode: snapshot.mode, baseUrl: snapshot.baseUrl, instanceId: snapshot.instanceId }
}
export function isRemoteEngine(): boolean { return snapshot.mode === 'remote' }
export function isEngineReady(): boolean { return snapshot.phase === 'ready' }
export function assertEngineSource(source: number): void {
  if (source !== generation || !isEngineReady()) throw new Error('引擎连接已变化，请在当前会话重试')
}
export function publishEngineSource(next: SourceSnapshot): void {
  const changed = (next.phase === 'ready' && engineStorageKey(next) !== storageSource) ||
    engineConnectionKey(next) !== engineConnectionKey(snapshot) ||
    (next.phase !== 'ready' && snapshot.phase === 'ready')
  snapshot = next
  if (next.phase === 'ready') storageSource = engineStorageKey(next)
  if (!changed) return
  generation++
  for (const listener of listeners) listener()
}
export function subscribeEngineSource(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function sessionStorageKey(base: string, source = getEngineStorageKey()): string {
  return source ? base + ':' + encodeURIComponent(source) : base
}
