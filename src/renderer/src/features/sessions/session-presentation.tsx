import { useRef, useMemo, type JSX } from 'react'
import type { ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'
import { toast } from '@renderer/core/toast'
import { type IconName, Icon } from '@renderer/ui/icons'
import { useSessionController } from './runtime'
import type { SessionArtifactSelection } from '../artifacts/session-artifacts'
import { type SessionToolSnapshot, sessionToolSnapshot } from './view-performance'

export type SessionController = ReturnType<typeof useSessionController>

export type SessionTask = SessionController['tasks'][number]

export type ArtifactNavigation = Omit<SessionArtifactSelection, 'revision'>

export type FinalSelection = { sessionId: string; runId: string; itemId: string; revision: number }

export type ActivitySelection = { taskId: string; toolId: string; revision: number }

export function useSessionTools(messages: ChatMessage[]): ToolActivity[] {
  const previous = useRef<SessionToolSnapshot<ToolActivity> | undefined>(undefined)
  return useMemo(() => {
    const next = sessionToolSnapshot(messages, previous.current)
    previous.current = next
    return next.tools
  }, [messages])
}

export function filename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path
}

export function fileSize(value: number): string {
  return value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${Math.ceil(value / 1024)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function reportError(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

export function EmptyState({
  icon,
  title,
  description
}: {
  icon: IconName
  title: string
  description: string
}): JSX.Element {
  return (
    <div className="work-empty">
      <Icon name={icon} size={28} />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}
