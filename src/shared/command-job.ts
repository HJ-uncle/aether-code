export type CommandJobStatus = 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'

/** Engine-owned identity and status; accepting dispatch or cancel is not process completion. */
export interface CommandJobSnapshot {
  schemaVersion: 1
  jobId: string
  sessionId: string
  ownerSessionId: string
  runId?: string
  ownerRunId?: string
  turnId?: string
  toolCallId?: string
  version: number
  status: CommandJobStatus
  command: string
  args: string[]
  cwd: string
  background: boolean
  createdAt: number
  updatedAt: number
  finishedAt?: number
  exitCode: number | null
  signal: string | null
  error?: { code: string; message: string }
  cursor: number
  earliestCursor: number
}

export interface CommandOutputEntry { seq: number; stream: 'stdout' | 'stderr'; text: string }
export interface CommandJobOutput {
  job: CommandJobSnapshot
  entries: CommandOutputEntry[]
  nextCursor: number
  earliestCursor: number
  truncated: boolean
  hasMore: boolean
}
