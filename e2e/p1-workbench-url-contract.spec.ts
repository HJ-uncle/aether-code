/** Exact workbench-document boundaries used by preload and renderer IPC. */
import { expect, test } from '@playwright/test'
import { isTrustedWorkbenchUrl } from '../src/shared/workbench-url'

test('workbench file privileges allow document state, reject sibling and remote documents', () => {
  const entry = 'file:///D:/dev/aether-code/out/renderer/index.html'
  expect(isTrustedWorkbenchUrl(`${entry}?view=work#monitor`, entry)).toBe(true)
  for (const actual of [
    'file:///D:/dev/aether-code/out/renderer/other.html',
    'file:///D:/dev/aether-code/out/renderer/index.html.evil',
    'https://example.test/index.html', 'about:blank', 'not a URL'
  ]) expect(isTrustedWorkbenchUrl(actual, entry), actual).toBe(false)
})

test('development privileges require the exact origin and entry path', () => {
  const entry = 'http://localhost:5173/'
  expect(isTrustedWorkbenchUrl(`${entry}?reload=1#work`, entry)).toBe(true)
  for (const actual of [
    'http://localhost:5174/', 'http://localhost:5173/external',
    'https://localhost:5173/', 'http://localhost:5173.evil.test/',
    'http://user:secret@localhost:5173/'
  ]) expect(isTrustedWorkbenchUrl(actual, entry), actual).toBe(false)
  expect(isTrustedWorkbenchUrl('data:text/html,hello', 'data:text/html,hello')).toBe(false)
})
