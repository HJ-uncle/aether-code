/** Native diagnostics must fail independently of passing DOM checks and redact credentials. */
import { expect, test } from '@playwright/test'
import { nativeEventFailed, redactNativeLog } from './helpers/electron-health'

test('原生异常退出和子进程启动失败不能被归为正常关闭', () => {
  expect(nativeEventFailed({ kind: 'child-process-gone', reason: 'crashed', exitCode: 2147483651 })).toBe(true)
  expect(nativeEventFailed({ kind: 'render-process-gone', reason: 'launch-failed', exitCode: 49 })).toBe(true)
  expect(nativeEventFailed({ kind: 'render-process-gone', reason: 'oom', exitCode: 0 })).toBe(true)
  expect(nativeEventFailed({ kind: 'child-process-gone', reason: 'clean-exit', exitCode: 0 })).toBe(false)
})

test('原生诊断保留错误原因而移除令牌、认证和URL凭证', () => {
  const log = 'FATAL: known-secret-value Authorization: Bearer abcdefghi https://alice:private@example.test/?token=other-private&mode=work x-aether-instance-token: hidden-token'
  const safe = redactNativeLog(log, ['known-secret-value'])
  expect(safe).toContain('FATAL:')
  expect(safe).toContain('mode=work')
  for (const value of ['known-secret-value', 'abcdefghi', 'alice', 'private', 'hidden-token']) expect(safe).not.toContain(value)
})
