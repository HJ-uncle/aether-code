import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const directory = dirname(fileURLToPath(import.meta.url))
const modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const exports = {}
  modules.set(name, exports)
  const javascript = ts.transpileModule(readFileSync(join(directory, `${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new vm.Script(`(function(require,exports){${javascript}\n})`).runInThisContext()(dependency => {
    if (dependency.startsWith('@shared/')) return load(`../../../../../shared/${dependency.slice('@shared/'.length)}`)
    if (dependency !== './mention-context') throw new Error(`Unexpected dependency: ${dependency}`)
    return load('mention-context')
  }, exports)
  return exports
}
const { appendMessageDraft, restoreMessageDraft } = load('message-draft-merge')
const { buildMentionMessage, userMessageDraft } = load('mention-context')

test('history content appends without replacing current text or matching manually typed duplicate tokens', () => {
  const currentText = '手工 @same.ts，引用 @same.ts，保留末尾空格 '
  const currentMention = { source: 'file', path: 'same.ts', displayText: '当前快照', content: 'current', textOffset: currentText.lastIndexOf('@same.ts') }
  const historicalText = '手工 @same.ts，历史引用 @same.ts'
  const historicalMention = { source: 'file', path: 'same.ts', displayText: '历史快照', content: 'historical', textOffset: historicalText.lastIndexOf('@same.ts') }
  const content = buildMentionMessage(historicalText, [historicalMention])
  const restored = userMessageDraft(content)
  const current = { text: currentText, mentions: [currentMention] }
  const draft = appendMessageDraft(current, restored)

  assert.equal(draft.text, `${currentText}\n\n${restored.text}`)
  assert.deepEqual(draft.mentions.map(mention => [mention.content, mention.textOffset]), [
    ['current', currentMention.textOffset],
    ['historical', currentText.length + 2 + restored.mentions[0].textOffset]
  ])
  assert.equal(draft.mentions[0], currentMention)
  assert.equal(current.text, currentText)
  assert.deepEqual(current.mentions, [currentMention])
  const roundTrip = userMessageDraft(buildMentionMessage(draft.text, draft.mentions))
  assert.deepEqual(roundTrip.mentions.map(mention => mention.content), ['current', 'historical'])
  // Serialization normalizes spacing around chips; identity must still point
  // at the second/fourth token, leaving both manually typed labels untouched.
  const occurrences = [...roundTrip.text.matchAll(/@same\.ts/g)].map(match => match.index)
  assert.deepEqual(roundTrip.mentions.map(mention => mention.textOffset), [occurrences[1], occurrences[3]])
})

test('attachment-only history leaves the current draft untouched and empty drafts do not gain a leading paragraph', () => {
  const mention = { source: 'dir', path: 'src', displayText: 'src', textOffset: 0 }
  const current = { text: '@src\n正在写的要求', mentions: [mention] }
  assert.deepEqual(appendMessageDraft(current, { text: '', mentions: [] }), current)
  assert.deepEqual(appendMessageDraft({ text: '', mentions: [] }, { text: '原始问题', mentions: [] }), { text: '原始问题', mentions: [] })
  assert.equal(appendMessageDraft({ text: '  ', mentions: [] }, { text: '原始问题', mentions: [] }).text, '  \n\n原始问题')
})

test('repeated additions keep distinct code snapshots and preserve all offsets', () => {
  const text = '查看 @src/main.ts:3-4'
  const mention = { source: 'code', path: 'src/main.ts', displayText: 'main.ts:3-4', startLine: 3, endLine: 4, startColumn: 2, endColumn: 8, content: 'const result = 1', textOffset: text.indexOf('@') }
  const content = buildMentionMessage(text, [mention])
  const first = appendMessageDraft({ text: '先写测试', mentions: [] }, userMessageDraft(content))
  const second = appendMessageDraft(first, userMessageDraft(content))
  assert.equal(second.text, `${first.text}\n\n${userMessageDraft(content).text}`)
  assert.equal(second.mentions.length, 2)
  assert.equal(second.mentions[0].textOffset, first.mentions[0].textOffset)
  assert.equal(second.mentions[1].textOffset, first.text.length + 2 + userMessageDraft(content).mentions[0].textOffset)
  assert.deepEqual(second.mentions.map(({ textOffset, ...snapshot }) => snapshot), first.mentions.map(({ textOffset, ...snapshot }) => snapshot).concat(first.mentions.map(({ textOffset, ...snapshot }) => snapshot)))
})

test('identical drafts are reused but equal visible text with a different snapshot still appends', () => {
  const current = { text: '@a.ts', mentions: [{ source: 'file', path: 'a.ts', displayText: 'a.ts', content: 'old', textOffset: 0 }] }
  assert.deepEqual(appendMessageDraft(current, structuredClone(current)), current)
  const different = { text: '@a.ts', mentions: [{ ...current.mentions[0], content: 'new' }] }
  const combined = appendMessageDraft(current, different)
  assert.equal(combined.text, '@a.ts\n\n@a.ts')
  assert.deepEqual(combined.mentions.map(mention => [mention.content, mention.textOffset]), [['old', 0], ['new', 7]])
})

test('legacy incoming mentions only resolve within their own paragraph and stale anchors are not revived', () => {
  const current = { text: '@a.ts 是手工文字', mentions: [] }
  const incoming = { text: '引用 @a.ts，手工 @b.ts', mentions: [
    { source: 'file', path: 'a.ts', displayText: 'a.ts' },
    { source: 'file', path: 'b.ts', displayText: 'b.ts', textOffset: 0 }
  ] }
  const combined = appendMessageDraft(current, incoming)
  assert.deepEqual(combined.mentions, [{ ...incoming.mentions[0], textOffset: current.text.length + 2 + incoming.text.indexOf('@a.ts') }])
})

test('restoring a failed request ignores only surrounding whitespace and preserves the existing draft bytes', () => {
  const original = '做一个 web 围棋 项目 可以支持 H5'
  for (const text of [original, original + '  ', '\u00a0' + original + '\u00a0\n', '\r\n' + original + '\r\n']) {
    const current = { text, mentions: [] }
    assert.deepEqual(restoreMessageDraft(current, { text: original, mentions: [] }), current)
  }
})

test('recovery appends once beside a new draft and remains idempotent after persistence and later paragraphs', () => {
  const original = { text: '第一段要求\n\n第二段要求', mentions: [] }
  const first = restoreMessageDraft({ text: '保留我新写的要求  ', mentions: [] }, original)
  assert.equal(first.text, '保留我新写的要求  \n\n第一段要求\n\n第二段要求')
  assert.deepEqual(restoreMessageDraft(first, original), first)
  const reloaded = JSON.parse(JSON.stringify(first))
  const withLaterDraft = { ...reloaded, text: reloaded.text + '\n\n新增的补充条件' }
  assert.deepEqual(restoreMessageDraft(withLaterDraft, original), withLaterDraft)
})

test('recovery does not confuse an embedded instruction, different whitespace, or single-line continuation with a complete paragraph', () => {
  const original = { text: '生成  周报', mentions: [] }
  for (const text of ['不要生成  周报', '生成  周报但还没确定', '生成 周报', '补充条件\n生成  周报']) {
    assert.equal(restoreMessageDraft({ text, mentions: [] }, original).text, text + '\n\n' + original.text)
  }
})

test('recovery compares snapshot identity and reanchors chips within existing paragraphs', () => {
  const text = '查看@src/main.ts:3并修改'
  const mention = { source: 'code', path: 'src/main.ts', displayText: 'main.ts:3', startLine: 3,
    content: 'const result = 1', textOffset: 2 }
  const original = userMessageDraft(buildMentionMessage(text, [mention]))
  const prefix = '手工 @src/main.ts:3\n\n'
  const current = { text: prefix + text + '  \n\n保留补充', mentions: [{ ...mention, textOffset: prefix.length + 2 }] }
  assert.deepEqual(restoreMessageDraft(current, original), current)
  const changed = { ...original, mentions: original.mentions.map(item => ({ ...item, content: 'const result = 2' })) }
  const combined = restoreMessageDraft(current, changed)
  assert.equal(combined.text, current.text + '\n\n' + changed.text)
  assert.deepEqual(combined.mentions.map(item => item.content), ['const result = 1', 'const result = 2'])
  assert.deepEqual(restoreMessageDraft(JSON.parse(JSON.stringify(combined)), changed), combined)
})

test('a hand-typed label or stale chip anchor cannot suppress restoring a real reference', () => {
  const incoming = { text: '查看 @a.ts', mentions: [{ source: 'file', path: 'a.ts', displayText: 'a.ts', content: 'snapshot', textOffset: 3 }] }
  for (const current of [
    { text: incoming.text, mentions: [] },
    { text: incoming.text, mentions: [{ ...incoming.mentions[0], textOffset: 0 }] }
  ]) {
    const restored = restoreMessageDraft(current, incoming)
    assert.equal(restored.text, incoming.text + '\n\n' + incoming.text)
    assert.equal(restored.mentions.at(-1).textOffset, incoming.text.length + 2 + 3)
  }
})

test('recovery preserves agent identity and does not touch a draft for attachment-only requests', () => {
  const incoming = { text: '@reviewer', mentions: [{ source: 'agent', path: 'reviewer', displayText: 'reviewer', textOffset: 0 }] }
  const current = { text: '新草稿\n\n@reviewer  ', mentions: [{ ...incoming.mentions[0], textOffset: 5 }] }
  assert.deepEqual(restoreMessageDraft(current, incoming), current)
  assert.deepEqual(restoreMessageDraft(current, { text: '', mentions: [] }), current)
  assert.equal(restoreMessageDraft({ text: incoming.text, mentions: [] }, incoming).text, '@reviewer\n\n@reviewer')
})
