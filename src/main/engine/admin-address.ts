/** The target is the active engine, never an address supplied by a renderer. */
export function adminPageAddress(base: string): URL {
  const service = new URL(base)
  if (service.username || service.password || service.search || service.hash ||
    (service.protocol !== 'https:' && !(service.protocol === 'http:' && ['localhost', '[::1]', '127.0.0.1'].includes(service.hostname)))) {
    throw new Error('管理后台需要 HTTPS 或本机回环地址。')
  }
  service.pathname = service.pathname.replace(/\/+$/, '') + '/admin/'
  return service
}

/** Only the verified service's exact origin and /admin/ subtree, including a reverse proxy prefix. */
export function isAdminWindowRequest(raw: string, page: URL): boolean {
  try {
    const target = new URL(raw)
    return target.origin === page.origin && !target.hash && !raw.includes('\\') &&
      !target.username && !target.password && !target.pathname.includes('%') && target.pathname.startsWith(page.pathname)
  } catch { return false }
}

export async function verifyAdminPage(page: URL, signal: AbortSignal, devSnapshot: boolean): Promise<boolean> {
  let response: Response
  try { response = await fetch(page, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) }) }
  catch { throw new Error('无法连接管理后台。请检查当前引擎的状态和地址。') }
  if (response.status !== 200 || !/^text\/html\b/i.test(response.headers.get('content-type') ?? '') || response.headers.get('x-aether-admin-surface') !== '1') {
    if (devSnapshot) throw new Error('当前桌面仍在使用旧的开发快照。请先结束运行中的任务，退出桌面开发进程，再从 aether-code 目录重新运行 npm run dev。')
    throw new Error('当前服务没有提供新版管理登录页，或被上游网关拦截。请升级实际运行的引擎，并允许访问 /admin/ 登录页。')
  }
  return response.headers.get('x-aether-admin-desktop') === '1'
}
