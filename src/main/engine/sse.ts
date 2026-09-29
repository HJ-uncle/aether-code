import type { ChatSsePayload } from '../../shared/ipc'

export type ParsedSseBlock =
  | { type: 'payload'; payload: ChatSsePayload; eventId?: string }
  | { type: 'done'; eventId?: string }

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
  if (event === 'done' || body === '[DONE]') return { type: 'done', eventId }
  if (!body) return null
  try { return { type: 'payload', payload: JSON.parse(body) as ChatSsePayload, eventId } }
  catch { return null }
}
