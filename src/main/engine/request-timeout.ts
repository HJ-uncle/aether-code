import type { EngineRequestInput } from '../../shared/ipc'
import { normalizeEnginePath } from './protocol'

const DEFAULT_MANAGEMENT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 2147483647
const MCP_RESPONSE_GRACE_MS = 5000
// Initialize/version retry, notification, discovery and compatibility fallbacks.
const MCP_CONNECT_PHASES = 6

/** MCP owns its request deadline; the bridge allows time for the result envelope. */
export function managementRequestTimeout(input: Pick<EngineRequestInput, 'method' | 'path' | 'timeoutMs'>): number | null {
  const isMcpTest = input.method === 'POST' && /^\/api\/v1\/mcp\/servers\/[^/]+\/test$/.test(normalizeEnginePath(input.path).split('?')[0])
  if (!isMcpTest || input.timeoutMs === undefined) return DEFAULT_MANAGEMENT_TIMEOUT_MS
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > MAX_TIMEOUT_MS) throw new Error('MCP 请求超时必须是 0 到 2147483647 之间的整数毫秒')
  if (input.timeoutMs === 0) return null
  const connectBudget = input.timeoutMs * MCP_CONNECT_PHASES + MCP_RESPONSE_GRACE_MS
  // Server phase deadlines remain active when the aggregate exceeds a Node timer.
  return connectBudget > MAX_TIMEOUT_MS ? null : connectBudget
}

export function managementRequestSignal(input: Pick<EngineRequestInput, 'method' | 'path' | 'timeoutMs'>, connectionSignal: AbortSignal): AbortSignal {
  const timeoutMs = managementRequestTimeout(input)
  // Unlimited requests still end immediately when the connection is switched or closed.
  return timeoutMs === null ? connectionSignal : AbortSignal.any([connectionSignal, AbortSignal.timeout(timeoutMs)])
}
