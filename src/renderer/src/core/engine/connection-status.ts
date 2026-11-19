import type { EngineSnapshot } from '@shared/ipc'

export function accountConnectionIssue(snapshot: EngineSnapshot): boolean {
  return snapshot.phase === 'error' && (snapshot.connectionIssue === 'authentication-required' || snapshot.connectionIssue === 'http-trust-required')
}

/** A heartbeat retry and a first connection share a phase; localized diagnostic text is not an API. */
export function connectionLabel(snapshot: EngineSnapshot): string {
  if (snapshot.phase === 'error') {
    if (snapshot.connectionIssue === 'authentication-required') return '需要登录'
    if (snapshot.connectionIssue === 'http-trust-required') return '待确认连接'
    if (snapshot.connectionIssue === 'instance-token') return '请检查实例令牌'
    return '异常'
  }
  switch (snapshot.phase) {
    case 'starting': return (snapshot.reconnectAttempt ?? 0) > 0 ? '重新连接中' : snapshot.mode === 'remote' ? '连接中' : '启动中'
    case 'ready': return '就绪'
    case 'installing': return '安装中'
    case 'stopping': return snapshot.mode === 'remote' || snapshot.adopted ? '断开中' : '关闭中'
    case 'idle': return snapshot.mode === 'remote' ? '未连接' : '未启动'
  }
}

export function runtimeSourceLabel(snapshot: EngineSnapshot): string {
  if (snapshot.mode === 'remote') return '由服务端管理'
  if (snapshot.adopted) return '复用已有本机进程'
  if (!snapshot.runtimeSource) return '—'
  return { env: '启动环境指定', bundled: '应用内置', imported: '导入的引擎包', 'dev-sibling': '开发目录引擎' }[snapshot.runtimeSource]
}
