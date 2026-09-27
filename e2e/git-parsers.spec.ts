import { expect, test } from '@playwright/test'
import {
  isNoCommitsError,
  isNotARepoError,
  parseGitLog,
  parseGitStatus
} from '../src/main/git/parsers'

/**
 * 纯函数测试：git 输出解析（src/main/git/parsers.ts）。
 *
 * 本文件覆盖：parseGitStatus（分支 / 改动条目 / 暂存标记）、parseGitLog、
 * isNotARepoError、isNoCommitsError。
 *
 * 样本是**真实 git 输出**（本机 git 2.55 在某个仓库上跑出来的），
 * 不是手编的格式 —— 手编样本只能验证"我以为的格式"，验证不了 git 实际给什么。
 * parsers.ts 只 import type，因此能在 Node 里直接加载。
 */

/** git status --porcelain=v1 -z --branch 的真实输出（\0 已转义为 \u0000） */
const REAL_STATUS =
  '## main...origin/main\u0000 M package-lock.json\u0000 M packages/cli/bin/paseo\u0000?? .tmp/\u0000'

/** git log --pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s 的真实输出 */
const REAL_LOG =
  '2c8e8a826810337492cc5a38bb0bbd705b6fb632\u001f2c8e8a826\u001fMohamed Boudra\u001f2026-09-21T12:34:41+02:00\u001fHEAD -> main, origin/main, origin/HEAD\u001ffix(app): use Command+F for Find on macOS across chat, file, and terminal (#5129)\n' +
  'ee7949ae25441d67e0780b4e99bf1d4e7c57897c\u001fee7949ae2\u001fMatt Cowger\u001f2026-09-21T02:53:52-07:00\u001f\u001ffix(pi): honor per-model thinking configuration (#4413)\n' +
  'd636abd7a4ce302e7ccb9eb6074f637c6dd4d83b\u001fd636abd7a\u001fpaseo-ai[bot]\u001f2026-09-18T09:49:37Z\u001f\u001ffix: update lockfile signatures and Nix hash [skip ci]'

test.describe('parseGitStatus', () => {
  test('真实输出：分支、改动条目、暂存标记都解析正确', () => {
    const status = parseGitStatus(REAL_STATUS)

    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    // 该仓库没有配置上游领先/落后信息
    expect(status.ahead).toBeNull()
    expect(status.behind).toBeNull()

    expect(status.changes).toHaveLength(3)
    expect(status.changes.map((item) => item.path)).toEqual([
      'package-lock.json',
      'packages/cli/bin/paseo',
      '.tmp/'
    ])

    // ' M' = 工作区已修改、暂存区无变化 → 不算已暂存
    expect(status.changes[0]).toMatchObject({
      indexStatus: ' ',
      workTreeStatus: 'M',
      staged: false
    })
    // '??' = 未跟踪：虽然字符在暂存列上，但不能当成"已暂存"
    expect(status.changes[2]).toMatchObject({
      indexStatus: '?',
      workTreeStatus: '?',
      staged: false
    })
  })

  test('有上游时解析 ahead / behind', () => {
    const status = parseGitStatus('## main...origin/main [ahead 2, behind 1]\u0000')

    expect(status.branch).toBe('main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(1)
  })

  test('只领先不落后时 behind 为 null', () => {
    const status = parseGitStatus('## dev...origin/dev [ahead 3]\u0000')
    expect(status.branch).toBe('dev')
    expect(status.ahead).toBe(3)
    expect(status.behind).toBeNull()
  })

  test('无上游的分支名不带 ... 后缀', () => {
    const status = parseGitStatus('## feature/local\u0000')
    expect(status.branch).toBe('feature/local')
    expect(status.ahead).toBeNull()
    expect(status.behind).toBeNull()
  })

  test('分离头指针归一为 HEAD', () => {
    expect(parseGitStatus('## HEAD (no branch)\u0000').branch).toBe('HEAD')
  })

  test('空仓库的分支行也能解析出分支名', () => {
    const status = parseGitStatus('## No commits yet on main\u0000')
    expect(status.branch).toBe('main')
    expect(status.changes).toEqual([])
  })

  test('重命名条目会消费掉紧跟的原始路径，不产生多余条目', () => {
    // git 在 -z 模式下把重命名输出为 `R  new\0old\0`
    const status = parseGitStatus('## main\u0000R  new.ts\u0000old.ts\u0000')

    expect(status.changes).toHaveLength(1)
    expect(status.changes[0].path).toBe('new.ts')
    expect(status.changes[0].indexStatus).toBe('R')
    expect(status.changes[0].staged).toBe(true)
  })

  test('已暂存的修改计入 staged', () => {
    const status = parseGitStatus('## main\u0000M  staged.ts\u0000MM both.ts\u0000')
    expect(status.changes[0]).toMatchObject({ indexStatus: 'M', workTreeStatus: ' ', staged: true })
    expect(status.changes[1]).toMatchObject({ indexStatus: 'M', workTreeStatus: 'M', staged: true })
  })

  test('没有分支行时（异常输出）不猜分支，仍解析条目', () => {
    const status = parseGitStatus(' M a.ts\u0000')
    expect(status.branch).toBe('')
    expect(status.changes).toHaveLength(1)
  })
})

test.describe('parseGitLog', () => {
  test('真实输出：提交标题里的特殊字符不会破坏字段切分', () => {
    const commits = parseGitLog(REAL_LOG)

    expect(commits).toHaveLength(3)
    expect(commits[0].shortHash).toBe('2c8e8a826')
    expect(commits[0].author).toBe('Mohamed Boudra')
    expect(commits[0].date).toBe('2026-09-21T12:34:41+02:00')
    expect(commits[0].refs).toBe('HEAD -> main, origin/main, origin/HEAD')
    // 标题里带括号、加号、逗号，都完整保留
    expect(commits[0].subject).toContain('Command+F for Find on macOS')
    // 无引用装饰时为空串而不是 undefined
    expect(commits[1].refs).toBe('')
    expect(commits[2].author).toBe('paseo-ai[bot]')
  })

  test('空输出返回空数组（空仓库）', () => {
    expect(parseGitLog('')).toEqual([])
  })

  test('字段数不足的行被跳过，不会产出半截提交', () => {
    const broken = 'abc\u001fdef\u001fauthor\n' + REAL_LOG.split('\n')[0]
    expect(parseGitLog(broken)).toHaveLength(1)
  })
})

test.describe('错误识别', () => {
  test('识别"不是仓库"', () => {
    expect(
      isNotARepoError('fatal: not a git repository (or any of the parent directories): .git')
    ).toBe(true)
    expect(isNotARepoError('致命错误：不在一个 git 仓库中')).toBe(false)
  })

  test('识别"仓库还没有提交"', () => {
    expect(
      isNoCommitsError("fatal: your current branch 'main' does not have any commits yet")
    ).toBe(true)
    expect(isNoCommitsError('bad revision HEAD')).toBe(true)
    expect(isNoCommitsError('fatal: not a git repository')).toBe(false)
  })
})
