import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const directory = dirname(fileURLToPath(import.meta.url))
const cache = new Map()
function load(path) {
  if (cache.has(path)) return cache.get(path)
  const exports = {}
  cache.set(path, exports)
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new vm.Script(`(function(require,exports){${code}\n})`, { filename: path }).runInThisContext()(name => {
    if (name.startsWith('.')) return load(resolve(dirname(path), `${name}.ts`))
    if (name.startsWith('@renderer/')) return load(resolve(directory, '../..', `${name.slice('@renderer/'.length)}.ts`))
    throw new Error(`Unexpected dependency: ${name}`)
  }, exports)
  return exports
}
const { appendWorkMentions, workspaceReferenceMentions } = load(resolve(directory, 'work-reference-draft.ts'))
const { mentionToken, buildMentionMessage, userMessageDraft } = load(resolve(directory, '../chat/mention-context.ts'))

test('appending keeps draft bytes and existing reference offsets while anchoring every new token', () => {
  const old = { source: 'file', origin: 'workspace', path: 'old.ts', displayText: 'old.ts', textOffset: 4 }
  const draft = { text: ' 先读 @old.ts\r\n\t', mentions: [old] }
  const incoming = [
    { source: 'code', origin: 'workspace', path: 'src/main.ts', displayText: 'main.ts:2-3', startLine: 2, endLine: 3, content: 'selected\r\ntext', textOffset: 999 },
    { source: 'dir', origin: 'workspace', path: 'docs', displayText: 'docs' }
  ]
  const original = structuredClone({ draft, incoming })
  const result = appendWorkMentions(draft, incoming)
  assert.equal(result.text.slice(0, draft.text.length), draft.text)
  assert.deepEqual(result.mentions[0], old)
  assert.equal(result.mentions[1].textOffset, draft.text.length)
  for (const mention of result.mentions) assert.equal(result.text.slice(mention.textOffset, mention.textOffset + mentionToken(mention).length), mentionToken(mention))
  assert.deepEqual({ draft, incoming }, original)
  const restored = userMessageDraft(buildMentionMessage(result.text, result.mentions))
  assert.deepEqual(restored.mentions.map(mention => ({ source: mention.source, path: mention.path, content: mention.content })),
    result.mentions.map(mention => ({ source: mention.source, path: mention.path, content: mention.content })))
})

test('adjacent references add only required spacing and keep distinct snapshots', () => {
  const incoming = [
    { source: 'code', path: 'a.ts', displayText: 'a.ts:1', startLine: 1, content: 'first' },
    { source: 'code', path: 'a.ts', displayText: 'a.ts:1', startLine: 1, content: 'second' }
  ]
  const result = appendWorkMentions({ text: '继续', mentions: [] }, incoming)
  assert.equal(result.text, '继续 @a.ts:1 @a.ts:1 ')
  assert.deepEqual(result.mentions.map(mention => mention.textOffset), [3, 11])
  assert.deepEqual(result.mentions.map(mention => mention.content), ['first', 'second'])
})

test('workspace paths become relative only beneath that exact workspace and preserve item kinds', () => {
  const refs = workspaceReferenceMentions([
    { path: '/remote/task/src/main.ts', kind: 'file' },
    { path: '/remote/task/docs', kind: 'directory' },
    { path: '/remote/task', kind: 'directory' },
    { path: '/remote/task-other/main.ts', kind: 'file' },
    { path: '/Remote/task/main.ts', kind: 'file' }
  ], '/remote/task/')
  assert.deepEqual(refs.map(ref => ({ path: ref.path, source: ref.source, origin: ref.origin })), [
    { path: 'src/main.ts', source: 'file', origin: 'workspace' },
    { path: 'docs', source: 'dir', origin: 'workspace' },
    { path: '/remote/task', source: 'dir', origin: 'workspace' },
    { path: '/remote/task-other/main.ts', source: 'file', origin: 'workspace' },
    { path: '/Remote/task/main.ts', source: 'file', origin: 'workspace' }
  ])
  assert.equal(refs[0].displayText, 'src/main.ts')
  assert.equal(refs[2].displayText.length > 0, true)
  assert.equal(workspaceReferenceMentions([{ path: '/remote/task/main.ts', kind: 'file' }], null)[0].path, '/remote/task/main.ts')
})

test('Windows path identity ignores drive-letter casing and mixed separators without losing root references', () => {
  const refs = workspaceReferenceMentions([
    { path: 'D:\\Task\\src\\main.ts', kind: 'file' },
    { path: 'd:/task/src/main.ts', kind: 'file' },
    { path: 'd:/TASK/docs', kind: 'directory' },
    { path: 'D:\\Task', kind: 'directory' }
  ], 'D:/Task/')
  assert.deepEqual(refs.map(ref => [ref.path, ref.source]), [['src/main.ts', 'file'], ['docs', 'dir'], ['D:\\Task', 'dir']])
})

test('UNC references share tree identity while retaining filename case and an absolute root', () => {
  const refs = workspaceReferenceMentions([
    { path: '\\\\Server\\Share\\Task\\Src\\Main.ts', kind: 'file' },
    { path: '//server/share/task/src/main.ts', kind: 'file' },
    { path: '//SERVER//Share/Task///Docs/', kind: 'directory' },
    { path: '\\\\Server\\Share\\Task', kind: 'directory' },
    { path: '//server/share/TASK/', kind: 'directory' },
    { path: '//server/share/task-other/Other.ts', kind: 'file' }
  ], '//server//share/Task/')
  assert.deepEqual(refs.map(ref => [ref.path, ref.source]), [
    ['Src/Main.ts', 'file'], ['Docs', 'dir'], ['\\\\Server\\Share\\Task', 'dir'],
    ['//server/share/task-other/Other.ts', 'file']
  ])
})

test('separator aliases do not change relative slicing or POSIX case sensitivity', () => {
  const refs = workspaceReferenceMentions([
    { path: '/remote//task/Src///Main.ts', kind: 'file' },
    { path: '/remote/task/Src/Main.ts', kind: 'file' },
    { path: '/remote/task/src/main.ts', kind: 'file' },
    { path: '/Remote/task/Src/Main.ts', kind: 'file' }
  ], '/remote///task/')
  assert.deepEqual(refs.map(ref => ref.path), ['Src/Main.ts', 'src/main.ts', '/Remote/task/Src/Main.ts'])
  assert.equal(workspaceReferenceMentions([{ path: 'D:\\Task\\Src\\Main.ts', kind: 'file' }], 'd:////task/')[0].path, 'Src/Main.ts')
})

test('filesystem roots stay absolute and traversal or foreign roots are never rebased', () => {
  const refs = workspaceReferenceMentions([
    { path: '/', kind: 'directory' },
    { path: '/tmp/Report.txt', kind: 'file' },
    { path: '/tmp/../private.txt', kind: 'file' },
    { path: '/tmp/./Report.txt', kind: 'file' },
    { path: '//server/share/Report.txt', kind: 'file' },
    { path: 'D:/Report.txt', kind: 'file' }
  ], '/')
  assert.deepEqual(refs.map(ref => ref.path), [
    '/', 'tmp/Report.txt', '/tmp/../private.txt', '/tmp/./Report.txt',
    '//server/share/Report.txt', 'D:/Report.txt'
  ])
  assert.deepEqual(workspaceReferenceMentions([
    { path: 'D:\\', kind: 'directory' },
    { path: 'd:/Report.txt', kind: 'file' }
  ], 'D:/').map(ref => ref.path), ['D:\\', 'Report.txt'])
})
