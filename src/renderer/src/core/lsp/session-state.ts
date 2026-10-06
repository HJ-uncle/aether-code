/** Pure lifecycle checks shared by the LSP client and contract tests. */
export type LspTransport = 'local' | 'remote'

/**
 * A running session is reusable only when both its workspace root and
 * transport still match.  Keeping the transport in this check is essential:
 * local and remote sessions can use the same root while speaking completely
 * different protocols.
 */
export function canReuseLspSession(
  running: boolean,
  activeRoot: string | null,
  activeTransport: LspTransport,
  requestedRoot: string,
  requestedTransport: LspTransport
): boolean {
  return running && activeRoot === requestedRoot && activeTransport === requestedTransport
}
