import type { ChatSsePayload } from '../../shared/ipc'
import { parseEngineStreamCursor, type StreamEventBody } from '../../shared/stream-event'

export type ParsedSseBlock = { eventId?: string } & Exclude<StreamEventBody, { type: 'error' }>

/** Keep the transport watermark alongside the payload; it is not the server's latest cursor. */
export function parseSseBlock(block: string): ParsedSseBlock | null {
  let event = '', eventId: string | undefined
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const name = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (name === 'id' && !value.includes('\0')) eventId = value
    else if (name === 'event') event = value
    else if (name === 'data') data.push(value)
  }
  const body = data.join('\n')
  // A parser failure must not silently lose a frame and advance the next cursor.
  if (eventId !== undefined && !parseEngineStreamCursor(eventId)) return { type: 'snapshot-required', reason: 'invalid-cursor' }
  if (event === 'done' || body === '[DONE]') return { type: 'done', eventId }
  if (!body) return null
  try {
    const payload: unknown = JSON.parse(body)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { type: 'snapshot-required', reason: 'invalid-event' }
    if ('code' in payload && payload.code === 'snapshot_required') return { type: 'snapshot-required', reason: 'retention-gap' }
    return { type: 'payload', payload: payload as ChatSsePayload, eventId }
  }
  catch { return { type: 'snapshot-required', reason: 'invalid-event' } }
}
