import type { ChatSsePayload } from './ipc'

/** The engine owns this cursor; the renderer's streamId only owns an IPC subscription. */
export interface EngineStreamCursor { streamId: string; sequence: number }
export type StreamRecoveryReason = 'retention-gap' | 'invalid-event' | 'invalid-cursor' | 'stream-changed' | 'child-gap'

export type StreamEventBody =
  | { type: 'payload'; payload: ChatSsePayload }
  | { type: 'done' }
  | { type: 'snapshot-required'; reason?: StreamRecoveryReason }
  | { type: 'error'; message: string; status?: number; code?: number; requestRejected?: boolean }

/** Only transport-confirmed non-admission can be returned as a safe-to-edit send failure. */
export interface StreamRequestRejection { message: string; status?: number; code?: number }
export interface StreamStartResult { ok: boolean; rejection?: StreamRequestRejection }

export function isExplicitRequestRejection(status?: number, code?: number): boolean {
  // Server faults and lost connections may happen after admission. Never infer
  // non-execution from those, even when the response did not contain SSE data.
  if (status !== undefined && status >= 500) return false
  const statusCode = code === undefined ? status : code >= 10_000 ? Math.trunc(code / 100) : code
  return statusCode !== undefined && [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(statusCode)
}

/** One envelope for HTTP admission failures, SSE data, terminal frames and replay recovery. */
export type StreamEvent = { streamId: string; eventId?: string } & StreamEventBody

/** Match StreamBus.lastEventId without coercing malformed/unsafe sequence numbers. */
export function parseEngineStreamCursor(value: unknown): EngineStreamCursor | null {
  if (typeof value !== 'string' || value.length > 256) return null
  const separator = value.lastIndexOf(':')
  const streamId = value.slice(0, separator), sequenceText = value.slice(separator + 1)
  if (separator < 1 || /[\s\0]/.test(streamId) || !/^(0|[1-9][0-9]*)$/.test(sequenceText)) return null
  const sequence = Number(sequenceText)
  return Number.isSafeInteger(sequence) ? { streamId, sequence } : null
}

export type StreamCursorDisposition = 'untracked' | 'forward' | 'duplicate' | 'invalid' | 'foreign'

/** Some engine controls have no public frame, so sequence jumps alone are not proof of a gap. */
export function inspectStreamCursor(consumed: string | null, incoming?: string): StreamCursorDisposition {
  if (incoming === undefined) return 'untracked'
  const next = parseEngineStreamCursor(incoming)
  if (!next) return 'invalid'
  if (!consumed) return 'forward'
  const previous = parseEngineStreamCursor(consumed)
  if (!previous) return 'invalid'
  if (previous.streamId !== next.streamId) return 'foreign'
  return next.sequence > previous.sequence ? 'forward' : 'duplicate'
}
