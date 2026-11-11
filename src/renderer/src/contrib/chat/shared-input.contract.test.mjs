import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// Pure payload and real JSX callback contracts; Electron owns DOM/caret coverage.
const directory = dirname(fileURLToPath(import.meta.url))
const cache = new Map()
const react = {
  memo: value => value,
  useMemo: compute => compute(),
  useRef: value => ({ current: value }),
  useState: value => [value, () => {}],
  useId: () => 'test-id',
  useLayoutEffect: () => {}
}
const jsx = (type, props) => ({ type, props })
function load(relative) {
  const path = resolve(directory, relative)
  if (cache.has(path)) return cache.get(path)
  const exports = {}
  cache.set(path, exports)
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  new vm.Script(`(function(require,exports){${code}\n})`, { filename: path }).runInThisContext()(name => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name.startsWith('.')) {
      const target = resolve(dirname(path), name)
      return load(['.ts', '.tsx', ''].map(ext => target + ext).find(existsSync))
    }
    return {}
  }, exports)
  return exports
}
const attachments = load('useAttachments.ts')
const mentions = load('mention-context.ts')
const limits = load('input-limits.ts')
const { UserMessageContent } = load('UserMessageContent.tsx')
const { assertQueueEnvelope } = load('../../../../shared/next-turn-queue-state.ts')

function nodes(value, found = []) {
  if (!value || typeof value !== 'object') return found
  if ('type' in value && 'props' in value) found.push(value)
  for (const child of Object.values(value)) nodes(child, found)
  return found
}

test('one paste becomes an attachment above 1000 Unicode code points regardless of line count', () => {
  for (const character of ['a', '中', '😀']) {
    assert.equal(attachments.shouldAttachPastedText(character.repeat(1000)), false)
    assert.equal(attachments.shouldAttachPastedText(character.repeat(1001)), true)
  }
  assert.equal(attachments.shouldAttachPastedText('\n'.repeat(900)), false)
  assert.equal(attachments.shouldAttachPastedText('\n'.repeat(1001)), true)
})

test('pasted TXT above 100000 characters preserves all bytes, whitespace, CRLF, emoji and the tail', async () => {
  const text = '  # 标题 😀\r\n' + '内容\r\n'.repeat(40_000) + '\u0000\tEND  \n'
  assert.ok(Array.from(text).length > 100_000)
  const file = attachments.createPastedTextFile(text)
  assert.equal(file.name.endsWith('.txt'), true)
  assert.equal(file.type, 'text/plain;charset=utf-8')
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new TextEncoder().encode(text))
})

test('the editor limits only Unicode prose and excludes real reference tokens and snapshots', () => {
  const full = '😀'.repeat(limits.COMPOSER_MAX_CHARS)
  const file = { source: 'file', origin: 'attachment', path: 'very-long-path/'.repeat(2000) + 'notes.txt', displayText: '资料', textOffset: full.length }
  const snapshot = { source: 'code', origin: 'workspace', path: 'src/main.ts', displayText: '源码', content: 'snapshot'.repeat(20_000) }
  const fileToken = mentions.mentionToken(file), snapshotToken = mentions.mentionToken(snapshot)
  snapshot.textOffset = full.length + fileToken.length
  const withReferences = { text: full + fileToken + snapshotToken, mentions: [file, snapshot] }
  assert.equal(limits.composerCharacterCount(full), 100_000)
  assert.equal(limits.composerCharacterCount(withReferences.text, withReferences.mentions), 100_000)
  assert.equal(limits.acceptsComposerChange({ text: full, mentions: [] }, withReferences), true)
  assert.equal(limits.acceptsComposerChange(withReferences, { ...withReferences, text: withReferences.text + '中' }), false)
  assert.equal(limits.acceptsComposerChange({ text: full, mentions: [] }, { text: full.slice(2) + '中', mentions: [] }), true)
  assert.equal(limits.composerCharacterCount(withReferences.text, [{ ...file, textOffset: 1 }]), Array.from(withReferences.text).length)
  assert.equal(limits.composerCharacterCount(full + '@not-a-real-ref', [file]), 100_015)
})

test('legacy oversized editor drafts may shrink without forced truncation or blocking a same-size replacement', () => {
  const oversized = { text: '中'.repeat(100_000) + '旧草稿', mentions: [] }
  assert.equal(limits.acceptsComposerChange(oversized, { ...oversized, text: oversized.text + '增' }), false)
  assert.equal(limits.acceptsComposerChange(oversized, { ...oversized, text: oversized.text.slice(0, -1) }), true)
  assert.equal(limits.acceptsComposerChange(oversized, { ...oversized, text: oversized.text.slice(0, -1) + '新' }), true)
  assert.equal(oversized.text.length, 100_003)
})

test('one valid chip separator costs no prose capacity and deleting the chip never traps the draft', () => {
  const prose = 'a'.repeat(99_999)
  const ref = { source: 'file', origin: 'attachment', path: 'notes.txt', displayText: '资料', textOffset: prose.length }
  const token = mentions.mentionToken(ref)
  for (const separator of [' ', '\u00a0']) {
    const before = { text: prose + token + separator, mentions: [ref] }
    const full = { ...before, text: before.text + 'x' }
    assert.equal(limits.composerCharacterCount(before.text, before.mentions), 99_999)
    assert.equal(limits.composerCharacterCount(full.text, full.mentions), 100_000)
    assert.equal(limits.acceptsComposerChange(before, full), true)
    assert.equal(limits.acceptsComposerChange(full, { ...full, text: full.text + 'y' }), false)
    assert.equal(limits.composerCharacterCount(prose + token + separator + separator, [ref]), 100_000)
    const deleted = { text: prose + separator + 'x', mentions: [] }
    assert.equal(limits.composerCharacterCount(deleted.text, deleted.mentions), 100_001)
    assert.equal(limits.acceptsComposerChange(full, deleted), true)
    assert.equal(limits.acceptsComposerChange(deleted, { ...deleted, text: deleted.text + 'y' }), false)
    const short = { text: 'short', mentions: [] }
    assert.equal(limits.acceptsComposerChange(deleted, short), true)
    assert.equal(limits.acceptsComposerChange(short, { ...short, text: 'shorter draft' }), true)
  }
  assert.equal(limits.composerCharacterCount(prose + token + ' ', [{ ...ref, textOffset: 0 }]), 100_010)
})

test('each reference origin survives send, history replay, draft restoration and resending', () => {
  for (const origin of ['workspace', 'attachment', 'artifact']) {
    const ref = { source: 'file', origin, displayText: '粘贴的文本.txt', path: '.ae/attachments/真实名字.txt', textOffset: '检查 '.length }
    const text = `检查 @${ref.path} 后回复`
    const sent = mentions.buildMentionMessage(text, [ref])
    assert.equal(mentions.parseMentionContent(sent).refs[0].o, origin)
    assert.deepEqual(mentions.userMessageDraft(sent), { text, mentions: [ref] })
    const restored = mentions.userMessageDraft(sent)
    assert.equal(mentions.buildMentionMessage(restored.text, restored.mentions), sent)
    assert.equal(sent.includes('<reference'), false)
  }
})

test('legacy origins remain optional while invalid stored origins cannot become actionable refs', () => {
  const ref = { source: 'file', displayText: 'A', path: 'a.txt' }
  assert.equal(mentions.isStoredMention(ref), true)
  assert.equal(mentions.isStoredMention({ ...ref, origin: 'outside' }), false)
  const sent = mentions.buildMentionMessage('@a.txt', [{ ...ref, origin: 'attachment' }])
  assert.deepEqual(mentions.parseMentionContent(sent.replace('"o":"attachment"', '"o":"outside"')).refs, [])
  assert.equal(mentions.sameMention(ref, { ...ref, origin: 'attachment' }), false)
})

test('rendered reference activation returns exact origin, source range and frozen snapshot', () => {
  const ref = { source: 'code', origin: 'workspace', displayText: '源码选区', path: 'src/app.ts', startLine: 2, endLine: 3, startColumn: 7, endColumn: 2, content: '旧内容\n```\n😀' }
  const content = mentions.buildMentionMessage(`检查 ${mentions.mentionToken(ref)}`, [ref])
  const opened = []
  const chip = nodes(UserMessageContent({ content, onOpenMention: mention => opened.push(mention) })).find(node => node.props.role === 'button')
  assert.equal(chip.props['aria-label'], '查看引用：源码选区')
  assert.equal(chip.props.tabIndex, 0)
  chip.props.onClick()
  for (const key of ['Enter', ' ']) {
    let prevented = false, stopped = false
    chip.props.onKeyDown({ key, preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
    assert.equal(prevented, true)
    assert.equal(stopped, true)
  }
  assert.deepEqual(opened, [ref, ref, ref])
  const passive = nodes(UserMessageContent({ content })).filter(node => node.props.role === 'button')
  assert.equal(passive.length, 0)
})

test('snapshot recovery without metadata still opens the original body', () => {
  const ref = { source: 'terminal', displayText: '终端', path: '.ae/output.txt', content: 'stdout\n<reference>\n完整尾部' }
  const content = mentions.formatReferenceBlock(ref, ref.content)
  let opened
  const chip = nodes(UserMessageContent({ content, onOpenMention: value => { opened = value } })).find(node => node.props.role === 'button')
  chip.props.onClick()
  assert.equal(opened.content, ref.content)
  assert.equal(opened.source, 'terminal')
  assert.equal(opened.path, ref.path)
})

test('queued references accept each known origin and reject unsupported origin metadata', () => {
  const scope = { source: { mode: 'embedded', endpoint: '', accountId: null }, tenantId: 'default', namespace: { id: 'n', generation: 'g' }, owner: 'work', taskId: 'task' }
  const envelope = {
    draft: { text: '@a.txt', revision: 0, mentions: [{ source: 'file', displayText: 'A', path: 'a.txt', textOffset: 0 }] },
    model: { kind: 'engine-default' }, workspace: { kind: 'local-workspace', identity: 'D:/workspace' },
    agent: { primaryAgentId: null, collaborators: [] },
    resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'inherit' }, knowledgeBases: { kind: 'inherit' } },
    thinking: { kind: 'inherit' }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: []
  }
  assert.doesNotThrow(() => assertQueueEnvelope(envelope, scope))
  for (const origin of ['workspace', 'attachment', 'artifact']) {
    envelope.draft.mentions[0].origin = origin
    assert.doesNotThrow(() => assertQueueEnvelope(envelope, scope))
  }
  envelope.draft.mentions[0].origin = 'outside'
  assert.throws(() => assertQueueEnvelope(envelope, scope), /mention origin is invalid/)
})
