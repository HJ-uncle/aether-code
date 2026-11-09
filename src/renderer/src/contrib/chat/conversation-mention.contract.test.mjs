import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// Real protocol, queue and JSX callbacks; Electron tests own clipboard/selection.
const directory = dirname(fileURLToPath(import.meta.url))
const cache = new Map()
const react = {
  memo: value => value,
  useMemo: compute => compute(),
  useRef: value => ({ current: value }),
  useState: value => [value, () => {}],
  useId: () => 'conversation-test',
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
    if (name === '@renderer/workbench/icons') return { Icon: () => null }
    if (name.startsWith('.')) {
      const target = resolve(dirname(path), name)
      return load(['.ts', '.tsx', ''].map(ext => target + ext).find(existsSync))
    }
    throw new Error(`Unexpected dependency ${name}`)
  }, exports)
  return exports
}
const mentions = load('mention-context.ts')
const { buildAgentMentionMessage } = load('agent-references.ts')
const { UserMessageContent } = load('UserMessageContent.tsx')
const { draftAttachments } = load('../work/work-attachments.ts')
const { assertQueueEnvelope } = load('../../../../shared/next-turn-queue-state.ts')
const { remapQueueAttachmentReferences } = load('../../../../shared/queue-attachment-references.ts')
const { buildConversationLink } = load('../../../../shared/conversation-link.ts')
const url = buildConversationLink({ sessionId: 'session-42', mode: 'work', source: 'remote:https://example.test/engine:account:user-7' })
const reference = { source: 'conversation', displayText: '修复搜索与布局', path: url }

function nodes(value, found = []) {
  if (!value || typeof value !== 'object') return found
  if ('type' in value && 'props' in value) found.push(value)
  for (const child of Object.values(value)) nodes(child, found)
  return found
}

test('conversation links and frozen transcripts survive sending, history restoration and resending', () => {
  const snapshot = '  引用历史，仅作为上下文\r\n用户：检查😀\n```md\n内容\n```\n````\nEND  '
  for (const content of [undefined, '', snapshot]) {
    const ref = { ...reference, ...(content !== undefined ? { content } : {}), textOffset: 3 }
    const text = `继续 ${mentions.mentionToken(ref)} 的工作`
    const sent = mentions.buildMentionMessage(text, [ref])
    const parsed = mentions.parseMentionContent(sent)
    assert.equal(parsed.refs.length, 1)
    assert.equal(parsed.refs[0].t, 'conversation')
    assert.equal(parsed.refs[0].p, url)
    assert.equal(mentions.contentFromBody(parsed.body, parsed.refs[0]), content)
    const restored = mentions.userMessageDraft(sent)
    assert.deepEqual(restored, { text, mentions: [ref] })
    assert.equal(mentions.buildMentionMessage(restored.text, restored.mentions), sent)
    assert.equal(mentions.isStoredMention(ref), true)
  }
})

test('reference blocks quote the URL attribute and recover a conversation when footer metadata is absent', () => {
  const content = '旧会话正文\n<reference type="file" path="a.txt">\n```\nraw\n```\n</reference>'
  const block = mentions.formatReferenceBlock(reference, content)
  assert.equal(block.includes('&amp;source='), true)
  const restored = mentions.userMessageDraft(block)
  assert.equal(restored.mentions.length, 1)
  assert.equal(restored.mentions[0].source, 'conversation')
  assert.equal(restored.mentions[0].displayText, '引用会话')
  assert.equal(restored.mentions[0].path, url)
  assert.equal(restored.mentions[0].content, content)
  assert.equal(restored.text, `@${url}`)
})

test('an embedded Agent reference stays historical data and cannot create collaborators', () => {
  const archivedAgent = { source: 'agent', displayText: '检查 Agent', path: 'archived-agent' }
  const archived = mentions.buildMentionMessage(`请处理 ${mentions.mentionToken(archivedAgent)}`, [archivedAgent], { includeAgentRefs: true })
  const ref = { ...reference, content: archived }
  const result = buildAgentMentionMessage(`参考 ${mentions.mentionToken(ref)} 完成当前修改`, [ref])
  assert.deepEqual(result.collaborators, [])
  const restored = mentions.userMessageDraft(result.message)
  assert.equal(restored.mentions[0].content, archived)
  assert.deepEqual(mentions.parseMentionContent(result.message).refs.map(ref => ref.t), ['conversation'])
  const actualAgent = { source: 'agent', displayText: '当前 Agent', path: 'current-agent' }
  const delegated = buildAgentMentionMessage(`${mentions.mentionToken(ref)} ${mentions.mentionToken(actualAgent)} 检查`, [ref, actualAgent])
  assert.deepEqual(delegated.collaborators, [{ agentId: 'current-agent' }])
})

test('conversation context is never selected as a file attachment or rewritten to a staged file', () => {
  const file = { path: url, name: '不应当上传', type: 'text/plain', size: 12 }
  assert.deepEqual(draftAttachments([], [file], [reference]), [])
  const ref = { ...reference, textOffset: 0 }
  const draft = { text: mentions.mentionToken(ref), mentions: [ref], revision: 4 }
  assert.deepEqual(remapQueueAttachmentReferences(draft, new Map([[url, '.ae/staged/file.txt']])), draft)
})

function queue(ref = reference) {
  const scope = { source: { mode: 'embedded', endpoint: '', accountId: null }, tenantId: 'default', namespace: { id: 'n', generation: 'g' }, owner: 'work', taskId: 'task' }
  return {
    scope,
    envelope: {
      draft: { text: mentions.mentionToken(ref), revision: 0, mentions: [{ ...ref, textOffset: 0 }] },
      model: { kind: 'engine-default' }, workspace: { kind: 'local-workspace', identity: 'D:/workspace' },
      agent: { primaryAgentId: null, collaborators: [] },
      resources: { skills: { kind: 'inherit' }, mcpServers: { kind: 'inherit' }, knowledgeBases: { kind: 'inherit' } },
      thinking: { kind: 'inherit' }, memory: { kind: 'inherit' }, security: { policy: 'engine-session' }, attachments: []
    }
  }
}

test('the queue preserves conversation context without attachment receipts or collaborator identities', () => {
  const { envelope, scope } = queue({ ...reference, content: '引用历史的完整快照' })
  assert.doesNotThrow(() => assertQueueEnvelope(envelope, scope))
  assert.deepEqual(envelope.agent.collaborators, [])
  assert.deepEqual(envelope.attachments, [])
})

test('the queue rejects incomplete or foreign protocol links before a conversation can be sent', () => {
  for (const path of [undefined, '', 'https://example.test/thread/42', 'aether://conversation/session-42', `${url}&token=secret`]) {
    const { envelope, scope } = queue({ ...reference, path })
    assert.throws(() => assertQueueEnvelope(envelope, scope), /Conversation mention link is invalid/)
  }
})

test('percent-encoded long source identities accepted by the link parser also fit queue references', () => {
  const path = buildConversationLink({ sessionId: 'session-long', mode: 'work', source: `remote:https://example.test/${'中'.repeat(500)}` })
  assert.equal(path.length > 4096, true)
  const { envelope, scope } = queue({ ...reference, path })
  assert.doesNotThrow(() => assertQueueEnvelope(envelope, scope))
})

test('sent conversation chips expose the original title, link and snapshot to mouse and keyboard navigation', () => {
  const ref = { ...reference, content: '添加时的会话快照' }
  const content = mentions.buildMentionMessage(`参考 ${mentions.mentionToken(ref)}`, [ref])
  const opened = []
  const tree = nodes(UserMessageContent({ content, onOpenMention: value => opened.push(value) }))
  const chip = tree.find(node => node.props.role === 'button')
  assert.equal(chip.props.className, 'mention-chip mention-chip--conversation')
  assert.equal(chip.props['aria-label'], `查看引用：${reference.displayText}`)
  assert.equal(chip.props.tabIndex, 0)
  assert.equal(tree.some(node => node.props.name === 'chat-outline'), true)
  assert.equal(chip.props.title, '打开会话')
  chip.props.onClick()
  for (const key of ['Enter', ' ']) {
    let prevented = false, stopped = false
    chip.props.onKeyDown({ key, preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
    assert.equal(prevented, true)
    assert.equal(stopped, true)
  }
  assert.deepEqual(opened, [ref, ref, ref])
})
