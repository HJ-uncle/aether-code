/** Pure identity/path contracts: delayed requests and encoded credential-route bypasses. */
import { expect, test } from '@playwright/test'
import { engineTargetError, isAccountRequestPath } from '../src/main/engine/protocol'
import { engineConnectionKey, engineStorageKey } from '../src/renderer/src/core/engine/source'
import type { EngineSnapshot } from '../src/shared/ipc'

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
