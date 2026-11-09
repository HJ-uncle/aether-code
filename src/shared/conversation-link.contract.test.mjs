import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const exports = {}
const file = fileURLToPath(new URL('./conversation-link.ts', import.meta.url))
const code = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
vm.runInNewContext('(function(exports) {' + code + '\n})', { URL })(exports)
const { buildConversationLink, parseConversationLink } = exports
const plain = value => JSON.parse(JSON.stringify(value))

test('local anonymous, account and remote endpoint identities roundtrip exactly', () => {
  for (const source of ['', ':account:local-user', 'remote:https://example.com:8443/api',
    'remote:https://example.com:8443/base/path:account:remote-user', 'remote:http://[::1]:12323']) {
    const reference = { sessionId: 'work-home-abc_123:copy', mode: 'work', source }
    const url = buildConversationLink(reference)
    assert.ok(url.startsWith('aether://conversation/'))
    assert.deepEqual(plain(parseConversationLink(url)), reference)
    assert.equal(new URL(url).searchParams.has('title'), false)
  }
})

test('whole URLs require known mode, exact destination and explicit source even when empty', () => {
  const valid = buildConversationLink({ sessionId: 'work-1', source: '', mode: 'work' })
  for (const value of [null, {}, 'work-1', ` ${valid}`, `${valid}\n`, `请查看 ${valid}`, valid + '&extra=1',
    valid + '&mode=work', valid + '&source=', valid + '#fragment', valid.replace('mode=work&', ''),
    valid.replace('&source=', ''), valid.replace('mode=work', 'mode=code'), valid.replace('conversation/', 'other/'),
    valid.replace('aether:', 'https:'), valid.replace('conversation/', 'user:pass@conversation/'),
    valid.replace('/work-1', '/x/../work-1'), valid.replace('/work-1', '/%2e%2e/work-1'),
    valid.replace('/work-1', '/work%2Fother'), valid.replace('/work-1', '/bad%00id'),
    valid.replace('/work-1', '/bad%id'), valid.replace('/work-1', '/' + 'x'.repeat(257)), 'x'.repeat(8193)]) {
    assert.equal(parseConversationLink(value), null, String(value).slice(0, 120))
  }
})

test('links cannot embed credentials, arbitrary URL sources or control characters', () => {
  for (const source of ['local', 'https://example.com', 'remote:file:///secret', 'remote:javascript:alert(1)',
    'remote:https://user:password@example.com', 'remote:https://example.com?token=secret',
    'remote:https://example.com#token', 'remote:http:\\example.com', 'remote:https://example.com/%zz',
    'remote:https://example.com:account:', ':account:', ':account:bad\nuser', ':account:' + 'x'.repeat(257)]) {
    assert.throws(() => buildConversationLink({ sessionId: 'work-1', mode: 'work', source }))
    const url = new URL('aether://conversation/work-1?mode=work')
    url.searchParams.set('source', source)
    assert.equal(parseConversationLink(url.href), null, source)
  }
})
