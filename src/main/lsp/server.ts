/** Single typescript-language-server process and its byte-safe LSP framing. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { LspExitInfo, LspMessage } from '../../shared/ipc'

interface LspServerCallbacks { onMessage: (message: LspMessage) => void; onExit: (info: LspExitInfo) => void }
interface Session { child: ChildProcessWithoutNullStreams; callbacks: LspServerCallbacks; pending: Buffer; closed: boolean; exitNotified: boolean }
const MAX_FRAME_BYTES = 16 * 1024 * 1024
let current: Session | null = null

function drain(session: Session): void {
  while (!session.closed) {
    const separator = session.pending.indexOf(Buffer.from('\r\n\r\n'))
    if (separator < 0) return
    const header = session.pending.subarray(0, separator).toString('ascii')
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header)
    if (!match) { session.pending = session.pending.subarray(separator + 4); continue }
    const length = Number(match[1]); if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) { session.closed = true; try { session.child.kill() } catch {} ; return }
    const bodyStart = separator + 4; if (session.pending.length < bodyStart + length) return
    const body = session.pending.subarray(bodyStart, bodyStart + length); session.pending = session.pending.subarray(bodyStart + length)
    try { const message = JSON.parse(body.toString('utf8')) as LspMessage; if (!session.closed && current === session) session.callbacks.onMessage(message) } catch { /* malformed protocol data is discarded, never forwarded */ }
  }
}
function notifyExit(session: Session, code: number | null, signal: NodeJS.Signals | null): void { if (session.exitNotified) return; session.exitNotified = true; session.closed = true; const isCurrent = current === session; if (isCurrent) current = null; if (isCurrent) session.callbacks.onExit({ code, signal }) }

export function startLsp(serverEntry: string, callbacks: LspServerCallbacks, nodePath = process.execPath): void {
  stopLsp()
  const child = spawn(nodePath, [serverEntry, '--stdio'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const session: Session = { child, callbacks, pending: Buffer.alloc(0), closed: false, exitNotified: false }; current = session
  child.stdout.on('data', (chunk: Buffer) => { if (session.closed || current !== session) return; session.pending = session.pending.length ? Buffer.concat([session.pending, chunk]) : chunk; drain(session) })
  child.stderr.on('data', () => undefined)
  child.once('exit', (code, signal) => notifyExit(session, code, signal))
  child.once('error', () => notifyExit(session, null, null))
}
export function stopLsp(): void {
  const session = current; current = null; if (!session) return
  session.closed = true; session.pending = Buffer.alloc(0); try { if (!session.child.killed) session.child.kill() } catch {}
}
export function sendToLsp(message: LspMessage): boolean {
  const session = current; if (!session || session.closed || session.child.stdin.destroyed || !session.child.stdin.writable) return false
  try { const body = Buffer.from(JSON.stringify(message), 'utf8'); if (body.length > MAX_FRAME_BYTES) return false; const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'); session.child.stdin.write(Buffer.concat([header, body])); return true } catch { return false }
}
