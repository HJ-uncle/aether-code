/** Node-only real-repository line statistics: unborn files, both diff sides,
 * NUL rename records, binary/empty text and bounded physical-file reads. */
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { applyStatusNumstat, fillStatusStats, fillUntrackedStats, type StatusStatFile } from '../src/main/git/status-stats'

let fixture: string
let repo: string
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args],
  { encoding: 'utf8', windowsHide: true, env: environment() })
const file = (path: string, changeType = 'untracked'): StatusStatFile => ({ path, changeType, binary: false, additions: 0, deletions: 0 })

test.beforeEach(() => {
  mkdirSync(resolve('.e2e-tmp'), { recursive: true })
  fixture = mkdtempSync(join(resolve('.e2e-tmp'), 'git-status-stats-'))
  repo = join(fixture, 'project'); mkdirSync(repo)
  git('init', '-b', 'main')
  git('config', 'user.name', 'Stats Fixture'); git('config', 'user.email', 'stats@example.invalid')
})
test.afterEach(() => {
  if (dirname(fixture) !== resolve('.e2e-tmp') || !basename(fixture).startsWith('git-status-stats-')) throw new Error('Unsafe fixture cleanup')
  rmSync(fixture, { recursive: true, force: true, maxRetries: 3 })
})

test('新仓库未跟踪文本统计LF、CRLF、无末尾换行和空文件，二进制不伪造行数', async () => {
  const payloads = { 'lf.txt': 'one\ntwo\n', 'crlf.txt': 'one\r\ntwo\r\n', 'no-final.txt': 'one\ntwo', 'empty.txt': '', '中文 空格.txt': '1\n2\n3\n' }
  for (const [name, value] of Object.entries(payloads)) writeFileSync(join(repo, name), value)
  writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 10, 1, 10]))
  const files = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).map(name => file(name))
  await fillStatusStats(repo, files, async args => git(...args))
  for (const [name, additions] of [['lf.txt', 2], ['crlf.txt', 2], ['no-final.txt', 2], ['empty.txt', 0], ['中文 空格.txt', 3]] as const)
    expect(files.find(item => item.path === name)).toMatchObject({ additions, deletions: 0, unstagedAdditions: additions, unstagedDeletions: 0, binary: false })
  expect(files.find(item => item.path === 'binary.bin')).toMatchObject({ additions: 0, deletions: 0, binary: true })
  expect(files.reduce((sum, item) => sum + item.additions, 0)).toBe(9)
})

test('暂存与未暂存numstat分别累加，并使用真实重命名NUL记录的新路径', async () => {
  writeFileSync(join(repo, 'tracked.txt'), 'base\n')
  writeFileSync(join(repo, 'old name.txt'), 'rename payload\n')
  git('add', '.'); git('commit', '-m', 'initial')
  writeFileSync(join(repo, 'tracked.txt'), 'staged\n'); git('add', 'tracked.txt')
  writeFileSync(join(repo, 'tracked.txt'), 'worktree\nextra\n')
  git('mv', 'old name.txt', 'new name.txt')
  const files = [file('tracked.txt', 'modified'), file('new name.txt', 'renamed')]
  await fillStatusStats(repo, files, async args => git(...args))
  expect(files[0]).toMatchObject({ additions: 3, deletions: 2, stagedAdditions: 1, stagedDeletions: 1, unstagedAdditions: 2, unstagedDeletions: 1 })
  expect(files[1]).toMatchObject({ stagedAdditions: 0, stagedDeletions: 0, additions: 0, deletions: 0 })
  const synthetic = [file('new\tname\n.txt', 'renamed')]
  applyStatusNumstat('2\t1\t\0old\tname.txt\0new\tname\n.txt\0', synthetic, 'staged')
  expect(synthetic[0]).toMatchObject({ stagedAdditions: 2, stagedDeletions: 1 })
})

test('嵌套工作区numstat与文件路径统一相对当前目录，父目录改动不混入统计', async () => {
  const nested = join(repo, 'packages', 'client'); mkdirSync(nested, { recursive: true })
  writeFileSync(join(repo, 'outside.txt'), 'outside baseline\n')
  writeFileSync(join(nested, 'tracked.txt'), 'base\n')
  git('add', '.'); git('commit', '-m', 'nested baseline')
  writeFileSync(join(repo, 'outside.txt'), 'outside\nchanged\nagain\n')
  writeFileSync(join(nested, 'tracked.txt'), 'staged\n'); git('add', 'packages/client/tracked.txt')
  writeFileSync(join(nested, 'tracked.txt'), 'worktree\nextra\n')
  writeFileSync(join(nested, 'new.txt'), 'new\nfile\n')
  const files = [file('tracked.txt', 'modified'), file('new.txt')]
  await fillStatusStats(nested, files, async args => git('-C', nested, ...args))
  expect(files[0]).toMatchObject({ additions: 3, deletions: 2, stagedAdditions: 1, stagedDeletions: 1, unstagedAdditions: 2, unstagedDeletions: 1 })
  expect(files[1]).toMatchObject({ additions: 2, deletions: 0, unstagedAdditions: 2, binary: false })
  expect(files.reduce((sum, item) => sum + item.additions, 0)).toBe(5)
})

test('同体积文件内容变化使行数缓存失效，超限文件不假装二进制', async () => {
  writeFileSync(join(repo, 'changing.txt'), 'abcdef')
  const first = file('changing.txt'); await fillUntrackedStats(repo, [first])
  expect(first.additions).toBe(1)
  writeFileSync(join(repo, 'changing.txt'), 'a\nb\nc\n')
  const later = new Date(Date.now() + 2000); utimesSync(join(repo, 'changing.txt'), later, later)
  const changed = file('changing.txt'); await fillUntrackedStats(repo, [changed])
  expect(changed).toMatchObject({ additions: 3, unstagedAdditions: 3 })
  writeFileSync(join(repo, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 10))
  const large = file('large.txt'); await fillUntrackedStats(repo, [large])
  expect(large).toEqual({ path: 'large.txt', changeType: 'untracked', binary: false, additions: 0, deletions: 0 })
})

test('统计不跟随工作区外目录链接，也不读取相对越界路径', async () => {
  const outside = join(fixture, 'outside'); mkdirSync(outside)
  writeFileSync(join(outside, 'private.txt'), 'private\nprivate\nprivate\n')
  symlinkSync(outside, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const files = [file('linked/private.txt'), file('../outside/private.txt')]
  await fillUntrackedStats(repo, files)
  expect(files.map(item => item.additions)).toEqual([0, 0])
  expect(files.every(item => item.unstagedAdditions === undefined)).toBe(true)
})
