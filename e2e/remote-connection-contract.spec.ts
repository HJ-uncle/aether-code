import { expect, test } from '@playwright/test'
import { remoteInstanceToken } from '../src/main/engine/protocol'

test('手动本机开发地址可无token，非本机仍需明确凭据', () => {
  for (const url of ['http://localhost:12323', 'http://127.0.0.1:12323', 'http://[::1]:12323']) {
    expect(remoteInstanceToken(url)).toBe('')
    expect(remoteInstanceToken(url, ' fixture-token ')).toBe('fixture-token')
  }
  for (const url of ['http://192.168.1.10:12323', 'https://engine.example', 'http://localhost.example']) {
    expect(() => remoteInstanceToken(url)).toThrow('AETHER_IDE_REMOTE_INSTANCE_TOKEN')
    expect(remoteInstanceToken(url, 'fixture-token')).toBe('fixture-token')
  }
  expect(() => remoteInstanceToken('http://secret@localhost:12323')).toThrow('不含凭证')
  expect(() => remoteInstanceToken('file:///engine')).toThrow('HTTP(S)')
})
