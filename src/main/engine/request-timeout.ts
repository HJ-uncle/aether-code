import type { EngineRequestInput } from '../../shared/ipc'
import { normalizeEnginePath } from './protocol'

const DEFAULT_MANAGEMENT_TIMEOUT_MS = 120000
const WORK_STATUS_TIMEOUT_MS = 5000
const SUBAGENT_OBSERVATION_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 2147483647
const MCP_RESPONSE_GRACE_MS = 5000
// Initialize/version retry, notification, discovery and compatibility fallbacks.
const MCP_CONNECT_PHASES = 6

/** MCP owns its request deadline; the bridge allows time for the result envelope. */
export function managementRequestTimeout(
  input: Pick<EngineRequestInput, 'method' | 'path' | 'query' | 'timeoutMs'>
): number | null {
  const path = normalizeEnginePath(input.path).split('?')[0]
  // A hung status probe must not block every task's next reconciliation cycle.
  if (input.method === 'GET' && path === '/api/v1/chat/status') return WORK_STATUS_TIMEOUT_MS
  // Observation shares two real transport slots; a stalled child read must
  // release its fetch before another discovery or selected run can proceed.
  if (input.method === 'GET' && (path === '/api/v1/subagent/discovery' ||
    /^\/api\/v1\/subagent\/runs\/[^/?#]+$/.test(path) && input.query?.view === 'summary'))
    return SUBAGENT_OBSERVATION_TIMEOUT_MS
  const isMcpTest = input.method === 'POST' && /^\/api\/v1\/mcp\/servers\/[^/]+\/test$/.test(path)
  if (!isMcpTest || input.timeoutMs === undefined) return DEFAULT_MANAGEMENT_TIMEOUT_MS
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > MAX_TIMEOUT_MS)
    throw new Error('MCP 请求超时必须是 0 到 2147483647 之间的整数毫秒')
  if (input.timeoutMs === 0) return null
  const connectBudget = input.timeoutMs * MCP_CONNECT_PHASES + MCP_RESPONSE_GRACE_MS
  // Server phase deadlines remain active when the aggregate exceeds a Node timer.
  return connectBudget > MAX_TIMEOUT_MS ? null : connectBudget
}

export function managementRequestSignal(
  input: Pick<EngineRequestInput, 'method' | 'path' | 'query' | 'timeoutMs'>,
  connectionSignal: AbortSignal
): AbortSignal {
  const timeoutMs = managementRequestTimeout(input)
  // Unlimited requests still end immediately when the connection is switched or closed.
  return timeoutMs === null
    ? connectionSignal
    : AbortSignal.any([connectionSignal, AbortSignal.timeout(timeoutMs)])
}
