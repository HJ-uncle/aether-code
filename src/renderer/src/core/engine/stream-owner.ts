export interface StreamOwner {
  source: number
  sessionId: string
  profile: 'code' | 'general'
}

/** IPC stream IDs are opaque. Retain a bounded ownership index so background
 * invalidations cannot wake a different session or an old engine connection. */
const owners = new Map<string, StreamOwner>()
let generation: number | undefined
export function registerStreamOwner(streamId: string, owner: StreamOwner): void {
  if (generation !== owner.source) { owners.clear(); generation = owner.source }
  owners.delete(streamId)
  owners.set(streamId, owner)
  while (owners.size > 128) owners.delete(owners.keys().next().value!)
}
export function getStreamOwner(streamId: string, source: number): StreamOwner | undefined {
  const owner = owners.get(streamId)
  return owner?.source === source ? owner : undefined
}
