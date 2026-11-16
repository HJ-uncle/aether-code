/** Pure protocol capability-store regressions; no Electron launch or filesystem document reads. */
import { expect, test } from '@playwright/test'
import { PluginUiDocuments } from '../src/main/plugin-ui-documents'
import { PLUGIN_UI_CSP } from '../src/shared/plugin-ui'
import { decodePluginDownload } from '../src/main/plugin-download'

test('plugin UI document capabilities are opaque, exact, owner-revocable without arbitrary document budgets', () => {
  const documents = new PluginUiDocuments(), one = documents.create(1, '<h1>one</h1>'), two = documents.create(2, '<h1>two</h1>')
  expect(one.url).toMatch(/^aether-plugin-ui:\/\/document\/[a-f0-9-]{36}$/)
  expect(documents.read(one.url)?.html).toBe('<h1>one</h1>')
  for (const url of [one.url + '?path=C:/secret', one.url + '/..', one.url.replace('/document/', '/other/'), 'file:///C:/secret']) expect(documents.read(url)).toBeUndefined()
  documents.release(2, one.url)
  expect(documents.read(one.url)?.ownerId).toBe(1)
  documents.releaseOwner(1)
  expect(documents.read(one.url)).toBeUndefined()
  expect(documents.read(two.url)?.html).toBe('<h1>two</h1>')
  const large = 'x'.repeat(1024 * 1024 + 1), big = documents.create(2, large)
  expect(documents.read(big.url)?.html).toBe(large)
  expect(() => documents.create(2, { path: 'C:/secret' })).toThrow('参数无效')
  for (let index = 1; index < 32; index++) documents.create(2, 'small')
  const additional = documents.create(2, 'additional')
  expect(documents.read(additional.url)?.html).toBe('additional')
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

test('plugin downloads preserve large bytes while rejecting paths, devices and invalid base64', () => {
  expect(decodePluginDownload({ fileName: '报告😀.json', content: '中文😀' }).bytes.toString()).toBe('中文😀')
  const binary = Buffer.from([0, 255, 137, 80, 78, 71])
  expect(decodePluginDownload({ fileName: 'image.png', content: binary.toString('base64'), encoding: 'base64' }).bytes).toEqual(binary)
  for (const fileName of ['../escape', 'C:\\file', '/file', 'name:stream', 'NUL', 'con.txt', 'LPT¹.png', 'trailing.', 'trailing ', '\nfile', ''])
    expect(() => decodePluginDownload({ fileName, content: 'x' })).toThrow()
  for (const content of ['a', 'ab==', 'a===', 'YQ= ', '-_==', 'YWJj\n'])
    expect(() => decodePluginDownload({ fileName: 'file.bin', content, encoding: 'base64' })).toThrow()
  expect(decodePluginDownload({ fileName: 'large.txt', content: '中'.repeat(6 * 1024 * 1024) }).bytes.length).toBe(18 * 1024 * 1024)
  expect(decodePluginDownload({ fileName: 'large.bin', content: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64'), encoding: 'base64' }).bytes.length).toBe(16 * 1024 * 1024 + 1)
})
