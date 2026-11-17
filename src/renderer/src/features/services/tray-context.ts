import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { CommandJobSnapshot } from '@shared/command-job'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'

interface ServiceTrayContext {
  source: number
  sessionId: string | null
  jobs: CommandJobSnapshot[]
  tools: ToolActivity[]
  onOpenTerminal?: (jobId?: string) => void
  onOpenSubagents?: () => void
  onOpenGit?: () => void
}

const empty = (): ServiceTrayContext => ({ source: getEngineSource(), sessionId: null, jobs: [], tools: [] })
let snapshot = empty()
let owner: symbol | null = null
const listeners = new Set<() => void>()
const emit = (): void => { for (const listener of listeners) listener() }
subscribeEngineSource(() => { owner = null; snapshot = empty(); emit() })

/** The session controller publishes context; the shell owns the one persistent entry. */
export function usePublishServiceTrayContext(context: ServiceTrayContext): void {
  const identity = useRef(Symbol('service-tray-context')).current
  useLayoutEffect(() => {
    if (context.source !== getEngineSource()) return
    owner = identity
    snapshot = context
    emit()
  }, [identity, context.source, context.sessionId, context.jobs, context.tools, context.onOpenTerminal, context.onOpenSubagents, context.onOpenGit])
  useLayoutEffect(() => () => {
    if (owner !== identity) return
    owner = null
    snapshot = empty()
    emit()
  }, [identity])
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const getSnapshot = (): ServiceTrayContext => snapshot
export function useServiceTrayContext(): ServiceTrayContext {
  return useSyncExternalStore(subscribe, getSnapshot)
}
