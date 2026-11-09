/** A navigation address contains ownership, never credentials or conversation text. */
export interface ConversationLink {
  sessionId: string
  mode: 'work'
  source: string
}

export const CONVERSATION_LINK_SCHEME = 'aether'
const MAX_LINK_LENGTH = 8192
const MAX_SOURCE_LENGTH = 2048
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const ACCOUNT_ID = /^[^\s\x00-\x1f\x7f/?#\\"<>]{1,256}$/u

/** Preserve engineStorageKey exactly; using a normalized endpoint could cross accounts. */
function validSource(source: string): boolean {
  if (source.length > MAX_SOURCE_LENGTH || /[\s\x00-\x1f\x7f]/u.test(source)) return false
  if (source === '') return true
  if (source.startsWith(':account:')) return ACCOUNT_ID.test(source.slice(':account:'.length))
  if (!source.startsWith('remote:')) return false
  let endpoint = source.slice('remote:'.length)
  const accountIndex = endpoint.lastIndexOf(':account:')
  if (accountIndex >= 0) {
    if (!ACCOUNT_ID.test(endpoint.slice(accountIndex + ':account:'.length))) return false
    endpoint = endpoint.slice(0, accountIndex)
  }
  try {
    if (!/^https?:\/\//i.test(endpoint) || endpoint.includes('\\')) return false
    const url = new URL(endpoint)
    decodeURIComponent(url.pathname)
    return /^https?:$/.test(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

export function buildConversationLink(input: ConversationLink): string {
  if (input.mode !== 'work' || !SESSION_ID.test(input.sessionId) || ['.', '..'].includes(input.sessionId) || !validSource(input.source))
    throw new Error('会话链接信息无效，未复制链接。')
  const url = new URL(`${CONVERSATION_LINK_SCHEME}://conversation/${encodeURIComponent(input.sessionId)}`)
  url.searchParams.set('mode', input.mode)
  url.searchParams.set('source', input.source)
  return url.href
}

/** Only whole, versioned addresses are actionable. Bare ids and arbitrary URLs are text. */
export function parseConversationLink(value: unknown): ConversationLink | null {
  if (typeof value !== 'string' || value.length > MAX_LINK_LENGTH || /[\s\x00-\x1f\x7f]/u.test(value)) return null
  if (!/^aether:\/\/conversation\/[^/?#\\]+\?/.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== `${CONVERSATION_LINK_SCHEME}:` || url.hostname !== 'conversation' || url.port || url.username || url.password || url.hash) return null
    if (url.searchParams.size !== 2 || url.searchParams.getAll('mode').length !== 1 || url.searchParams.getAll('source').length !== 1 || url.searchParams.get('mode') !== 'work') return null
    if (!/^\/[^/]+$/.test(url.pathname)) return null
    const sessionId = decodeURIComponent(url.pathname.slice(1)), source = url.searchParams.get('source')!
    if (!SESSION_ID.test(sessionId) || ['.', '..'].includes(sessionId) || !validSource(source)) return null
    return { sessionId, mode: 'work', source }
  } catch { return null }
}
