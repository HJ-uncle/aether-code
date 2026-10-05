/** 编辑器引用：快照进入实际发送文本、重复引用、代码围栏、草稿恢复与旧数据兼容。 */
import { test, expect } from '@playwright/test'
import {
  buildMentionMessage, formatReferenceBlock, LEGACY_SNAPSHOT_MARKER, mentionToken,
  parseMentionContent, sourceTextFromBody, userMessageDraft, type Mention
} from '../src/renderer/src/contrib/chat/mention-context'
import { loadChatDraftState, saveChatDraft } from '../src/renderer/src/contrib/chat/draft-store'

const selection: Mention = {
  source: 'code', path: 'src/hello.ts', displayText: 'hello.ts:2-3',
  startLine: 2, endLine: 3, startColumn: 4, endColumn: 8,
  content: 'unsaved editor text\nsecond line', textOffset: 3
}

test('发送包含精确选区快照，而不是只发送磁盘路径', () => {
  const prompt = buildMentionMessage('解释 @src/hello.ts:2-3', [selection])
  const { body, refs } = parseMentionContent(prompt)
  expect(body).toBe('解释 <reference type="code" path="src/hello.ts" lines="2-3" columns="4-8">\n```ts\nunsaved editor text\nsecond line\n```\n</reference>')
  expect(refs).toEqual([{ t: 'code', p: selection.path, d: selection.displayText, s: 3, e: body.length, r: [2, 3], c: [4, 8] }])
  const draft = userMessageDraft(JSON.parse(JSON.stringify(prompt)))
  expect(draft).toEqual({ text: '解释 @src/hello.ts:2-3', mentions: [selection] })
  expect(buildMentionMessage(draft.text, draft.mentions)).toBe(prompt)
  expect(mentionToken(selection)).toBe('@src/hello.ts:2-3')
})

test('代码中有 Markdown 围栏时快照仍完整；同一内容不重复附加', () => {
  const mention = { ...selection, content: '```ts\nconst n = 1\n```' }
  const text = '检查 @src/hello.ts:2-3'
  const prompt = buildMentionMessage(text, [mention, { ...mention, textOffset: 200 }])
  const parsed = parseMentionContent(prompt)
  expect(parsed.refs).toHaveLength(1)
  expect(parsed.body).toContain('````ts\n```ts\nconst n = 1\n```\n````')
  expect(userMessageDraft(prompt)).toEqual({ text, mentions: [mention] })
  // No token means the user removed the chip: never append a detached snapshot.
  expect(buildMentionMessage('检查', [mention])).toBe('检查')
})

test('普通文件/目录引用不额外读取或伪造快照；空文件快照仍发送', () => {
  for (const source of ['file', 'dir'] as const) {
    const mention = { source, path: 'src', displayText: 'src', textOffset: 0 }
    const prompt = buildMentionMessage('@src', [mention])
    expect(parseMentionContent(prompt).body).toBe('@src')
    expect(userMessageDraft(prompt)).toEqual({ text: '@src', mentions: [mention] })
  }
  for (const source of ['file', 'code', 'terminal'] as const) {
    const mention = { source, path: 'empty.txt', displayText: 'empty', content: '', textOffset: 0 }
    const prompt = buildMentionMessage('@empty.txt', [mention])
    expect(parseMentionContent(prompt).body).toBe(`<reference type="${source}" path="empty.txt">\n\`\`\`\n\n\`\`\`\n</reference>`)
    expect(userMessageDraft(prompt)).toEqual({ text: '@empty.txt', mentions: [mention] })
  }
})

test('未保存文件全文与终端快照逐字往返，包含 CRLF 和末尾空白', () => {
  for (const source of ['file', 'terminal'] as const) {
    const mention: Mention = { source, path: 'src/full.ts', displayText: 'full.ts（未保存）', content: '\uFEFFline 1\r\nline 2\r\n \t\n', textOffset: 0 }
    const prompt = buildMentionMessage('@src/full.ts', [mention])
    expect(parseMentionContent(prompt).body).toContain(mention.content!)
    const restored = userMessageDraft(JSON.parse(JSON.stringify(prompt)))
    expect(restored).toEqual({ text: '@src/full.ts', mentions: [mention] })
    expect(buildMentionMessage(restored.text, restored.mentions)).toBe(prompt)
  }
})

test('快照内部的 reference、机器注释和旧协议标记不能截断正文或快照', () => {
  const content = 'before\n</reference>\n<!--aether-refs:[]-->\n```\n' + LEGACY_SNAPSHOT_MARKER + '\n```\nafter'
  const mention = { ...selection, content }
  const prompt = buildMentionMessage('检查 @src/hello.ts:2-3', [mention])
  const parsed = parseMentionContent(prompt)
  expect(parsed.body).toContain(content)
  expect(parsed.refs).toHaveLength(1)
  expect(userMessageDraft(prompt)).toEqual({ text: '检查 @src/hello.ts:2-3', mentions: [mention] })
  const fallback = userMessageDraft(parsed.body)
  expect(fallback.text).toBe('检查 @src/hello.ts:2-3')
  expect(fallback.mentions[0]).toMatchObject({ source: 'code', path: selection.path, content, startLine: 2, endLine: 3, startColumn: 4, endColumn: 8 })
})

test('特殊路径和显示文字不破坏属性或机器数据注释', () => {
  const mention: Mention = { source: 'file', path: 'dir/a"&<>.txt', displayText: 'label --> <!--aether-refs:[]-->', content: 'original', textOffset: 0 }
  const text = mentionToken(mention)
  const prompt = buildMentionMessage(text, [mention])
  expect(prompt).toContain('path="dir/a&quot;&amp;&lt;&gt;.txt"')
  const parsed = parseMentionContent(prompt)
  expect(parsed.refs).toHaveLength(1)
  expect(userMessageDraft(prompt)).toEqual({ text, mentions: [mention] })
  expect(userMessageDraft(parsed.body).mentions[0]).toMatchObject({ path: mention.path, content: 'original' })
})

test('重复引用按实际 token 位置保存，各自快照和手写同名文本不会串位', () => {
  const token = mentionToken(selection)
  const text = `手写 ${token}；引用 ${token} 与 ${token}`
  const first = { ...selection, content: 'first', textOffset: text.indexOf(token, text.indexOf(token) + token.length) }
  const second = { ...selection, content: 'second', textOffset: text.lastIndexOf(token) }
  const prompt = buildMentionMessage(text, [first, second])
  const parsed = parseMentionContent(prompt)
  expect(parsed.refs).toHaveLength(2)
  expect(parsed.body.startsWith(`手写 ${token}；引用 `)).toBe(true)
  expect(userMessageDraft(prompt)).toEqual({ text, mentions: [first, second] })
})

test('引用两侧缺空白时只补边界空格，不把空格移到整句话之前', () => {
  const token = mentionToken(selection)
  const text = `解释${token}接着${token}结束`
  const first = { ...selection, textOffset: 2 }
  const second = { ...selection, textOffset: text.lastIndexOf(token) }
  const prompt = buildMentionMessage(text, [first, second])
  const draft = userMessageDraft(prompt)
  expect(draft.text).toBe(`解释 ${token} 接着 ${token} 结束`)
  expect(draft.mentions.map(item => item.content)).toEqual([selection.content, selection.content])
  expect(buildMentionMessage(draft.text, draft.mentions)).toBe(prompt)
})

test('机器区间偏移或部分损坏时逐块恢复，不能把普通正文误收成引用', () => {
  const first = { ...selection, textOffset: 0 }
  const second: Mention = { source: 'file', path: 'empty.txt', displayText: 'empty', content: '', textOffset: 20 }
  const prompt = buildMentionMessage(`${mentionToken(first)} 和 ${mentionToken(second)}`, [first, second])
  const { body, refs } = parseMentionContent(prompt)
  const damaged = `${body}\n<!--aether-refs:${JSON.stringify([refs[0], { ...refs[1], s: refs[1].s - 1 }])}-->`
  const restored = userMessageDraft(damaged)
  expect(restored.mentions).toHaveLength(2)
  expect(restored.mentions.map(item => item.content)).toEqual([selection.content, ''])
  expect(restored.text).toBe(`${mentionToken(first)} 和 ${mentionToken(second)}`)
  const shifted = parseMentionContent('prefix ' + prompt)
  expect(sourceTextFromBody(shifted.body, shifted.refs).text).toBe(`prefix ${mentionToken(first)} 和 ${mentionToken(second)}`)
  expect(shifted.refs).toHaveLength(2)
})

test('旧 reference 历史不带列号仍恢复快照，旧尾部说明仍隐藏', () => {
  const legacyBlock = '<reference type="code" path="src/hello.ts" lines="2-3">\n```ts\nold snapshot\n```\n</reference>'
  expect(userMessageDraft(legacyBlock)).toEqual({ text: '@src/hello.ts:2-3', mentions: [{ source: 'code', path: selection.path, displayText: 'src/hello.ts:2-3', startLine: 2, endLine: 3, content: 'old snapshot', textOffset: 0 }] })
  expect(userMessageDraft('旧正文' + LEGACY_SNAPSHOT_MARKER + '\n旧快照')).toEqual({ text: '旧正文', mentions: [] })
  expect(formatReferenceBlock({ source: 'dir', displayText: 'src', path: 'src' }, 'not a file')).toBeUndefined()
})

test('跨行选区允许终止列小于起始列并可回放', () => {
  const prompt = buildMentionMessage('解释 @src/hello.ts:2-3', [selection])
  const footer = /<!--aether-refs:([\s\S]*?)-->$/.exec(prompt)?.[1]
  expect(footer).toBeTruthy()
  const metadata = JSON.parse(footer!) as Array<Record<string, unknown>>
  metadata[0].c = [10, 2]
  const damaged = prompt.replace(/<!--aether-refs:[\s\S]*?-->$/, `<!--aether-refs:${JSON.stringify(metadata)}-->`)
  expect(userMessageDraft(damaged).mentions[0]).toMatchObject({ startLine: 2, endLine: 3, startColumn: 10, endColumn: 2 })
})

test('草稿保留引用文本、位置与未保存快照，兼容旧纯文本存储', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  } })
  try {
    storage.set('aether:chatDrafts', JSON.stringify({ old: '旧草稿' }))
    expect(loadChatDraftState('old', '')).toEqual({ text: '旧草稿', mentions: [] })
    saveChatDraft('new', '解释 @src/hello.ts:2-3', '', [selection])
    expect(loadChatDraftState('new', '').mentions).toEqual([selection])
    expect(loadChatDraftState('old', '').text).toBe('旧草稿')
    saveChatDraft('new', '', '')
    expect(loadChatDraftState('new', '')).toEqual({ text: '', mentions: [] })
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
