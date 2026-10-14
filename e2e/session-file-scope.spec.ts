/** Real session-file adapter: scratch files, endpoint fences and exact binary/truncation semantics. No Electron or models. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput } from '../src/shared/ipc'
import { readSessionFile } from '../src/renderer/src/core/workspace/fs-client'
import { getExpectedEngine, publishEngineSource } from '../src/renderer/src/core/engine/source'

let calls: EngineRequestInput[], previousWindow: PropertyDescriptor | undefined, generation = 0
let directory: unknown, content: unknown, onRequest: ((input: EngineRequestInput) => void) | undefined
const ready = () => publishEngineSource({ mode: 'embedded', baseUrl: '', phase: 'ready', instanceId: `session-file-${++generation}` })
test.beforeEach(() => {
  calls = []; onRequest = undefined; ready()
  directory = { root: 'D:/isolated/task', entries: [] }
  content = { content: '# 任务资料', isBinary: false, totalSize: 15, truncated: false }
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: {
    request: async (input: EngineRequestInput) => {
      calls.push(input); onRequest?.(input)
      return { ok: true, code: 200, data: input.path === '/workspace/directory' ? directory : content }
    }
  } } } })
})
test.afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('无用户项目也按任务会话读取资料，不借用当前 Code 工作区', async () => {
  const expectedEngine = getExpectedEngine()
  expect(await readSessionFile('work-scratch', '.ae/attachments/brief.md')).toMatchObject({ path: 'D:/isolated/task/.ae/attachments/brief.md', content: '# 任务资料', truncated: false })
  expect(calls).toHaveLength(2)
  expect(calls[0]).toMatchObject({ path: '/workspace/directory', query: { sessionId: 'work-scratch', path: '.' }, expectedEngine })
  expect(calls[1]).toMatchObject({ path: '/workspace/file/content', query: { sessionId: 'work-scratch', path: '.ae/attachments/brief.md' }, expectedEngine })
})
test('根目录响应期间切换来源，拒绝旧资料且不向新引擎发第二次请求', async () => {
  onRequest = input => { if (input.path === '/workspace/directory') ready() }
  await expect(readSessionFile('work-old', 'brief.md')).rejects.toThrow('引擎连接已变化')
  expect(calls).toHaveLength(1)
})
test('内容响应期间重启引擎，旧内容也不能交给当前预览', async () => {
  onRequest = input => { if (input.path === '/workspace/file/content') ready() }
  await expect(readSessionFile('work-old', 'brief.md')).rejects.toThrow('引擎连接已变化')
  expect(calls).toHaveLength(2)
})
test('非法根、越界绝对路径和上级路径在内容请求前失败', async () => {
  directory = { root: 'relative-root', entries: [] }
  await expect(readSessionFile('work-a', 'brief.md')).rejects.toThrow('引擎未提供任务工作区')
  directory = { root: 'D:/isolated/task', entries: [] }
  for (const path of ['D:/other/brief.md', '../brief.md']) await expect(readSessionFile('work-a', path)).rejects.toThrow()
  expect(calls.every(input => input.path === '/workspace/directory')).toBe(true)
})
test('图片保留 base64，截断和大文件状态不被伪装成完整正文', async () => {
  content = { content: 'aW1hZ2U=', isBinary: true, totalSize: 5, truncated: false }
  expect(await readSessionFile('work-a', 'picture.png')).toMatchObject({ content: '', base64: 'aW1hZ2U=', isBinary: true })
  content = { content: 'partial', isBinary: false, totalSize: 1_000_000, tooLarge: true, truncated: true }
  expect(await readSessionFile('work-a', 'long.txt')).toMatchObject({ content: 'partial', tooLarge: true, truncated: true })
})

test('POSIX 路径大小写不同不能认领同一根，根目录文件仍保持绝对路径', async () => {
  directory = { root: '/workspace/Task', entries: [] }
  await expect(readSessionFile('work-a', '/workspace/task/brief.md')).rejects.toThrow('不属于当前任务工作区')
  expect(calls).toHaveLength(1)
  directory = { root: '/', entries: [] }
  expect(await readSessionFile('work-a', '/brief.md')).toMatchObject({ path: '/brief.md' })
  expect(calls.at(-1)?.query).toEqual({ sessionId: 'work-a', path: 'brief.md' })
})

test('Windows 盘符与 UNC 路径归一化，但冒号、反斜杠上级段和工作区外 UNC 都拒绝', async () => {
  directory = { root: 'D:/isolated/task', entries: [] }
  expect(await readSessionFile('work-a', 'd:\\ISOLATED\\TASK\\brief.md')).toMatchObject({ path: 'D:/isolated/task/brief.md' })
  directory = { root: '\\\\server\\share\\task', entries: [] }
  expect(await readSessionFile('work-a', '\\\\SERVER\\SHARE\\TASK\\brief.md')).toMatchObject({ path: '//server/share/task/brief.md' })
  const previous = calls.length
  for (const path of ['\\\\other\\share\\brief.md', '..\\brief.md', 'file.txt:stream', 'sub//brief.md']) await expect(readSessionFile('work-a', path)).rejects.toThrow()
  expect(calls.slice(previous).every(call => call.path === '/workspace/directory')).toBe(true)
})
