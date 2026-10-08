import { expect, test } from '@playwright/test'
import {
  remoteAuthHeaders,
  remoteAuthTarget,
  validateRemoteAuth
} from '../src/main/engine/remote-auth-contract'
import { classifyEngineProbeAuthFailure } from '../src/main/engine/protocol'

/**
 * 纯函数测试：远端用户认证契约。
 *
 * 这些断言不接触 Electron、密钥存储或真实服务：它们钉死凭据的 URL
 * 绑定规则、HTTP 头映射和输入校验，避免把秘密错误地写入实例令牌或
 * 发到另一个远端地址。
 */

test.describe('远端地址绑定', () => {
  test('只规范化末尾斜杠，保留 origin 与路径作为凭据作用域', () => {
    expect(remoteAuthTarget('https://engine.example.test:443/api/')).toBe(
      'https://engine.example.test/api'
    )
    expect(remoteAuthTarget('http://127.0.0.1:12323')).toBe('http://127.0.0.1:12323')
  })

  test('拒绝查询、片段、内嵌凭据和非 HTTP(S) 地址', () => {
    expect(() => remoteAuthTarget('https://engine.example.test/api?tenant=one')).toThrow(
      /不含凭据|查询参数/
    )
    expect(() => remoteAuthTarget('https://engine.example.test/api#frag')).toThrow()
    expect(() => remoteAuthTarget('https://user:pass@engine.example.test/api')).toThrow()
    expect(() => remoteAuthTarget('file:///tmp/engine')).toThrow()
  })
})

test.describe('认证头映射', () => {
  test('API Key 使用 X-API-Key 且不生成 Bearer 头', () => {
    expect(remoteAuthHeaders({ type: 'api-key', value: 'key-123' })).toEqual({
      'X-API-Key': 'key-123'
    })
  })

  test('JWT 使用标准 Bearer Authorization 头', () => {
    expect(remoteAuthHeaders({ type: 'bearer', value: 'eyJ.test.sig' })).toEqual({
      Authorization: 'Bearer eyJ.test.sig'
    })
  })

  test('没有用户凭据时不附加认证头', () => {
    expect(remoteAuthHeaders(null)).toEqual({})
  })
})

test.describe('非法凭据拒绝', () => {
  test('只接受 api-key / bearer 且必须有可打印内容', () => {
    expect(validateRemoteAuth({ type: 'api-key', value: ' key-123 ' })).toEqual({
      type: 'api-key',
      value: 'key-123'
    })
    expect(() => validateRemoteAuth({ type: 'basic', value: 'secret' })).toThrow(/认证类型/)
    expect(() => validateRemoteAuth({ type: 'bearer', value: '' })).toThrow(/凭据/)
    expect(() => validateRemoteAuth({ type: 'bearer', value: 'token\nforged' })).toThrow(/凭据/)
    expect(() => validateRemoteAuth({ type: 'bearer', value: 'x'.repeat(16_385) })).toThrow(/凭据/)
    expect(() => validateRemoteAuth(null)).toThrow(/凭据/)
  })
})

test.describe('握手错误分类', () => {
  test('将用户认证失败与实例令牌失败分开', () => {
    for (const message of [
      'Authentication required',
      'Invalid API key',
      'Invalid API key: revoked',
      'Invalid JWT: signature verification failed',
      'JWT authentication is not configured'
    ]) {
      expect(classifyEngineProbeAuthFailure(message), message).toBe('user-credential')
    }
    expect(classifyEngineProbeAuthFailure('Invalid or missing instance token')).toBe('instance-token')
  })

  test('未知错误保持保守分类，不泄露或猜测凭据类型', () => {
    expect(classifyEngineProbeAuthFailure('upstream auth proxy rejected request')).toBe('unknown')
    expect(classifyEngineProbeAuthFailure({ message: 'Invalid API key' })).toBe('unknown')
    expect(classifyEngineProbeAuthFailure(undefined)).toBe('unknown')
  })
})
