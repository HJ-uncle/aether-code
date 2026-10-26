/**
 * Detect path traversal that could be hidden behind one or more percent
 * decoding passes at an HTTP boundary. A request body normally arrives
 * undecoded, while query parsers commonly decode once; checking both the
 * original and bounded decoded forms keeps the client and server guards in
 * agreement without normalizing a user-visible filename.
 */
export function hasEncodedPathTraversal(value: string): boolean {
  let current = value
  for (let depth = 0; depth < 8; depth += 1) {
    if (current.includes('\u0000')) return true

    // A plain percent sign is a valid filename character. Only invoke the
    // strict decoder when the value contains an actual percent escape; this
    // preserves names such as `100%done.txt` while rejecting malformed mixed
    // escapes that an intermediary could interpret differently.
    if (!/%[0-9a-f]{2}/i.test(current)) return false

    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      // Once a real escape is present, malformed escapes are rejected rather
      // than passed to a downstream parser with different decoding rules.
      return true
    }
    if (decoded === current) return false
    current = decoded
    if (current.includes('\u0000') || current.replace(/\\/g, '/').split('/').some(segment => segment === '..')) return true
  }
  // Reject unusually deep encoding rather than allowing another intermediary
  // to decode a traversal after this guard has returned.
  return true
}
