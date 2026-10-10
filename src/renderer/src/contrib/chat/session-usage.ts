import type { ChatMessage } from '@renderer/core/engine/useChat'
import type { SubagentRun } from '@shared/subagent'
import { asUsageFrame, sumUsage, type UsageDetailRow, type UsageTotal } from './usage'

export interface SessionSubagentUsage {
  totalTokens: number
  count: number
  unknown: number
  finishedAt?: number
}

export interface SessionUsageAnchor {
  parent?: Record<string, number>
  children?: SessionSubagentUsage
  visible: UsageTotal
  visibleParent: Record<string, number>
  visibleChildCount: number
  alignedChildren?: ReadonlyMap<string, ChildUsageSnapshot>
}

interface ChildUsageSnapshot {
  totalTokens: number
  unknown: boolean
  lastSeq: number
}

const BILLING_KEYS = [
  'systemPromptTokens', 'systemToolsTokens', 'messagesTokens', 'skillTokens',
  'promptTokens', 'completionTokens', 'totalTokens', 'ragTokens', 'builtinToolsTokens',
  'mcpToolsTokens', 'toolResultsTokens', 'userInputTokens', 'cacheHitTokens',
  'cacheMissTokens', 'reasoningTokens'
] as const

/** Recreate this anchor whenever the same source/session receives a new authoritative snapshot or archive window. */
export function createSessionUsageAnchor(
  messages: ChatMessage[],
  parent?: Record<string, number>,
  children?: SessionSubagentUsage,
  alignedChildRuns?: readonly SubagentRun[]
): SessionUsageAnchor | null {
  const parentUsage = billingUsage(parent)
  const childUsage = children && {
    totalTokens: nonnegative(children.totalTokens),
    count: Math.floor(nonnegative(children.count)),
    unknown: Math.floor(nonnegative(children.unknown)),
    ...(children.finishedAt !== undefined && Number.isFinite(children.finishedAt)
      ? { finishedAt: children.finishedAt } : {})
  }
  if (!parentUsage && !childUsage) return null
  const visible = sumUsage(messages)
  // Live stores can be newer than the snapshot cursor, while old history can
  // be older than authoritative child billing. Pair the baseline with the
  // server's exact run selection instead of either independently sampled view.
  const alignedChildren = alignedChildRuns === undefined ? undefined : childSnapshots(alignedChildRuns)
  return {
    ...(parentUsage ? { parent: parentUsage } : {}),
    ...(childUsage ? { children: childUsage } : {}),
    visible,
    visibleParent: visibleParentUsage(messages),
    visibleChildCount: childCount(messages),
    ...(alignedChildren === undefined ? {} : { alignedChildren })
  }
}

/** The authority already contains the anchor's visible calls; only later observed growth can be added. */
export function sessionUsageTotal(messages: ChatMessage[], anchor?: SessionUsageAnchor | null): UsageTotal {
  if (!anchor) return { ...sumUsage(messages), rounds: loadedRounds(messages) }
  const visible = sumUsage(messages)
  const currentParent = visibleParentUsage(messages)
  const parentUsage = anchor.parent ? { ...anchor.parent } : currentParent
  if (anchor.parent) {
    for (const key of BILLING_KEYS) {
      parentUsage[key] = (anchor.parent[key] ?? 0) + Math.max(0,
        (currentParent[key] ?? 0) - (anchor.visibleParent[key] ?? 0))
    }
  }
  // Reuse the ordinary parent billing breakdown instead of maintaining a second
  // set of summary labels or treating context snapshots as consumption.
  const parent = sumUsage([{
    id: 'session-usage-parent', role: 'assistant', content: '', thinking: '',
    tools: [], items: [], status: 'done', createdAt: 0, usage: parentUsage
  }])
  const alignedGrowth = anchor.alignedChildren === undefined ? undefined
    : childGrowth(messages, anchor.alignedChildren)
  const children = anchor.children && alignedGrowth
    ? {
      totalTokens: anchor.children.totalTokens + alignedGrowth.totalTokens,
      count: anchor.children.count + alignedGrowth.count,
      unknown: Math.max(0, anchor.children.unknown + alignedGrowth.unknown)
    }
    : anchor.children
    ? {
      totalTokens: anchor.children.totalTokens + Math.max(0, visible.subagentTotal - anchor.visible.subagentTotal),
      count: Math.max(0, anchor.children.count + childCount(messages) - anchor.visibleChildCount),
      // A previously unknown run can become known without waiting for another
      // server snapshot. Its known lower bound remains part of totalTokens.
      unknown: Math.max(0, anchor.children.unknown + visible.unknownSubagents - anchor.visible.unknownSubagents)
    }
    : { totalTokens: visible.subagentTotal, count: childCount(messages), unknown: visible.unknownSubagents }
  const summary: UsageDetailRow[] = [...parent.summary]
  if (children.count > 0 || children.totalTokens > 0 || children.unknown > 0) {
    summary.unshift({ label: '主代理自身', group: 'input', tokens: parent.parentTotal })
    summary.push({ label: '子代理（已知用量）', group: 'output', tokens: children.totalTokens })
    if (children.unknown > 0) {
      summary.push({ label: `子代理用量缺失（${children.unknown} 个）`, group: 'output', tokens: 0, unknown: true })
    }
  }
  const startedAt = earliest(anchor.visible.startedAt, visible.startedAt)
  const endedAt = latest(anchor.visible.endedAt, visible.endedAt, anchor.children?.finishedAt)
  return {
    total: parent.parentTotal + children.totalTokens,
    parentTotal: parent.parentTotal,
    subagentTotal: children.totalTokens,
    unknownSubagents: children.unknown,
    input: parent.input,
    output: parent.output,
    rounds: loadedRounds(messages),
    summary,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {})
  }
}

function billingUsage(raw: unknown): Record<string, number> | null {
  const frame = asUsageFrame(raw)
  if (!frame) return null
  const usage: Record<string, number> = {}
  const values = frame as Record<string, number>
  for (const key of BILLING_KEYS) {
    if (values[key] !== undefined && values[key] >= 0) usage[key] = values[key]
  }
  if (!Object.keys(usage).length) return null
  usage.totalTokens ??= (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
  return usage
}

function visibleParentUsage(messages: ChatMessage[]): Record<string, number> {
  const usage: Record<string, number> = {}
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const frame = billingUsage(message.usage)
    if (!frame) continue
    for (const [key, value] of Object.entries(frame)) usage[key] = (usage[key] ?? 0) + value
  }
  return usage
}

function childCount(messages: ChatMessage[]): number {
  const runs = new Set<string>()
  for (const message of messages) for (const tool of message.tools) {
    if (tool.subagent) runs.add(tool.subagent.runId)
  }
  return runs.size
}

function childSnapshots(runs: Iterable<SubagentRun>): Map<string, ChildUsageSnapshot> {
  const snapshots = new Map<string, ChildUsageSnapshot>()
  for (const run of runs) {
    const previous = snapshots.get(run.runId)
    if (previous && previous.lastSeq >= run.lastSeq) continue
    const usage = run.usage
    const tokens = usage.totalTokens ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens : undefined)
    snapshots.set(run.runId, { totalTokens: tokens === undefined ? 0 : nonnegative(tokens),
      unknown: usage.unknown === true || tokens === undefined || !Number.isFinite(tokens), lastSeq: run.lastSeq })
  }
  return snapshots
}

function childGrowth(messages: ChatMessage[], baseline: ReadonlyMap<string, ChildUsageSnapshot>): {
  totalTokens: number; count: number; unknown: number
} {
  const current = childSnapshots(messages.flatMap(message => message.tools.flatMap(tool => tool.subagent ? [tool.subagent] : [])))
  let totalTokens = 0, count = 0, unknown = 0
  for (const [runId, observed] of current) {
    const previous = baseline.get(runId)
    // Old archive rows cannot roll an authoritative run back to unknown or
    // make already billed usage appear as new consumption.
    if (previous && observed.lastSeq < previous.lastSeq) continue
    totalTokens += Math.max(0, observed.totalTokens - (previous?.totalTokens ?? 0))
    if (!previous) count++
    unknown += Number(observed.unknown) - Number(previous?.unknown ?? false)
  }
  return { totalTokens, count, unknown }
}

/** Loaded turns follow user boundaries, rather than counting each ReAct assistant segment. */
function loadedRounds(messages: ChatMessage[]): number {
  return messages.reduce((rounds, message) => rounds + Number(message.role === 'user'), 0)
}

function nonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function earliest(...values: Array<number | undefined>): number | undefined {
  const observed = values.filter((value): value is number => value !== undefined)
  return observed.length ? Math.min(...observed) : undefined
}

function latest(...values: Array<number | undefined>): number | undefined {
  const observed = values.filter((value): value is number => value !== undefined)
  return observed.length ? Math.max(...observed) : undefined
}
