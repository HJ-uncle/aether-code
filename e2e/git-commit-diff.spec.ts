/** Pure historical preview contracts: immutable sides, serial reads, initial/add/delete/binary and errors. */
import { expect, test } from '@playwright/test'
import type { GitCommitInfoResult, GitHeadFileResult } from '../src/shared/git-types'
import { loadGitCommitDiff } from '../src/renderer/src/core/git/git-commit-diff'

function detail(parents = ['parent']): GitCommitInfoResult {
  return {
    success: true,
    commit: {
      hash: 'commit',
      shortHash: 'commit',
      parents,
      subject: 'change',
      body: '',
      author: 'test',
      date: '2026-11-04T00:00:00Z',
      additions: 1,
      deletions: 1,
      fileChanges: [{ code: 'M', path: 'file.txt' }]
    }
  }
}

test('历史对比按顺序读取父提交和选中提交，不查询当前工作区', async () => {
  const calls: string[] = []
  let pending = 0
  const client = {
    gitCommitShow: async (hash: string) => {
      calls.push(`detail:${hash}`)
      return detail(['parent', 'other-parent'])
    },
    gitShowCommitFile: async (hash: string, path: string): Promise<GitHeadFileResult> => {
      expect(pending).toBe(0)
      pending++
      calls.push(`${hash}:${path}`)
      await Promise.resolve()
      pending--
      return { success: true, content: hash === 'parent' ? 'before\n' : 'after\n' }
    }
  }
  const diff = await loadGitCommitDiff(client, 'commit', { code: 'M', path: 'file.txt' })
  expect(calls).toEqual(['detail:commit', 'parent:file.txt', 'commit:file.txt'])
  expect(diff).toEqual({
    path: 'file.txt',
    changeType: 'modified',
    oldContent: 'before\n',
    newContent: 'after\n',
    binary: false,
    hunks: []
  })
})

for (const fixture of [
  {
    name: '首次提交',
    parents: [],
    code: 'M',
    expected: 'added',
    hashes: ['commit'],
    old: '',
    next: 'text'
  },
  {
    name: '新增文件',
    parents: ['parent'],
    code: 'A',
    expected: 'added',
    hashes: ['commit'],
    old: '',
    next: 'text'
  },
  {
    name: '删除文件',
    parents: ['parent'],
    code: 'D',
    expected: 'deleted',
    hashes: ['parent'],
    old: 'text',
    next: ''
  },
  {
    name: '重命名缺少原路径',
    parents: ['parent'],
    code: 'R100',
    expected: 'renamed',
    hashes: ['parent', 'commit'],
    old: 'text',
    next: 'text'
  }
]) {
  test(`${fixture.name}只读取存在且已知的版本路径`, async () => {
    const calls: Array<[string, string]> = []
    const diff = await loadGitCommitDiff(
      {
        gitCommitShow: async () => detail(fixture.parents),
        gitShowCommitFile: async (hash, path) => {
          calls.push([hash, path])
          return { success: true, content: 'text' }
        }
      },
      'commit',
      { code: fixture.code, path: 'known-path.txt' }
    )
    expect(calls).toEqual(fixture.hashes.map((hash) => [hash, 'known-path.txt']))
    expect([diff.changeType, diff.oldContent, diff.newContent]).toEqual([
      fixture.expected,
      fixture.old,
      fixture.next
    ])
    expect(diff.oldPath).toBeUndefined()
  })
}

test('任一历史版本含 NUL 时标记为二进制，空文本仍是合法内容', async () => {
  const diff = await loadGitCommitDiff(
    {
      gitCommitShow: async () => detail(),
      gitShowCommitFile: async (hash) => ({
        success: true,
        content: hash === 'parent' ? 'binary\0bytes' : ''
      })
    },
    'commit',
    { code: 'M', path: 'file.bin' }
  )
  expect(diff.binary).toBe(true)
  expect(diff.newContent).toBe('')
})

test('重命名历史按父提交原路径和目标提交新路径读取，保留空格与中文', async () => {
  const calls: Array<[string, string]> = []
  const diff = await loadGitCommitDiff(
    {
      gitCommitShow: async () => detail(),
      gitShowCommitFile: async (hash, path) => {
        calls.push([hash, path])
        return { success: true, content: hash === 'parent' ? 'before rename' : 'after rename' }
      }
    },
    'commit',
    { code: 'R090', oldPath: '旧 目录/原 文件.txt', path: '新 目录/新 文件.txt' }
  )
  expect(calls).toEqual([
    ['parent', '旧 目录/原 文件.txt'],
    ['commit', '新 目录/新 文件.txt']
  ])
  expect(diff).toMatchObject({
    oldPath: '旧 目录/原 文件.txt',
    path: '新 目录/新 文件.txt',
    changeType: 'renamed',
    oldContent: 'before rename',
    newContent: 'after rename'
  })
})

test('读取失败和缺少内容均拒绝，不能伪装成空 diff', async () => {
  let reads = 0
  await expect(
    loadGitCommitDiff(
      {
        gitCommitShow: async () => ({ success: false, error: 'commit unavailable' }),
        gitShowCommitFile: async () => {
          reads++
          return { success: true, content: '' }
        }
      },
      'commit',
      { code: 'M', path: 'file.txt' }
    )
  ).rejects.toThrow('commit unavailable')
  expect(reads).toBe(0)
  await expect(
    loadGitCommitDiff(
      {
        gitCommitShow: async () => detail(),
        gitShowCommitFile: async () => ({ success: false, error: 'permission denied' })
      },
      'commit',
      { code: 'M', path: 'file.txt' }
    )
  ).rejects.toThrow('permission denied')
  await expect(
    loadGitCommitDiff(
      {
        gitCommitShow: async () => detail(),
        gitShowCommitFile: async () => ({ success: true })
      },
      'commit',
      { code: 'M', path: 'file.txt' }
    )
  ).rejects.toThrow('历史文件内容缺失')
})
