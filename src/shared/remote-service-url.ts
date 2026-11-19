/** Same address rules for stored settings, request credentials and the renderer’s workspace context. */
export function remoteServiceUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('远端地址必须为不含凭据、查询参数或片段的 HTTP(S) 地址')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function sameRemoteService(savedUrl: string, activeUrl: string): boolean {
  try { return remoteServiceUrl(savedUrl) === remoteServiceUrl(activeUrl) } catch { return false }
}
