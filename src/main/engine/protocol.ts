import { CODE_TOOL_PROFILE_HEADERS } from './tool-profile'

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

/** Remote execution needs an explicit shared filesystem contract before local IDE paths are sent. */
export function remoteRequestError(mode: 'embedded' | 'remote', method: string, path: string): string | null {
  if (mode !== 'remote') return null
  const pathname = normalizeEnginePath(path).split('?')[0]
  if (method === 'GET' && /^\/(health|meta|metrics|api\/v1\/(models|tools|system-tools|external-skills))$/.test(pathname)) return null
  return '远端模式尚未配置工作区映射，目前仅支持查看引擎、模型和工具信息；请切换本地内置模式后执行对话、诊断或文件操作。'
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
