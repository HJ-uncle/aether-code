/// <reference path="../src/preload/index.d.ts" />
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import type { AetherIdeApi } from '../src/preload'

/** All 80 Git IPC operations, exercised against disposable repositories and local bare remotes.
 * No user repository, credential, SSH agent or Internet remote is modified.
 * The root runner owns Electron serialization; this spec launches only when explicitly executed.
 */
type Method = Exclude<keyof AetherIdeApi['git'], 'onCloneProgress'>
type Result<K extends Method> = Awaited<ReturnType<AetherIdeApi['git'][K]>>
let app: ElectronApplication
let page: Page
let scratch: string
const appRoot = resolve(__dirname, '..')
let sequence = 0

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'empty-gitconfig'), GIT_EDITOR: 'true' }
  }).trim()
}
function write(root: string, name: string, content: string): void { writeFileSync(join(root, name), content) }
function read(root: string, name: string): string { return readFileSync(join(root, name), 'utf8') }
async function call<K extends Method>(method: K, ...args: Parameters<AetherIdeApi['git'][K]>): Promise<Result<K>> {
  return page.evaluate(async ({ method, args }) => {
    const fn = window.aether.git[method] as unknown as (...values: unknown[]) => Promise<unknown>
    return await fn(...args)
  }, { method, args }) as Promise<Result<K>>
}
async function ok<K extends Method>(method: K, ...args: Parameters<AetherIdeApi['git'][K]>): Promise<Result<K>> {
  const result = await call(method, ...args)
  expect(result.success, `${method}: ${JSON.stringify(result)}`).toBe(true)
  return result
}
async function repo(empty = false): Promise<string> {
  const root = join(scratch, `repo-${++sequence}`)
  mkdirSync(root)
  await ok('init', root)
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(root, 'config', 'user.name', 'Aether Matrix')
  git(root, 'config', 'user.email', 'matrix@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')
  if (!empty) {
    write(root, 'a.txt', 'base\n')
    write(root, 'b.txt', 'second\n')
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'initial')
  }
  return root
}
function commitFile(root: string, name: string, text: string, message: string): string {
  write(root, name, text); git(root, 'add', '--', name); git(root, 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'aether-git-matrix-'))
  writeFileSync(join(scratch, 'empty-gitconfig'), '')
  const profile = join(scratch, 'profile'); mkdirSync(profile)
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: scratch, lastSessionId: 'git-matrix', engineMode: 'embedded' }))
  app = await electron.launch({ cwd: appRoot, args: ['.', `--user-data-dir=${profile}`], env: {
    ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'empty-gitconfig'), GIT_EDITOR: 'true'
  } })
  page = await app.firstWindow()
  await page.waitForSelector('.workbench')
  await page.evaluate(root => window.aether.fs.allowRoot(root), scratch)
})
test.afterAll(async () => {
  await app?.close()
  if (!scratch) return
  const suffix = relative(tmpdir(), scratch)
  if (suffix.startsWith('aether-git-matrix-') && !isAbsolute(suffix) && !suffix.includes('..')) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('repository initialization, unborn HEAD and workspace access boundary', async () => {
  const root = await repo(true)
  expect((await ok('status', root)).isRepo).toBe(true)
  expect((await ok('log', root)).commits).toEqual([])
  const plain = join(scratch, `plain-${++sequence}`); mkdirSync(plain)
  expect((await ok('status', plain)).isRepo).toBe(false)
  expect((await ok('branchInfo', plain)).isRepo).toBe(false)
  expect((await call('status', tmpdir())).success).toBe(false)
  write(root, 'new.txt', 'unborn\n')
  await ok('stage', root, 'new.txt'); expect(git(root, 'diff', '--cached', '--name-only')).toBe('new.txt')
  await ok('unstage', root, 'new.txt'); expect(git(root, 'diff', '--cached', '--name-only')).toBe('')
  await ok('stageFiles', root, ['new.txt']); await ok('unstageFiles', root, ['new.txt'])
  expect((await ok('status', root)).files?.[0]).toMatchObject({ path: 'new.txt', staged: false, changeType: 'untracked' })
  expect((await call('commit', root, '')).success).toBe(false)
})

test('status, index/worktree separation, batch operations, ignore, diff and hunk rollback', async () => {
  const root = await repo()
  write(root, 'a.txt', 'staged\n'); await ok('stage', root, 'a.txt'); write(root, 'a.txt', 'working\n')
  const state = (await ok('status', root)).files?.find(f => f.path === 'a.txt')
  expect(state).toMatchObject({ staged: true, stagedChange: 'modified', unstagedChange: 'modified' })
  expect((await ok('diff', root, 'a.txt', true)).diff).toMatchObject({ oldContent: 'base\n', newContent: 'staged\n' })
  expect((await ok('diff', root, 'a.txt', false)).diff).toMatchObject({ oldContent: 'staged\n', newContent: 'working\n' })
  expect((await ok('diff', root, 'a.txt', false, 'head')).diff?.oldContent).toBe('base\n')
  expect((await ok('headFile', root, 'a.txt')).content).toBe('base\n')
  expect((await ok('getHeadFile', root, 'a.txt')).content).toBe('base\n')
  await ok('discardWorktree', root, 'a.txt'); expect(read(root, 'a.txt')).toBe('staged\n')
  await ok('unstage', root, 'a.txt'); await ok('discardFile', root, 'a.txt'); expect(read(root, 'a.txt')).toBe('base\n')
  write(root, 'a.txt', 'a changed\n'); write(root, 'b.txt', 'b changed\n')
  expect((await ok('stageFiles', root, ['a.txt', 'b.txt', 'missing.txt'])).stagedPaths?.sort()).toEqual(['a.txt', 'b.txt'])
  await ok('unstageFiles', root, ['a.txt', 'b.txt']); expect(git(root, 'diff', '--cached', '--name-only')).toBe('')
  await ok('discardWorktreeFiles', root, ['a.txt', 'b.txt']); expect(read(root, 'b.txt')).toBe('second\n')
  write(root, 'a.txt', 'again\n'); write(root, 'untracked.txt', 'temporary\n')
  await ok('discardFiles', root, ['a.txt', 'untracked.txt']); expect(existsSync(join(root, 'untracked.txt'))).toBe(false)
  expect(read(root, 'a.txt')).toBe('base\n')
  await ok('appendGitignore', root, 'ignored.txt'); write(root, 'ignored.txt', 'ignored\n')
  expect((await ok('checkIgnored', root, ['ignored.txt', 'a.txt'])).ignored).toEqual({ 'ignored.txt': true, 'a.txt': false })
  const initial = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n') + '\n'
  commitFile(root, 'hunks.txt', initial, 'hunk base')
  write(root, 'hunks.txt', initial.replace('line-1\n', 'first changed\n').replace('line-25\n', 'last changed\n'))
  const hunks = (await ok('diff', root, 'hunks.txt', false, 'head')).diff!.hunks
  expect(hunks).toHaveLength(2)
  await ok('discardHunk', root, 'hunks.txt', hunks[0].id)
  expect(read(root, 'hunks.txt')).toContain('line-1\n'); expect(read(root, 'hunks.txt')).toContain('last changed\n')
  expect((await call('discardHunk', root, 'hunks.txt', 'h999')).success).toBe(false)
})

test('commit variants, local suggestion, immutable history, blame and file timeline', async () => {
  const root = await repo()
  write(root, 'a.txt', 'second version\n'); await ok('stage', root, 'a.txt')
  expect((await ok('suggestCommitMessage', root)).message).toContain('更新 1 个文件')
  await ok('commit', root, 'second\n\nbody detail')
  expect(git(root, 'log', '-1', '--format=%s')).toBe('second')
  write(root, 'b.txt', 'amended\n'); await ok('stage', root, 'b.txt'); await ok('commitAmend', root)
  expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('2')
  await ok('commitAmendWithMessage', root, 'renamed commit')
  expect(git(root, 'log', '-1', '--format=%s')).toBe('renamed commit')
  await ok('commitEmpty', root, 'empty marker'); expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('3')
  await ok('undoCommit', root); expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('2')
  write(root, 'c.txt', 'all\n'); await ok('stageAllAndCommit', root, 'all files')
  expect(git(root, 'status', '--porcelain')).toBe('')
  const history = (await ok('log', root, 10, 0)).commits!
  expect(history.map(c => c.subject)).toEqual(['all files', 'renamed commit', 'initial'])
  expect((await ok('log', root, 1, 1)).commits?.[0].subject).toBe('renamed commit')
  expect((await ok('log', root, 10, 0, { search: 'renamed', author: 'Aether Matrix', refs: ['main'] })).commits).toHaveLength(1)
  const detail = await ok('commitShow', root, history[0].hash)
  expect(JSON.stringify(detail)).toContain('c.txt')
  expect((await ok('showCommitFile', root, history[2].hash, 'a.txt')).content).toBe('base\n')
  expect((await ok('fileHistory', root, 'a.txt', 10)).entries?.map(e => e.subject)).toEqual(['renamed commit', 'initial'])
  expect((await ok('blame', root, 'a.txt')).lines?.[0]).toMatchObject({ author: 'Aether Matrix', subject: 'renamed commit' })
  expect(await ok('getUserName', root)).toMatchObject({ name: 'Aether Matrix', email: 'matrix@example.invalid' })
  expect((await ok('listAuthors', root)).authors).toEqual(['Aether Matrix'])
  expect((await call('suggestCommitMessage', root)).success).toBe(false)
})

test('branch create/checkout/rename/delete and lightweight/annotated tags', async () => {
  const root = await repo()
  expect((await ok('branchInfo', root)).info).toMatchObject({ branch: 'main', upstream: null })
  await ok('createBranch', root, 'feature', 'HEAD')
  expect(git(root, 'branch', '--show-current')).toBe('feature')
  await ok('checkout', root, 'main'); await ok('renameBranch', root, 'feature', 'renamed')
  expect((await ok('listBranches', root)).branches?.sort()).toEqual(['main', 'renamed'])
  await ok('deleteBranch', root, 'renamed', false)
  expect((await ok('listBranches', root)).branches).toEqual(['main'])
  expect((await call('checkout', root, 'does-not-exist')).success).toBe(false)
  await ok('createTag', root, 'v1'); await ok('createTag', root, 'v2', 'annotation')
  expect((await ok('listTags', root)).tags).toEqual(['v1', 'v2'])
  expect(git(root, 'cat-file', '-t', 'v2')).toBe('tag')
  expect((await call('createTag', root, 'v1')).success).toBe(false)
  await ok('deleteTag', root, 'v1'); expect((await ok('listTags', root)).tags).toEqual(['v2'])
})

test('stash push/pop/apply/drop/batch/clear and staged-only preservation', async () => {
  const root = await repo()
  write(root, 'a.txt', 'stash one\n'); write(root, 'extra.txt', 'untracked\n')
  await ok('stashPush', root, 'one', true)
  expect(read(root, 'a.txt')).toBe('base\n'); expect(existsSync(join(root, 'extra.txt'))).toBe(false)
  expect((await ok('listStashes', root)).stashes?.[0].message).toContain('one')
  expect((await ok('stashShow', root, 0)).content).toContain('stash one')
  expect((await ok('stashShowFiles', root, 0)).content).toContain('a.txt')
  await ok('stashApply', root, 0); expect(read(root, 'a.txt')).toBe('stash one\n')
  expect((await ok('listStashes', root)).stashes).toHaveLength(1)
  await ok('discardFiles', root, ['a.txt', 'extra.txt']); await ok('stashPop', root, 0)
  expect((await ok('listStashes', root)).stashes).toEqual([])
  await ok('discardFiles', root, ['a.txt', 'extra.txt'])
  write(root, 'a.txt', 'index only\n'); await ok('stage', root, 'a.txt'); write(root, 'b.txt', 'kept worktree\n')
  await ok('stashPushStaged', root, 'staged-only')
  expect(read(root, 'a.txt')).toBe('base\n'); expect(read(root, 'b.txt')).toBe('kept worktree\n')
  await ok('stashDrop', root, 0); await ok('discardWorktree', root, 'b.txt')
  for (let i = 0; i < 3; i++) { write(root, 'a.txt', `stash ${i}\n`); await ok('stashPush', root, `batch-${i}`) }
  await ok('stashDropBatch', root, [0, 2, 2])
  const remaining = (await ok('listStashes', root)).stashes!
  expect(remaining).toHaveLength(1); expect(remaining[0].message).toContain('batch-1')
  await ok('stashClear', root); expect((await ok('listStashes', root)).stashes).toEqual([])
  expect((await call('stashPop', root, 0)).success).toBe(false)
})

test('merge/rebase/cherry-pick/revert success and each conflict abort preserves original HEAD', async () => {
  const root = await repo(); const base = git(root, 'rev-parse', 'HEAD')
  await ok('createBranch', root, 'feature'); const feature = commitFile(root, 'feature.txt', 'feature\n', 'feature')
  await ok('checkout', root, 'main'); await ok('merge', root, 'feature'); expect(git(root, 'rev-parse', 'HEAD')).toBe(feature)
  await ok('revertCommit', root, feature); expect(existsSync(join(root, 'feature.txt'))).toBe(false)
  await ok('createBranch', root, 'pick', base); await ok('cherryPick', root, feature); expect(read(root, 'feature.txt')).toBe('feature\n')
  await ok('createBranch', root, 'rebase-ok', base); commitFile(root, 'rebased.txt', 'rebase\n', 'rebase')
  await ok('rebase', root, 'pick'); expect(read(root, 'feature.txt')).toBe('feature\n'); expect(read(root, 'rebased.txt')).toBe('rebase\n')
  await ok('createBranch', root, 'left', base); const left = commitFile(root, 'a.txt', 'left\n', 'left change')
  await ok('createBranch', root, 'right', base); const right = commitFile(root, 'a.txt', 'right\n', 'right change')
  expect((await call('merge', root, 'left')).success).toBe(false)
  expect((await ok('status', root)).files?.some(f => f.path === 'a.txt' && f.conflict)).toBe(true)
  await ok('mergeAbort', root); expect(git(root, 'rev-parse', 'HEAD')).toBe(right); expect(read(root, 'a.txt')).toBe('right\n')
  expect((await call('rebase', root, 'left')).success).toBe(false)
  await ok('rebaseAbort', root); expect(git(root, 'rev-parse', 'HEAD')).toBe(right)
  expect((await call('cherryPick', root, left)).success).toBe(false)
  await ok('cherryPickAbort', root); expect(git(root, 'rev-parse', 'HEAD')).toBe(right)
  expect(git(root, 'status', '--porcelain')).toBe('')
})

test('local bare remote fetch/pull strategies/push/publish/sync/force/tags and clone progress', async () => {
  const root = await repo()
  const remote = join(scratch, `remote-${++sequence}.git`); mkdirSync(remote); git(remote, 'init', '--bare', '--initial-branch=main')
  await ok('addRemote', root, 'origin', remote)
  expect((await ok('listRemotes', root)).remotes?.[0]).toMatchObject({ name: 'origin', url: remote })
  await ok('publishBranch', root); expect(git(remote, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'))
  expect((await ok('branchInfo', root)).info).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 })
  const parent = join(scratch, `clones-${++sequence}`); mkdirSync(parent)
  await page.evaluate(() => { (window as unknown as { matrixCloneProgress: unknown[] }).matrixCloneProgress = []; window.aether.git.onCloneProgress(p => (window as unknown as { matrixCloneProgress: unknown[] }).matrixCloneProgress.push(p)) })
  const clone = await ok('clone', { url: `git clone ${remote}`, parentDir: parent }); const peer = clone.finalPath!
  expect(read(peer, 'a.txt')).toBe('base\n')
  expect(await page.evaluate(() => (window as unknown as { matrixCloneProgress: Array<{ percentage: number }> }).matrixCloneProgress.some(p => p.percentage === 100))).toBe(true)
  git(peer, 'config', 'user.name', 'Aether Matrix'); git(peer, 'config', 'user.email', 'matrix@example.invalid')
  commitFile(peer, 'peer.txt', 'incoming\n', 'peer commit'); git(peer, 'push', 'origin', 'main')
  await ok('fetch', root)
  expect(await ok('divergence', root)).toMatchObject({ ahead: 0, behind: 1 })
  expect((await ok('incoming', root)).commits?.[0].subject).toBe('peer commit')
  expect((await ok('listRemoteBranches', root)).branches).toContain('origin/main')
  await ok('pull', root); expect(read(root, 'peer.txt')).toBe('incoming\n')
  await ok('pullFrom', root, 'origin', 'main')
  await ok('pullMerge', root, true); expect(git(root, 'config', '--get', 'pull.rebase')).toBe('false')
  await ok('pullRebaseWithChoice', root, true); expect(git(root, 'config', '--get', 'pull.rebase')).toBe('true')
  await ok('pullRebase', root)
  commitFile(root, 'local.txt', 'outgoing\n', 'local commit'); await ok('push', root)
  expect(git(remote, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'))
  await ok('sync', root); await ok('pushTo', root, 'origin', 'main'); await ok('pushForce', root)
  await ok('createTag', root, 'tag-one'); await ok('createTag', root, 'tag-two')
  await ok('pushTag', root, 'tag-one'); await ok('pushTags', root)
  expect(git(remote, 'tag', '--list')).toBe('tag-one\ntag-two')
  await ok('deleteRemoteTag', root, 'tag-one', 'origin'); expect(git(remote, 'tag', '--list')).toBe('tag-two')
  await ok('createBranch', root, 'publish-me'); await ok('publishBranch', root); await ok('checkout', root, 'main')
  await ok('deleteRemoteBranch', root, 'origin', 'publish-me'); expect(git(remote, 'branch', '--list', 'publish-me')).toBe('')
  await ok('addRemote', root, 'temporary', remote); await ok('removeRemote', root, 'temporary')
  expect((await ok('listRemotes', root)).remotes?.map(r => r.name)).toEqual(['origin'])
  const duplicate = await ok('clone', { url: remote, parentDir: parent }); expect(duplicate.finalPath).toBe(`${peer}-1`)
  await ok('cancelClone', 'already-finished-nonexistent')
  expect((await call('clone', { url: '', parentDir: parent })).success).toBe(false)
  expect((await call('clone', { url: join(scratch, 'missing.git'), parentDir: parent })).success).toBe(false)
  if (process.platform === 'win32') { const ssh = await call('addSshKey', 'synthetic-no-real-secret'); expect(ssh.success).toBe(false); expect(ssh.error).toContain('Windows') }
})

test('coverage inventory includes every Git invoke method through the preload bridge', async () => {
  const source = readFileSync(__filename, 'utf8')
  const exercised = new Set([...source.matchAll(/(?:ok|call)\('([^']+)'/g)].map(m => m[1]))
  const exposed = await page.evaluate(() => Object.keys(window.aether.git).filter(name => name !== 'onCloneProgress'))
  expect(exposed).toHaveLength(80)
  expect(exposed.filter(name => !exercised.has(name))).toEqual([])
})
