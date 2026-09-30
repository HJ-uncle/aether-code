/** Net rows acknowledge their complete operation chains; failed keep never resets the Git index. */
import { expect, test } from '@playwright/test'
import type { EngineFileChange, EngineRequestInput } from '../src/shared/ipc'
import { changeIdsOf, keepChanges, stageAndKeepChanges } from '../src/renderer/src/core/engine/change-actions'

const row: EngineFileChange = {
  id: 'last', changeIds: ['first', 'middle', 'last'], path: 'C:/fixture/file.txt',
  kind: 'write', oldContent: 'before', newContent: 'after', truncated: false, status: 'pending', createdAt: 1
}

test('保留和暂存提交整行全部操作，路径和IDs去重', async () => {
  const calls: EngineRequestInput[] = []
  const request = async <T>(input: EngineRequestInput): Promise<T> => { calls.push(input); return { kept: 3 } as T }
  expect(changeIdsOf([row, row])).toEqual(['first', 'middle', 'last'])
  await keepChanges(request, 'session', [row])
  expect(calls[0].body).toEqual({ sessionId: 'session', ids: ['first', 'middle', 'last'] })
  const staged: string[][] = []
  expect(await stageAndKeepChanges(async paths => {
    staged.push(paths); return { success: true, stagedPaths: paths }
  }, request, 'session', [row, row])).toBe(true)
  expect(staged).toEqual([[row.path]])
  expect(calls[1].body).toEqual(calls[0].body)
})

test('暂存成功后保留失败，明确保留暂存结果且不重试或取消暂存', async () => {
  let stageCount = 0
  let requestCount = 0
  await expect(stageAndKeepChanges(async paths => {
    stageCount++; return { success: true, stagedPaths: paths }
  }, async () => { requestCount++; throw new Error('connection lost') }, 'session', [row]))
    .rejects.toThrow('文件已暂存，但待确认状态保存失败。暂存内容已保留')
  expect(stageCount).toBe(1)
  expect(requestCount).toBe(1)
})

test('部分保留不可冒充成功；Git失败或全忽略不确认记录', async () => {
  await expect(keepChanges(async <T>() => ({ kept: 1 }) as T, 'session', [row])).rejects.toThrow('部分改动')
  let requested = false
  const request = async <T>(): Promise<T> => { requested = true; return { kept: 3 } as T }
  await expect(stageAndKeepChanges(async () => ({ success: false, error: 'not a git repository' }), request, 'session', [row]))
    .rejects.toThrow('not a git repository')
  expect(await stageAndKeepChanges(async () => ({ success: true, stagedPaths: [] }), request, 'session', [row])).toBe(false)
  expect(requested).toBe(false)
})
