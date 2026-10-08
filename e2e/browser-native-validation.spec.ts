/** Pure browser boundary tests: executable URLs, context ownership, settings, viewport and native bounds. */
import { expect, test } from '@playwright/test'
import { DEFAULT_BROWSER_SETTINGS } from '../src/shared/browser'
import { clampBounds, contextsMatch, normalizeBrowserUrl, validateContext, validateSettings, validateViewport, validateZoom } from '../src/main/browser/validation'

test('browser address accepts development servers and normalizes ordinary hosts', () => {
  expect(normalizeBrowserUrl('localhost:3000/app?q=中文')).toBe('http://localhost:3000/app?q=%E4%B8%AD%E6%96%87')
  expect(normalizeBrowserUrl('127.0.0.1:4321')).toBe('http://127.0.0.1:4321/')
  expect(normalizeBrowserUrl('[::1]:5173')).toBe('http://[::1]:5173/')
  expect(normalizeBrowserUrl('example.com/path')).toBe('https://example.com/path')
  expect(normalizeBrowserUrl('https://example.com/#page')).toBe('https://example.com/#page')
  expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
})

test('browser address cannot execute code, read local files or smuggle credentials', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///C:/private.txt', 'aether:settings', 'ftp://example.com', 'https://user:password@example.com', 'https://example.com/\ninjected']) {
    expect(() => normalizeBrowserUrl(value), value).toThrow()
  }
})

test('tab ownership requires both engine and conversation identity', () => {
  const owner = { engineId: 'local-instance-1', sessionId: 'session-1' }
  expect(contextsMatch({ ...owner }, owner)).toBe(true)
  expect(contextsMatch(undefined, owner)).toBe(false)
  expect(contextsMatch({ ...owner, engineId: 'local-instance-2' }, owner)).toBe(false)
  expect(contextsMatch({ ...owner, sessionId: 'session-2' }, owner)).toBe(false)
  expect(() => validateContext({ sessionId: '', engineId: 'local' })).toThrow()
})

test('viewport validation rejects invalid and excessive native allocations', () => {
  expect(validateViewport(null)).toBeNull()
  const phone = { width: 390, height: 844, mobile: true, deviceScaleFactor: 2 }
  expect(validateViewport(phone)).toEqual(phone)
  for (const patch of [{ width: 0 }, { height: NaN }, { width: 390.5 }, { height: 50000 }, { deviceScaleFactor: 10 }]) {
    expect(() => validateViewport({ ...phone, ...patch })).toThrow()
  }
})

test('settings updates preserve unrelated fields and cannot save malformed data', () => {
  const settings = validateSettings(DEFAULT_BROWSER_SETTINGS, { homeUrl: 'localhost:8080', aiEnabled: false })
  expect(settings).toEqual({ ...DEFAULT_BROWSER_SETTINGS, homeUrl: 'http://localhost:8080/', aiEnabled: false })
  expect(DEFAULT_BROWSER_SETTINGS.aiEnabled).toBe(true)
  expect(() => validateSettings(DEFAULT_BROWSER_SETTINGS, { homeUrl: 'file:///etc/passwd' })).toThrow()
  expect(() => validateZoom(0)).toThrow()
  expect(() => validateZoom(Infinity)).toThrow()
  expect(validateZoom(1.25)).toBe(1.25)
})

test('native page bounds remain within the owned editor window', () => {
  expect(clampBounds({ x: 90.6, y: -20, width: 900, height: 900 }, { width: 800, height: 600 })).toEqual({ x: 91, y: 0, width: 709, height: 600 })
  expect(clampBounds({ x: 900, y: 900, width: 20, height: 20 }, { width: 800, height: 600 })).toEqual({ x: 800, y: 600, width: 0, height: 0 })
  expect(() => clampBounds({ x: NaN, y: 1, width: 10, height: 10 }, { width: 800, height: 600 })).toThrow()
})
