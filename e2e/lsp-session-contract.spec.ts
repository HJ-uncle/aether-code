/** Pure LSP lifecycle contracts: a session is reusable only on the same root and transport. */
import { expect, test } from '@playwright/test'
import { canReuseLspSession } from '../src/renderer/src/core/lsp/session-state'

test('same-root local session is reusable', () => {
  expect(canReuseLspSession(true, 'D:/project', 'local', 'D:/project', 'local')).toBe(true)
})

test('same-root local and remote sessions are never treated as interchangeable', () => {
  expect(canReuseLspSession(true, 'D:/project', 'local', 'D:/project', 'remote')).toBe(false)
  expect(canReuseLspSession(true, 'D:/project', 'remote', 'D:/project', 'local')).toBe(false)
})

test('a root change or stopped session always requires a new language service', () => {
  expect(canReuseLspSession(true, 'D:/old-project', 'remote', 'D:/new-project', 'remote')).toBe(false)
  expect(canReuseLspSession(false, 'D:/project', 'remote', 'D:/project', 'remote')).toBe(false)
})
