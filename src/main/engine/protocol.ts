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
  /^\/api\/v1\/conversation\/(sessions|history)$/,
  /^\/api\/v1\/chat\/(snapshot|status|runs|stream)$/,
  /^\/api\/v1\/security\/(mode|policies)$/,
  /^\/api\/v1\/subagent\/runs(?:\/[a-zA-Z0-9_-]+(?:\/events)?)?$/,
  /^\/api\/v1\/command-jobs(?:\/[a-zA-Z0-9_-]+(?:\/output)?)?$/,
  /^\/api\/v1\/sessions\/[a-zA-Z0-9_-]+\/binding$/
]

const REMOTE_CHAT_ROUTES = [
  /^\/api\/v1\/chat(?:\/cancel)?$/,
  /^\/api\/v1\/utility\/chat$/,
  /^\/api\/v1\/models(?:\/detect-capabilities|\/[a-zA-Z0-9_-]+\/test)?$/,
  /^\/api\/v1\/conversation\/compress$/,
  /^\/api\/v1\/subagent\/cancel$/,
  /^\/api\/v1\/subagent\/runs\/[a-zA-Z0-9_-]+\/cancel$/,
  /^\/api\/v1\/command-jobs\/[a-zA-Z0-9_-]+\/cancel$/
]

/** Conversation execution uses server-side workspace paths, never the local IDE root. */
export function remoteRequestError(mode: 'embedded' | 'remote', method: string, path: string): string | null {
  if (mode !== 'remote') return null
  const pathname = normalizeEnginePath(path).split('?')[0]
  if (method === 'GET' && REMOTE_READ_ROUTES.some(route => route.test(pathname))) return null
  if (method === 'POST' && REMOTE_CHAT_ROUTES.some(route => route.test(pathname))) return null
  if (method === 'PUT' && /^\/api\/v1\/models\/(?!capability-defs$|detect-capabilities$)[a-zA-Z0-9_-]+$/.test(pathname)) return null
  return '此入口尚未接入远端服务；远端聊天可用，文件与 Git 操作仍使用本机工作区，远端删除及安全设置暂未开放。'
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
