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
  expect(resourceCatalogueChange({ name: 'plugin_scaffold', success: true, metadata: { resourceChange: { kind: 'plugin', action: 'scaffold', id: 'report-helper' } } })).toEqual({ kind: 'plugin', action: 'scaffold', id: 'report-helper' })
  expect(resourceCatalogueChange({ name: 'plugin_scaffold', success: true, metadata: { resourceChange: { kind: 'plugin-project', action: 'scaffold', id: 'report-helper' } } })).toBeNull()
  expect(resourceCatalogueChange({ name: 'plugin_scaffold', success: false, metadata: { resourceChange: { kind: 'plugin', action: 'scaffold', id: 'report-helper' } } })).toBeNull()
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

test('batch plugin preview permits only its declared POST transport', () => {
  expect(remoteRequestError('remote','POST','/plugins/imports/preview-batch')).toBeNull()
  for (const method of ['GET','PUT','PATCH','DELETE'])
    expect(remoteRequestError('remote',method,'/plugins/imports/preview-batch'),method).not.toBeNull()
  expect(remoteRequestError('remote','POST','/plugins/imports/preview-batch/private')).not.toBeNull()
})

test('plugin catalogue subscription permits only the exact GET transport', () => {
  expect(remoteRequestError('remote', 'GET', '/plugins/runtime/changes')).toBeNull()
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
    expect(remoteRequestError('remote', method, '/plugins/runtime/changes'), method).not.toBeNull()
  expect(remoteRequestError('remote', 'GET', '/plugins/runtime/changes/private')).not.toBeNull()
})

test('developer mode permits only explicit transient source actions', () => {
  for (const path of ['/plugins/dev/open', '/plugins/dev/dev-session/refresh', '/plugins/dev/dev-session/invoke', '/plugins/dev/dev-session/close', '/plugins/dev/dev-session/capabilities/invoke', '/plugins/helper/capabilities/invoke'])
    expect(remoteRequestError('remote', 'POST', path), path).toBeNull()
  for (const [method, path] of [['GET', '/plugins/dev/open'], ['DELETE', '/plugins/dev/dev-session'], ['POST', '/plugins/dev/dev-session/publish'], ['POST', '/plugins/dev/../invoke'], ['POST', '/plugins/dev/dev-session/private']])
    expect(remoteRequestError('remote', method, path), `${method} ${path}`).not.toBeNull()
})
test('plugin permissions and capability catalogue allow only declared methods', () => {
  expect(remoteRequestError('remote', 'GET', '/plugins/project/capabilities')).toBeNull()
  expect(remoteRequestError('remote', 'PUT', '/plugins/helper/permissions')).toBeNull()
  expect(remoteRequestError('remote', 'PUT', '/plugins/dev/dev-session/permissions')).toBeNull()
  expect(remoteRequestError('remote', 'POST', '/plugins/project/capabilities')).not.toBeNull()
  expect(remoteRequestError('remote', 'GET', '/plugins/helper/permissions')).not.toBeNull()
  expect(remoteRequestError('remote', 'GET', '/plugins/helper/capabilities/invoke')).not.toBeNull()
})

test('AI and Agent streams use only the declared installed and development POST endpoints', () => {
  for (const path of ['/plugins/helper/capabilities/stream', '/plugins/dev/dev-session/capabilities/stream']) {
    expect(remoteRequestError('remote', 'POST', path)).toBeNull()
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) expect(remoteRequestError('remote', method, path)).not.toBeNull()
    expect(remoteRequestError('remote', 'POST', path + '/private')).not.toBeNull()
  }
})

test('plugin Agent tool management exposes only exact GET and PUT paths', () => {
  for (const path of ['/plugins/helper/agent-tools', '/plugins/dev/dev-session/agent-tools']) {
    expect(remoteRequestError('remote', 'GET', path)).toBeNull()
    expect(remoteRequestError('remote', 'PUT', path)).toBeNull()
    expect(remoteRequestError('remote', 'POST', path)).not.toBeNull()
    expect(remoteRequestError('remote', 'GET', path + '/other')).not.toBeNull()
  }
})

test('trusted plugin confirmation transport exposes only exact POST resume routes', () => {
  for (const path of ['/plugins/helper/agents/outer-run/respond', '/plugins/dev/dev-session/agents/outer-run/respond']) {
    expect(remoteRequestError('remote', 'POST', path)).toBeNull()
    expect(remoteRequestError('remote', 'GET', path)).not.toBeNull()
    expect(remoteRequestError('remote', 'POST', path + '/arbitrary')).not.toBeNull()
  }
})

test('remote collaboration controller accepts only exact POST mailbox writes', () => {
  const path = '/collaboration/roots/root-run/messages'
  expect(remoteRequestError('remote', 'POST', path)).toBeNull()
  expect(remoteRequestError('remote', 'GET', path)).not.toBeNull()
  expect(remoteRequestError('remote', 'POST', path + '/arbitrary')).not.toBeNull()
})
