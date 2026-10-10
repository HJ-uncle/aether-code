import type { ChatMessage } from '@renderer/core/engine/useChat'
import type { EngineModel } from '@renderer/core/engine/models'
import { readConfirmedContext } from '@renderer/core/engine/context-input'
import { latestContextUsage, type ContextUsageSnapshot } from './usage'

export interface ContextPresentation {
  primary: ContextUsageSnapshot | null
  requestEstimate?: number
}

/** Keep confirmed input visible while the next request is estimated or provisionally reported. */
export function contextPresentation(messages: ChatMessage[]): ContextPresentation {
  const latest = latestContextUsage(messages)
  if (!latest) return { primary: null }
  if (latest.estimated !== true && latest.provisional !== true) return { primary: latest }
  let confirmed
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant' || !message.usage || typeof message.usage !== 'object') continue
    const explicit = readConfirmedContext((message.usage as Record<string, unknown>).confirmedContext)
    const sample = latestContextUsage([message])
    confirmed = explicit ?? (sample?.estimated === false && sample.provisional !== true ? sample : undefined)
    if (confirmed && confirmed.modelId === latest.modelId) break
    confirmed = undefined
  }
  const requestEstimate = latest.requestInputTokenEstimate ?? (latest.estimated === true ? latest.used : undefined)
  if (confirmed) return { primary: { ...confirmed, estimated: false }, ...(requestEstimate !== undefined ? { requestEstimate } : {}) }
  // Before the first confirmation, retain this request's estimate rather than the
  // gateway's temporary input count. Final reported input can legitimately differ.
  return { primary: requestEstimate !== undefined ? { ...latest, used: requestEstimate, estimated: true, provisional: false } : latest }
}

/** Current configuration can lower an old window; it cannot enlarge a request's smaller effective limit. */
export function contextPresentationLimit(sample: ContextUsageSnapshot | null, models: EngineModel[], composerModelId: string, fallback: number): number {
  const owner = sample?.modelId ?? (sample ? undefined : composerModelId)
  const model = models.find(item => item.modelId === owner)
  const configured = model?.resolvedCapabilities?.contextWindow ?? model?.capabilities?.contextWindow
  const configuredLimit = typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : undefined
  const actual = sample?.contextWindow
  return actual && actual > 0 ? Math.min(actual, configuredLimit ?? actual) : configuredLimit ?? fallback
}
