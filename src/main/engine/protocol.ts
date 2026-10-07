import { CODE_TOOL_PROFILE_HEADERS } from './tool-profile'
import type { EngineSnapshot } from '../../shared/ipc'

export function engineTargetError(snapshot: EngineSnapshot, expected?: Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId'>): string | null {
  return expected && (snapshot.mode !== expected.mode || snapshot.baseUrl !== expected.baseUrl || snapshot.instanceId !== expected.instanceId)
    ? '引擎连接已经切换，请在当前会话重新操作。'
    : null
}

export interface EngineManifest {
  version: string
  buildId: string
  protocolVersion: 1
  toolProfiles: string[]
  subagentSchemaVersion: 1
}

export interface EngineMeta extends EngineManifest {
  instanceId: string
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('引擎返回了无效协议数据')
  }
  return value as Record<string, unknown>
}

export function parseEngineManifest(value: unknown): EngineManifest {
  const data = record(value)
  if (
    typeof data.version !== 'string' ||
    !data.version.trim() ||
    data.version === 'unknown' ||
    typeof data.buildId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(data.buildId) ||
    data.protocolVersion !== 1 ||
    data.subagentSchemaVersion !== 1 ||
    !Array.isArray(data.toolProfiles) ||
    !data.toolProfiles.includes('code') ||
    !data.toolProfiles.every((profile) => typeof profile === 'string')
  ) {
    throw new Error('引擎协议或编程工具范围不兼容，请使用配套构建')
  }
  return data as unknown as EngineManifest
}

export function parseEngineMeta(value: unknown, expectedBuildId?: string): EngineMeta {
  const envelope = record(value)
  if (envelope.code !== 200 && envelope.code !== 0) throw new Error('引擎 /meta 返回失败')
  const manifest = parseEngineManifest(envelope.data)
  const data = record(envelope.data)
  if (typeof data.instanceId !== 'string' || !data.instanceId.trim()) {
    throw new Error('引擎没有有效实例身份')
  }
  if (expectedBuildId && manifest.buildId !== expectedBuildId) {
    throw new Error('实际引擎与目标构建不一致，请停止旧进程后重试')
  }
  return { ...manifest, instanceId: data.instanceId }
}

export function assertEngineHealth(value: unknown): void {
  const envelope = record(value)
  if ((envelope.code !== 200 && envelope.code !== 0) || record(envelope.data).status !== 'ok') {
    throw new Error('引擎 /health 返回无效状态')
  }
}

/** A manually started loopback development engine may use its standalone auth contract. */
export function remoteInstanceToken(url: string, configuredToken?: string): string {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('远端引擎地址必须为不含凭证的 HTTP(S) 地址')
  }
  const token = validateRemoteInstanceToken(configuredToken ?? '')
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (!token && !loopback) {
    throw new Error('远端引擎需要连接凭据：请在设置→引擎→远端令牌中填写与引擎 AETHER_INSTANCE_TOKEN 一致的值，或启动 Aether Code 前设置 AETHER_IDE_REMOTE_INSTANCE_TOKEN；本机开发也可选择「本地内置」。')
  }
  return token
}

/** Both saved and environment credentials use the same HTTP-header validation. */
export function validateRemoteInstanceToken(value: string): string {
  const token = value.trim()
  if (token.length > 4096) throw new Error('远端令牌长度不能超过 4096 个字符')
  for (const character of token) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) throw new Error('远端令牌不能包含控制字符')
    if (code > 255) throw new Error('远端令牌包含 HTTP 请求头不支持的字符')
  }
  return token
}

// These routes observe engine-owned records; none resolves a local IDE workspace path.
const REMOTE_READ_ROUTES = [
  /^\/(health|meta|metrics)$/,
  /^\/api\/v1\/(models|models\/capability-defs|tools|system-tools|external-skills|changes|todos)$/,
  /^\/api\/v1\/conversation\/(sessions|history|archive)$/,
  /^\/api\/v1\/(mcp\/servers(?:\/[a-zA-Z0-9_-]+)?|skills(?:\/[a-zA-Z0-9_.-]+)?|knowledge\/(?:formats|documents(?:\/[a-zA-Z0-9_-]+)?|bases(?:\/[a-zA-Z0-9_-]+)?|status))$/,
  /^\/api\/v1\/skills\/imports(?:\/[a-zA-Z0-9_-]+)?(?:\/chunks)?$/,
  /^\/api\/v1\/chat\/(snapshot|status|runs|stream)$/,
  /^\/api\/v1\/security\/(mode|policies)$/,
  // Remote Explorer/editor requests are session-scoped by the engine. They
  // carry only a relative path and never resolve the IDE's local workspace.
  /^\/api\/v1\/workspace\/(files|directory|file\/(info|content))$/,
  /^\/api\/v1\/git\/(status|branch-info|divergence|incoming|diff|head-file|head-file-content|list-branches|list-remote-branches|list-remotes|list-stashes|stash-show|stash-show-files|list-tags|log|commit-show|show-commit-file|file-history|blame|user-name|list-authors)$/,
  /^\/api\/v1\/terminal\/create$/,
  /^\/api\/v1\/mcp\/config\/export$/,
  /^\/api\/v1\/codegraph\/status$/,
  // Remote Monaco language service requests are session-scoped by the
  // engine and never resolve a client-local workspace path.
  /^\/api\/v1\/lsp\/request$/,
  /^\/api\/v1\/lsp\/adapters$/,
  /^\/api\/v1\/subagent\/runs(?:\/[a-zA-Z0-9_-]+(?:\/events)?)?$/,
  /^\/api\/v1\/command-jobs(?:\/[a-zA-Z0-9_-]+(?:\/output)?)?$/,
  /^\/api\/v1\/sessions\/[a-zA-Z0-9_-]+\/binding$/
  ,/^\/api\/v1\/memory\/(settings|recall\/[a-zA-Z0-9_.:-]+|list|graph)$/
]

const REMOTE_CHAT_ROUTES = [
  /^\/api\/v1\/chat(?:\/cancel)?$/,
  /^\/api\/v1\/utility\/chat$/,
  /^\/api\/v1\/models(?:\/detect-capabilities|\/[a-zA-Z0-9_-]+\/test)?$/,
  /^\/api\/v1\/conversation\/compress$/,
  /^\/api\/v1\/subagent\/cancel$/,
  /^\/api\/v1\/subagent\/runs\/[a-zA-Z0-9_-]+\/cancel$/,
  /^\/api\/v1\/command-jobs\/[a-zA-Z0-9_-]+\/cancel$/
  ,/^\/api\/v1\/mcp\/servers\/[a-zA-Z0-9_-]+\/test$/
  ,/^\/api\/v1\/mcp\/servers(?:\/[a-zA-Z0-9_-]+)?\/(?:enable|disable)$/
  ,/^\/api\/v1\/skills\/imports(?:\/chunks)?(?:\/[a-zA-Z0-9_-]+)?(?:\/merge)?$/
  ,/^\/api\/v1\/knowledge\/(documents|bases|search)$/
  ,/^\/api\/v1\/memory\/(remember|link|consolidate)$/
  ,/^\/api\/v1\/workspace\/(bind|file|file\/create|folder\/create|file\/trash|file\/move|file\/copy)$/
]

/** Conversation execution uses server-side workspace paths, never the local IDE root. */
export function remoteRequestError(mode: 'embedded' | 'remote', method: string, path: string): string | null {
  if (mode !== 'remote') return null
  const pathname = normalizeEnginePath(path).split('?')[0]
  if (method === 'GET' && REMOTE_READ_ROUTES.some(route => route.test(pathname))) return null
  if (method === 'POST' && REMOTE_CHAT_ROUTES.some(route => route.test(pathname))) return null
  if (method === 'POST' && /^\/api\/v1\/(mcp\/servers|mcp\/config\/import|skills)$/.test(pathname)) return null
  if (method === 'POST' && pathname === '/api/v1/git/action') return null
  if (method === 'POST' && /^\/api\/v1\/(security\/policies(?:\/reset)?|changes\/(keep-all|keep-many)|codegraph\/index|lsp\/diagnose)$/.test(pathname)) return null
  if (method === 'POST' && pathname === '/api/v1/lsp/request') return null
  if (method === 'PUT' && /^\/api\/v1\/(knowledge\/(documents|bases)\/[a-zA-Z0-9_-]+|mcp\/servers\/[a-zA-Z0-9_-]+)$/.test(pathname)) return null
  if (method === 'PUT' && /^\/api\/v1\/memory\/(settings|[a-zA-Z0-9_.:-]+)$/.test(pathname)) return null
  if (method === 'PATCH' && /^\/api\/v1\/(mcp\/servers|skills)\/[a-zA-Z0-9_-]+$/.test(pathname)) return null
  if (method === 'PATCH' && /^\/api\/v1\/security\/policies\/[0-9]+$/.test(pathname)) return null
  if (method === 'PUT' && pathname === '/api/v1/security/mode') return null
  if (method === 'PUT' && /^\/api\/v1\/security\/policies\/[0-9]+$/.test(pathname)) return null
  if (method === 'DELETE' && /^\/api\/v1\/(knowledge\/(documents|bases)|mcp\/servers|skills)\/[a-zA-Z0-9_-]+$/.test(pathname)) return null
  if (method === 'DELETE' && /^\/api\/v1\/memory\/[a-zA-Z0-9_.:-]+$/.test(pathname)) return null
  if (method === 'DELETE' && /^\/api\/v1\/(?:models\/(?!capability-defs$|detect-capabilities$)[a-zA-Z0-9_.-]+|skills\/imports\/[a-zA-Z0-9_.-]+|security\/policies\/[0-9]+)$/.test(pathname)) return null
  if (method === 'DELETE' && /^\/api\/v1\/terminal\/[a-zA-Z0-9_-]+$/.test(pathname)) return null
  if (method === 'DELETE' && pathname === '/api/v1/lsp/session') return null
  // Conversation deletion mutates engine-owned records but never touches the
  // IDE's local workspace, so it is safe and supported for remote engines.
  if (
    method === 'DELETE' &&
    (
      pathname === '/api/v1/conversation/history' ||
      /^\/api\/v1\/conversation\/(turns|messages)\/[a-zA-Z0-9_-]+$/.test(pathname) ||
      /^\/api\/v1\/sessions\/[a-zA-Z0-9_-]+$/.test(pathname)
    )
  ) return null
  // Truncation only removes engine-owned conversation rows. It is the remote
  // counterpart of retrying a turn; no local workspace path is resolved here.
  if (method === 'POST' && pathname === '/api/v1/conversation/truncate') return null
  // Change snapshots are stored by the engine. A remote revert therefore
  // operates on the remote engine workspace and does not require a local path.
  if (method === 'POST' && pathname === '/api/v1/changes/revert-batch') return null
  if (method === 'PUT' && /^\/api\/v1\/models\/(?!capability-defs$|detect-capabilities$)[a-zA-Z0-9_-]+$/.test(pathname)) return null
  return '此入口尚未接入远端服务；请使用已接入的远端工作区、聊天、MCP、技能、知识库与代码图接口。'
}

/** Reject client-local absolute paths before they can reach a remote engine. */
export function remoteWorkspacePathError(mode: 'embedded' | 'remote', method: string, path: string, body: unknown): string | null {
  if (mode !== 'remote' || method !== 'POST') return null
  const pathname = normalizeEnginePath(path).split('?')[0]
  if (!/^\/api\/v1\/workspace\/(?:file|file\/create|folder\/create|file\/trash|file\/move|file\/copy)$/.test(pathname)) return null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '远端工作区请求缺少有效的相对路径参数'
  const record = body as Record<string, unknown>
  const fields = ['path', 'srcPath', 'destPath']
  for (const field of fields) {
    const value = record[field]
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim()) return '远端工作区路径无效'
    const normalized = value.replace(/\\/g, '/')
    if (/^(?:[A-Za-z]:\/|\/\/|\/)/.test(normalized) || normalized.split('/').some(segment => segment === '..')) {
      return '远端工作区不能使用本机绝对路径或越界路径'
    }
  }
  return null
}

/** Used by both ordinary requests and every SSE method, including resume. */
export function engineHeaders(instanceToken: string): Record<string, string> {
  return {
    ...CODE_TOOL_PROFILE_HEADERS,
    ...(instanceToken ? { 'X-Aether-Instance-Token': instanceToken } : {})
  }
}

export function normalizeEnginePath(path: string): string {
  const trimmed = path.startsWith('/') ? path : `/${path}`
  if (/^\/(health|meta|metrics|openapi\.json|auth)(\/|$)/.test(trimmed)) return trimmed
  if (/^\/api\/v1(\/|$)/.test(trimmed)) return trimmed
  return `/api/v1${trimmed}`
}
