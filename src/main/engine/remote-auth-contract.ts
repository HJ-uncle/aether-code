import type { RemoteAuthCredential } from '../../shared/ipc'

export function remoteAuthTarget(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('远端地址必须为不含凭据、查询参数或片段的 HTTP(S) 地址')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function validateRemoteAuth(value: unknown): RemoteAuthCredential {
  if (!value || typeof value !== 'object') throw new Error('远端用户凭据无效')
  const input = value as Record<string, unknown>
  if (input.type !== 'api-key' && input.type !== 'bearer') throw new Error('用户认证类型无效')
  if (typeof input.value !== 'string') throw new Error('用户凭据必须为字符串')
  const secret = input.value.trim()
  if (!secret || secret.length > 16384 || /[^\x21-\x7e]/.test(secret)) throw new Error('用户凭据必须是有效的 API Key 或 JWT，不能含空白或控制字符')
  return { type: input.type, value: secret }
}

export function remoteAuthHeaders(credential: RemoteAuthCredential | null): Record<string, string> {
  if (!credential) return {}
  const { type, value } = validateRemoteAuth(credential)
  return type === 'api-key' ? { 'X-API-Key': value } : { Authorization: `Bearer ${value}` }
}
