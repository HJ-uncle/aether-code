/** Pure link protocol classification: session ownership, origins, decoded filenames and path boundaries. */
import { expect, test } from '@playwright/test'
import { classifyChatLink, resolveArtifactPath } from '../src/renderer/src/contrib/chat/chat-link'
import { resolveChatPath } from '../src/renderer/src/contrib/chat/chat-file-path'

const endpoint = '/api/v1/workspace/file/download'
const link = (path: string, sessionId = 'session-a') => endpoint + '?' + new URLSearchParams({ sessionId, path })

test('engine delivery URL becomes its file path, never download query as a disk filename', () => {
  expect(classifyChatLink(link('index.html'), 'session-a')).toEqual({ kind: 'artifact', path: 'index.html', sessionId: 'session-a' })
  expect(resolveArtifactPath('index.html', 'D:\\trust-test')).toBe('D:\\trust-test/index.html')
  expect(resolveArtifactPath('index.html', '/remote/project')).toBe('/remote/project/index.html')
})

test('query decoding preserves nested Chinese, spaces, percent, hash and plus exactly once', () => {
  for (const path of ['页面/五子棋 100% #标签+.html', 'literal%23/index.html', 'nested\\index.html']) {
    expect(classifyChatLink(link(path), 'session-a')).toEqual({ kind: 'artifact', path: path.replace(/\\/g, '/'), sessionId: 'session-a' })
  }
})

for (const path of ['', '../index.html', 'src/../../index.html', '..\\index.html', '/index.html', 'C:\\index.html', '//server/share/index.html', 'src/./index.html', 'a\0.html']) {
  test(`rejects invalid or escaping artifact path ${JSON.stringify(path)}`, () => {
    expect(classifyChatLink(link(path), 'session-a').kind).toBe('invalid')
  })
}

test('rejects missing/duplicate parameters, malformed encoding and foreign session', () => {
  for (const href of [endpoint + '?path=index.html', link('index.html') + '&path=other.html', link('index.html') + '&sessionId=session-b',
    endpoint + '?sessionId=session-a&path=bad%.html', link('index.html', 'session-b'), link('index.html') + '#ignored']) {
    expect(classifyChatLink(href, 'session-a').kind).toBe('invalid')
  }
  expect(classifyChatLink(link('index.html')).kind).toBe('invalid')
  expect(() => resolveArtifactPath('index.html', null)).toThrow('没有可用的工作区')
})

test('only exact current engine endpoint is an artifact; foreign origins and unrelated APIs stay external', () => {
  const engine = 'http://127.0.0.1:12366'
  expect(classifyChatLink(engine + link('index.html'), 'session-a', engine).kind).toBe('artifact')
  for (const href of ['https://example.test' + link('index.html'), 'http://127.0.0.1:12367' + link('index.html'),
    '/api/v1/workspace/download?path=index.html', '/api/other?path=index.html', '//example.test/index.html']) {
    expect(classifyChatLink(href, 'session-a', engine)).toEqual({ kind: 'external' })
  }
})

test('normal chat filenames preserve literal percent/hash and line/column semantics', () => {
  const raw = 'src/中文 100% #tag%23.ts:12:3'
  expect(classifyChatLink(raw, 'session-a')).toEqual({ kind: 'file', path: raw })
  expect(resolveChatPath(raw, 'D:/project')).toEqual({ filePath: 'D:/project/src/中文 100% #tag%23.ts', line: 12, column: 3 })
})
