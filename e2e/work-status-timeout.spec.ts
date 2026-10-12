/** The advisory status endpoint has a short bridge deadline without shortening management or recovery. */
import { expect, test } from '@playwright/test'
import {
  managementRequestSignal,
  managementRequestTimeout
} from '../src/main/engine/request-timeout'

test('Work status deadline applies to both endpoint spellings, including explicit unlimited input', () => {
  for (const path of ['/chat/status', '/api/v1/chat/status', '/chat/status?sessionId=work-test']) {
    expect(managementRequestTimeout({ method: 'GET', path })).toBe(5000)
    expect(managementRequestTimeout({ method: 'GET', path, timeoutMs: 0 })).toBe(5000)
  }
  expect(managementRequestTimeout({ method: 'GET', path: '/chat/snapshot' })).toBe(120000)
  expect(managementRequestTimeout({ method: 'POST', path: '/chat' })).toBe(120000)
})
test('connection switches abort status and management requests immediately', () => {
  const connection = new AbortController()
  const signal = managementRequestSignal({ method: 'GET', path: '/chat/status' }, connection.signal)
  expect(signal.aborted).toBe(false)
  connection.abort(new Error('Connection switched'))
  expect(signal.aborted).toBe(true)
  expect(signal.reason.message).toBe('Connection switched')
})
