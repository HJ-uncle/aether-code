import type { EngineFileChange } from '@shared/ipc'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import type { WorkArtifactTurnScope } from './work-session-artifacts'
import { workChangePathKey } from './work-file-changes'
import { workProgressChanges, type WorkProgressChange } from './work-progress-state'

export interface WorkTurnProgressGroup {
  id: string
  messages: readonly ChatMessage[]
}

const identity = (value: string | undefined): string | undefined => value?.trim() ? value : undefined
const ownedMessage = (sessionId: string, message: ChatMessage): boolean => !message.run || message.run.sessionId === sessionId

function groupTurnIds(sessionId: string, group: WorkTurnProgressGroup): Set<string> {
  const turns = new Set<string>()
  for (const message of group.messages) {
    if (!ownedMessage(sessionId, message)) continue
    for (const turnId of [message.conversationId, message.run?.turnId]) {
      if (identity(turnId)) turns.add(turnId!)
    }
  }
  return turns
}

/** The workspace can promise a turn filter only when its durable identity is known. */
export function workProgressTurnScope(sessionId: string, group: WorkTurnProgressGroup): WorkArtifactTurnScope {
  const turns = sessionId ? groupTurnIds(sessionId, group) : new Set<string>()
  return turns.size === 1 ? { kind: 'turn', turnId: [...turns][0] } : { kind: 'unassociated' }
}

type OwnerIndex = Map<string, Set<number>>
function addOwner(index: OwnerIndex, id: string | undefined, owner: number): void {
  if (!identity(id)) return
  const owners = index.get(id!) ?? new Set<number>()
  owners.add(owner)
  index.set(id!, owners)
}

/** Associate receipts through identities, never path, arrival time or the last visible turn. */
export function workTurnProgressChanges(
  sessionId: string,
  groups: readonly WorkTurnProgressGroup[],
  files: readonly WorkProgressChange[],
  root?: string | null
): Map<string, WorkProgressChange[]> {
  const result = new Map<string, WorkProgressChange[]>()
  if (!sessionId) return result
  const turns: OwnerIndex = new Map(), runs: OwnerIndex = new Map(), tools: OwnerIndex = new Map()
  const groupIds: OwnerIndex = new Map()
  for (const [owner, group] of groups.entries()) {
    addOwner(groupIds, group.id, owner)
    for (const turn of groupTurnIds(sessionId, group)) addOwner(turns, turn, owner)
    for (const message of group.messages) {
      if (!ownedMessage(sessionId, message)) continue
      addOwner(runs, message.runId, owner)
      addOwner(runs, message.run?.runId, owner)
      for (const tool of message.tools) addOwner(tools, tool.id, owner)
    }
  }
  const oneOwner = (owners: Set<number>): number | undefined => {
    if (owners.size !== 1) return undefined
    const owner = [...owners][0]
    return groupIds.get(groups[owner].id)?.size === 1 ? owner : undefined
  }
  const explicitOwner = (turnId: string): number | undefined => {
    const owner = oneOwner(turns.get(turnId) ?? new Set())
    if (owner === undefined) return undefined
    const scope = workProgressTurnScope(sessionId, groups[owner])
    return scope.kind === 'turn' && scope.turnId === turnId ? owner : undefined
  }
  const directOwners = (change: EngineFileChange): Set<number> | null => {
    // A known identity whose message is not loaded is not a legacy receipt.
    // In particular, a new observer must not inherit an older command's writes.
    if (identity(change.runId) && !runs.has(change.runId!) || identity(change.toolCallId) && !tools.has(change.toolCallId!)) return null
    return new Set([...(runs.get(change.runId ?? '') ?? []), ...(tools.get(change.toolCallId ?? '') ?? [])])
  }
  const receipts = new Map<string, Array<{ owner?: number; change: EngineFileChange }>>()
  for (const [messageOwner, group] of groups.entries()) {
    for (const message of group.messages) {
      if (!ownedMessage(sessionId, message)) continue
      for (const tool of message.tools) {
        const attached = [tool.change, ...tool.changes ?? [],
          ...(tool.commandJob?.sessionId === sessionId ? tool.commandJob.changes ?? [] : [])]
        for (const change of attached) {
          if (!change || change.sessionId && change.sessionId !== sessionId) continue
          const direct = directOwners(change)
          // A later command observation may repeat an older receipt. Its own
          // turn/run/tool identities take precedence over the observing message.
          const owner = identity(change.turnId) ? explicitOwner(change.turnId!)
            : direct === null ? undefined : direct.size ? oneOwner(direct) : messageOwner
          const origins = receipts.get(change.id) ?? []
          origins.push({ owner, change })
          receipts.set(change.id, origins)
        }
      }
    }
  }
  const assigned = new Map<number, EngineFileChange[]>()
  for (const file of files) for (const change of file.records) {
    if (change.sessionId && change.sessionId !== sessionId) continue
    let owner: number | undefined
    if (identity(change.turnId)) owner = explicitOwner(change.turnId!)
    else {
      const candidates = directOwners(change)
      if (candidates === null) continue
      const origins = receipts.get(change.id) ?? []
      // A reused ID with a different path/kind is not an ownership link. A
      // conflicting or unloaded explicit origin must not become a legacy fallback.
      if (origins.some(origin => origin.owner === undefined || origin.change.kind !== change.kind ||
        workChangePathKey(origin.change.path, root) !== workChangePathKey(change.path, root))) continue
      for (const origin of origins) candidates.add(origin.owner!)
      owner = oneOwner(candidates)
    }
    if (owner === undefined) continue
    const changes = assigned.get(owner) ?? []
    // Legacy streamed receipts inherit this session only after proving a message
    // owner. Preserve the already merged keep/revert decision and original input.
    changes.push({ ...change, sessionId })
    assigned.set(owner, changes)
  }
  for (const [owner, changes] of assigned) result.set(groups[owner].id, workProgressChanges(sessionId, [], changes, root))
  return result
}
