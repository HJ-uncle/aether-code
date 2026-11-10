/** Pure compatibility coverage: partial/old branch responses, ambiguous short
 * decorations outside the batch page, missing refs, and binding/read failures. */
import { expect, test } from '@playwright/test'
import type { GitBranchListResult, GitLogEntry, GitLogResult } from '../src/shared/git-types'
import { withBranchMetadata } from '../src/renderer/src/core/git/git-branch-metadata'

const commit = (subject: string, refs: GitLogEntry['refs'] = []): GitLogEntry => ({
  hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject, author: '分支作者', date: '2026-11-10T10:00:00Z', refs
})
const info = { name: 'main', hash: 'aaaaaaa', subject: '已完整返回', author: '作者', date: '2026-11-10T10:00:00Z' }
const unexpectedRead = async (): Promise<never> => { throw new Error('Unexpected enrichment read') }

test('完整元信息、空仓库和失败响应不发起额外读取', async () => {
  for (const result of [
    { success: true, branches: ['main'], current: 'main', infos: [info] },
    { success: true, branches: [] },
    { success: false, error: '仓库占用' }
  ]) expect(await withBranchMetadata(result, 'heads', unexpectedRead, unexpectedRead)).toBe(result)
})

test('保留已有信息及完整名单，批量补查支持 HEAD、非 origin 远程和多级分支', async () => {
  const read: string[] = []
  const result = await withBranchMetadata({ success: true, branches: ['main', 'feature/team/new', 'empty'], current: 'main', infos: [info] }, 'heads',
    async (refs, limit) => {
      read.push(`${refs}:${limit}`)
      return { success: true, commits: refs === 'all' ? [
        commit('不要覆盖 main', [{ name: 'HEAD -> main', type: 'branch' }]),
        commit('来自真实分支', [{ name: 'feature/team/new', type: 'branch' }]),
        commit('标签不能作为分支', [{ name: 'tag: empty', type: 'tag' }])
      ] : [] }
    }, async () => ({ success: true, branches: ['upstream/release'] }))
  expect(result.branches).toEqual(['main', 'feature/team/new', 'empty'])
  expect(result.current).toBe('main')
  expect(result.infos?.map(entry => [entry.name, entry.subject])).toEqual([['main', '已完整返回'], ['feature/team/new', '来自真实分支']])
  expect(read).toEqual(['all:500', 'refs/heads/empty:1'])

  const remote = await withBranchMetadata({ success: true, branches: ['upstream/team/release'] }, 'remotes',
    async () => ({ success: true, commits: [commit('第三方远程', [{ name: 'upstream/team/release', type: 'branch' }])] }),
    async () => ({ success: true, branches: ['main'] }))
  expect(remote.infos?.[0]).toMatchObject({ name: 'upstream/team/release', subject: '第三方远程' })
})

test('批量页外的同名本地分支不会被误配给远程分支', async () => {
  const reads: string[] = []
  const result = await withBranchMetadata({ success: true, branches: ['origin/dev'] }, 'remotes',
    async (refs, limit) => {
      reads.push(`${refs}:${limit}`)
      return { success: true, commits: [commit(refs === 'all' ? '同名本地提交' : '正确远程提交', [{ name: 'origin/dev', type: 'remote' }])] }
    }, async () => ({ success: true, branches: ['origin/dev'] }))
  expect(reads).toEqual(['all:500', 'refs/remotes/origin/dev:1'])
  expect(result.infos?.[0].subject).toBe('正确远程提交')
})

test('完整引用和 HEAD 箭头可消歧，忽略相反命名空间及标签', async () => {
  const result = await withBranchMetadata({ success: true, branches: ['origin/dev', 'feature/topic'] }, 'heads',
    async (refs) => {
      expect(refs).toBe('all')
      return { success: true, commits: [
        commit('错误远程', [{ name: 'refs/remotes/origin/dev', type: 'remote' }]),
        commit('正确 HEAD', [{ name: 'HEAD -> origin/dev', type: 'branch' }]),
        commit('完整本地', [{ name: 'refs/heads/feature/topic', type: 'branch' }])
      ] }
    }, async () => ({ success: true, branches: ['origin/dev'] }))
  expect(result.infos?.map(entry => entry.subject)).toEqual(['正确 HEAD', '完整本地'])
})

test('旧引擎消歧后的分支别名直接解析，不重复拼接命名空间', async () => {
  const reads: string[] = []
  const names = ['heads/origin/dev', 'refs/heads/heads/origin/dev']
  const result = await withBranchMetadata({ success: true, branches: names }, 'heads', async refs => {
    reads.push(refs)
    return { success: true, commits: refs === 'all' ? [] : [commit(refs)] }
  }, async () => ({ success: true, branches: ['remotes/origin/dev'] }))
  expect(reads).toEqual(['all', 'heads/origin/dev^{commit}', 'refs/heads/heads/origin/dev^{commit}'])
  expect(result.infos?.map(entry => entry.name)).toEqual(names)
})

test('陈旧绑定和传输错误继续抛出，API 失败不能伪装成补齐成功', async () => {
  const source: GitBranchListResult = { success: true, branches: ['main'], current: 'main' }
  const bindingError = new Error('任务 Git 工作区已重新绑定')
  await expect(withBranchMetadata(source, 'heads', async () => { throw bindingError }, unexpectedRead)).rejects.toBe(bindingError)
  const failed: GitLogResult = { success: false, error: '仓库正忙', errorCode: 'git-busy' }
  expect(await withBranchMetadata(source, 'heads', async () => failed, unexpectedRead)).toMatchObject({ ...failed, branches: ['main'] })
  let call = 0
  await expect(withBranchMetadata(source, 'heads', async () => {
    if (call++ === 0) return { success: true, commits: [] }
    throw bindingError
  }, unexpectedRead)).rejects.toBe(bindingError)
})

test('批量页外的补查保持串行且使用完整分支引用', async () => {
  let active = 0, maximum = 0
  const read: string[] = []
  const result = await withBranchMetadata({ success: true, branches: ['a', 'b', 'c'] }, 'heads', async refs => {
    active++; maximum = Math.max(maximum, active); read.push(refs)
    await new Promise<void>(resolve => setImmediate(resolve))
    active--
    return { success: true, commits: refs === 'all' ? [] : [commit(refs)] }
  }, unexpectedRead)
  expect(maximum).toBe(1)
  expect(read).toEqual(['all', 'refs/heads/a', 'refs/heads/b', 'refs/heads/c'])
  expect(result.infos?.map(entry => entry.name)).toEqual(['a', 'b', 'c'])
})
