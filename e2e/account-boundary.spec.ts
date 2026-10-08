/** Pure identity/path contracts: delayed requests and encoded credential-route bypasses. */
import { expect, test } from '@playwright/test'
import { engineTargetError, isAccountRequestPath } from '../src/main/engine/protocol'
import { engineConnectionKey, engineStorageKey } from '../src/renderer/src/core/engine/source'
import type { EngineSnapshot } from '../src/shared/ipc'
import { accountTransport } from '../src/main/account/transport-contract'

test('账号身份参与连接与本地/远端会话持久化隔离', () => {
  for (const mode of ['embedded', 'remote'] as const) {
    const a = { mode, baseUrl: 'http://127.0.0.1:12323', instanceId: 'one-engine', phase: 'ready' as const, accountId: 'user-a' }
    const b = { ...a, accountId: 'user-b' }
    expect(engineConnectionKey(a)).not.toBe(engineConnectionKey(b))
    expect(engineStorageKey(a)).not.toBe(engineStorageKey(b))
    expect(engineTargetError(a as EngineSnapshot, b)).not.toBeNull()
    expect(engineTargetError(a as EngineSnapshot, a)).toBeNull()
  }
})
test('通用业务桥不能经点路径绕过专用账号凭证边界', () => {
  for (const path of ['/auth/account/register', 'auth/account/login', '/api/v1/../../auth/account/login', '/api/v1/%2e%2e/%2e%2e/auth/account/refresh', '/auth/user']) {
    expect(isAccountRequestPath(path), path).toBe(true)
  }
  for (const path of ['/tools', '/api/v1/models', '/api/v1/chat']) expect(isAccountRequestPath(path)).toBe(false)
})

test('内网 HTTP 信任只适用于确认的协议、主机、端口和服务路径', () => {
  const trusted = ['http://10.219.14.186:12323/engine']
  expect(accountTransport(trusted[0] + '/', trusted)).toBe('http-trusted')
  for (const url of ['http://10.219.14.187:12323/engine', 'http://10.219.14.186:12324/engine', 'http://10.219.14.186:12323/other']) {
    expect(accountTransport(url, trusted)).toBe('http-untrusted')
  }
  expect(accountTransport('https://service.example.test', [])).toBe('secure')
  expect(accountTransport('http://127.0.0.1:12323', [])).toBe('local')
  expect(() => accountTransport('http://name:secret@10.219.14.186:12323/engine', trusted)).toThrow()
})
