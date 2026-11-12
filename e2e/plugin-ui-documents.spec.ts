/** Pure protocol capability-store regressions; no Electron launch or filesystem document reads. */
import { expect, test } from '@playwright/test'
import { PluginUiDocuments } from '../src/main/plugin-ui-documents'
import { PLUGIN_UI_CSP } from '../src/shared/plugin-ui'

test('plugin UI document capabilities are opaque, exact, owner-revocable and bounded', () => {
  const documents = new PluginUiDocuments(), one = documents.create(1, '<h1>one</h1>'), two = documents.create(2, '<h1>two</h1>')
  expect(one.url).toMatch(/^aether-plugin-ui:\/\/document\/[a-f0-9-]{36}$/)
  expect(documents.read(one.url)?.html).toBe('<h1>one</h1>')
  for (const url of [one.url + '?path=C:/secret', one.url + '/..', one.url.replace('/document/', '/other/'), 'file:///C:/secret']) expect(documents.read(url)).toBeUndefined()
  documents.release(2, one.url)
  expect(documents.read(one.url)?.ownerId).toBe(1)
  documents.releaseOwner(1)
  expect(documents.read(one.url)).toBeUndefined()
  expect(documents.read(two.url)?.html).toBe('<h1>two</h1>')
  expect(() => documents.create(2, 'x'.repeat(1024 * 1024 + 1))).toThrow('大小限制')
  expect(() => documents.create(2, { path: 'C:/secret' })).toThrow('参数无效')
  for (let index = 1; index < 32; index++) documents.create(2, 'small')
  expect(() => documents.create(2, 'overflow')).toThrow('页面过多')
  documents.releaseOwner(2)
  expect(() => documents.create(2, 'fresh')).not.toThrow()
})

test('independent plugin response policy permits its own inline UI while blocking host privileges and network', () => {
  expect(PLUGIN_UI_CSP).toContain("script-src 'unsafe-inline'")
  expect(PLUGIN_UI_CSP).toContain("connect-src 'none'")
  expect(PLUGIN_UI_CSP).toContain("frame-src 'none'")
  expect(PLUGIN_UI_CSP).toContain('sandbox allow-scripts allow-forms')
  expect(PLUGIN_UI_CSP).toContain("form-action 'none'")
  expect(PLUGIN_UI_CSP).not.toContain('allow-same-origin')
})
