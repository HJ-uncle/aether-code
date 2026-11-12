import { expect, test } from '@playwright/test'
import { isPluginToolkitId, parseToolkitCatalogue } from '../src/shared/toolkits'
import { buildMentionMessage, userMessageDraft, mentionToken } from '../src/renderer/src/features/conversation/shared/mention-context'
import { draftToolkitIds, editDraftToolkits } from '../src/renderer/src/features/composer/toolkit-mentions'
import { parsePluginDraft, pluginExampleArgs } from '../src/renderer/src/core/engine/plugins'
import { newPlugin } from './fixtures/plugin'
import { resourceCatalogueChange } from '../src/renderer/src/core/engine/resource-catalogue'
import { remoteRequestError } from '../src/main/engine/protocol'

test('dynamic plugin catalogue accepts only pinned validated identities with engine availability', () => {
  const plugin = { id: 'plugin-report-helper--r12', name: '报告助手', description: '整理报告', toolNames: ['plugin_report_helper_summarize'], available: true }
  expect(parseToolkitCatalogue({ toolkits: [plugin, plugin, { ...plugin, id: 'arbitrary' }, { ...plugin, id: 'plugin-escape--r0' }] })).toEqual([plugin])
  expect(isPluginToolkitId('plugin-report-helper--r12')).toBe(true)
  expect(isPluginToolkitId('plugin-3d-tools--r1')).toBe(true)
  expect(isPluginToolkitId('plugin-../../file--r1')).toBe(false)
})
test('plugin label survives draft and history while ordinary text never selects it', () => {
  const mention = { source: 'toolkit' as const, path: 'plugin-report-helper--r12', displayText: '报告助手', textOffset: 0 }
  const text = mentionToken(mention), draft = { text, mentions: [mention] }
  expect(userMessageDraft(buildMentionMessage(text, [mention])).mentions[0].displayText).toBe('报告助手')
  expect(draftToolkitIds(draft)).toEqual([mention.path])
  expect(editDraftToolkits([], { text: '', mentions: [] }, { text, mentions: [] })).toEqual([])
  expect(editDraftToolkits([], draft, { ...draft, text: `${text} 普通编辑` })).toEqual([])
  expect(editDraftToolkits([mention.path], draft, { text: '', mentions: [] })).toEqual([])
})
test('plugin editor preserves files, blocks path traversal and exposes JSON syntax errors', () => {
  const draft = newPlugin()
  expect(parsePluginDraft(JSON.stringify(draft.manifest), draft.files)).toEqual(draft)
  expect(() => parsePluginDraft('{broken', draft.files)).toThrow()
  expect(() => parsePluginDraft(JSON.stringify(draft.manifest), { '../escape.mjs': 'export default () => 1' })).toThrow('相对路径')
})
test('only successful structured plugin receipts trigger catalogue refresh', () => {
  expect(resourceCatalogueChange({ name: 'plugin_publish', success: true, metadata: { resourceChange: { kind: 'plugin', action: 'publish', id: 'report-helper' } } })).toEqual({ kind: 'plugin', action: 'publish', id: 'report-helper' })
  expect(resourceCatalogueChange({ name: 'mcp_plugin_publish', success: true, metadata: { resourceChange: { kind: 'plugin', action: 'publish', id: 'report-helper' } } })).toBeNull()
  expect(resourceCatalogueChange({ name: 'plugin_import_install', success: true, metadata: { resourceChange: { kind: 'plugin', action: 'import_install', id: 'report-helper' } } })).toEqual({ kind: 'plugin', action: 'import_install', id: 'report-helper' })
})

test('selecting a new plugin revision replaces its prior selection without enabling historical labels', () => {
  const before = { text: '', mentions: [] }, mention = { source: 'toolkit' as const, path: 'plugin-report-helper--r13', displayText: '报告助手', textOffset: 0 }
  expect(editDraftToolkits(['automation','plugin-report-helper--r12'], before, { text: mentionToken(mention), mentions: [mention] })).toEqual(['automation','plugin-report-helper--r13'])
})

test('remote plugin transport admits only declared engine-side CRUD, import and test endpoints', () => {
  for (const [method,path] of [['GET','/plugins'],['POST','/plugins'],['GET','/plugins/project/templates'],['GET','/plugins/project/templates/json-tool'],['GET','/plugins/project/exports/helper?revision=2'],['GET','/plugins/project/exports/imports?revision=1'],['GET','/plugins/3d-tools'],['PUT','/plugins/helper'],['PATCH','/plugins/helper'],['DELETE','/plugins/helper'],['POST','/plugins/helper/publish'],['POST','/plugins/helper/test'],['POST','/plugins/imports/preview'],['GET','/plugins/imports/job-id'],['POST','/plugins/imports/job-id/install'],['DELETE','/plugins/imports/job-id'],['GET','/plugins/templates'],['PUT','/plugins/templates'],['GET','/plugins/project'],['GET','/plugins/imports'],['PUT','/plugins/imports']])
    expect(remoteRequestError('remote',method,path),`${method} ${path}`).toBeNull()
  for (const [method,path] of [['POST','/plugins/helper'],['GET','/plugins/helper/test'],['PUT','/plugins'],['POST','/plugins/imports/job-id/delete'],['GET','/plugins/helper/private'],['PUT','/plugins/project/templates'],['DELETE','/plugins/project/templates'],['POST','/plugins/project/templates/json-tool'],['GET','/plugins/project/templates/json-tool/private'],['POST','/plugins/project/exports/helper'],['GET','/plugins/project/exports'],['GET','/plugins/project/exports/helper/private']])
    expect(remoteRequestError('remote',method,path),`${method} ${path}`).not.toBeNull()
})

test('template examples prefill exact local tool arguments while invalid drafts remain editable', () => {
  const files = { 'examples/cases.json': JSON.stringify({ cases: [{ tool: 'other', args: {} }, { tool: 'normalize_text', args: { text: '  你好 🌟  ' } }] }) }
  expect(JSON.parse(pluginExampleArgs(files,'normalize_text'))).toEqual({ text: '  你好 🌟  ' })
  expect(pluginExampleArgs(files,'missing')).toBe('{}')
  expect(pluginExampleArgs({ 'examples/cases.json': '{broken' },'normalize_text')).toBe('{}')
})
