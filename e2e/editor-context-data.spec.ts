/** 编辑器引用：快照进入实际发送文本、重复引用、代码围栏、草稿恢复与旧数据兼容。 */
import { test, expect } from '@playwright/test'
import { buildMentionMessage, mentionToken, type Mention } from '../src/renderer/src/contrib/chat/mention-context'
import { loadChatDraftState, saveChatDraft } from '../src/renderer/src/contrib/chat/draft-store'

const selection: Mention = {
  source: 'code', path: 'src/hello.ts', displayText: 'hello.ts:2-3',
  startLine: 2, endLine: 3, startColumn: 4, endColumn: 8,
  content: 'unsaved editor text\nsecond line', textOffset: 4
}

test('发送包含精确选区快照，而不是只发送磁盘路径', () => {
  const prompt = buildMentionMessage('解释 @src/hello.ts:2-3', [selection])
  expect(prompt).toContain('文件：src/hello.ts；选区 2:4–3:8')
  expect(prompt).toContain('unsaved editor text\nsecond line')
  expect(mentionToken(selection)).toBe('@src/hello.ts:2-3')
})

test('代码中有 Markdown 围栏时快照仍完整；同一内容不重复附加', () => {
  const mention = { ...selection, content: '```ts\nconst n = 1\n```' }
  const prompt = buildMentionMessage('检查', [mention, { ...mention, textOffset: 200 }])
  expect(prompt.match(/文件：/g)).toHaveLength(1)
  expect(prompt).toContain('````\n```ts\nconst n = 1\n```\n````')
})

test('普通文件/目录引用不额外读取或伪造快照；空文件快照仍发送', () => {
  expect(buildMentionMessage('@src', [{ source: 'dir', path: 'src', displayText: 'src' }])).toBe('@src')
  expect(buildMentionMessage('@empty.txt', [{ source: 'file', path: 'empty.txt', displayText: 'empty', content: '' }]))
    .toContain('完整编辑缓冲区\n```\n\n```')
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
