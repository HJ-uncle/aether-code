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
const limits = load('input-limits.ts')
const attachments = load('useAttachments.ts')
const mentions = load('mention-context.ts')
const { UserMessageContent } = load('UserMessageContent.tsx')
const { assertQueueEnvelope } = load('../../../../shared/next-turn-queue-state.ts')

function nodes(value, found = []) {
  if (!value || typeof value !== 'object') return found
  if ('type' in value && 'props' in value) found.push(value)
  for (const child of Object.values(value)) nodes(child, found)
  return found
}

test('the paste threshold is strictly 1000 Unicode code points and ignores line count', () => {
  for (const char of ['a', '中', '😀']) {
    assert.equal(attachments.shouldAttachPastedText(char.repeat(1000)), false)
    assert.equal(attachments.shouldAttachPastedText(char.repeat(1001)), true)
  }
  assert.equal(attachments.shouldAttachPastedText('\n'.repeat(900)), false)
})

test('pasted TXT preserves all bytes, leading whitespace, CRLF, emoji and the entire tail', async () => {
  const text = '  # 标题 😀\r\n' + '内容\r\n'.repeat(400) + '\u0000\tEND  \n'
  const file = attachments.createPastedTextFile(text)
  assert.equal(file.name.endsWith('.txt'), true)
  assert.equal(file.type, 'text/plain;charset=utf-8')
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new TextEncoder().encode(text))
})

test('100000 code points are accepted; rejected changes never truncate and old oversized drafts may shrink', () => {
  const full = '😀'.repeat(limits.COMPOSER_MAX_CHARS)
  assert.equal(limits.composerCharacterCount(full), 100000)
  assert.equal(limits.composerInputIssue(full), null)
  assert.match(limits.composerInputIssue(full + '中'), /100,000.*字符/)
  assert.equal(limits.acceptsComposerChange(full, full + '中'), false)
  assert.equal(limits.acceptsComposerChange(full + '多余', full + '余'), true)
  assert.equal(limits.acceptsComposerChange(full + '余', full + '更多'), false)
  assert.equal(limits.acceptsComposerChange(full + '余', full + '换'), true)
  assert.equal(full.length, 200000)
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
