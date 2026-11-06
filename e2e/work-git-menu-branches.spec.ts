/** Every Branch and Commit submenu item runs through the real Work Git UI in
 * its own repository. Ref ancestry, index entries, files, and native conflict
 * state verify effects independently of the rendered success/error notices. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type GitMenuHarness } from './helpers/work-git-menu'

const changed = { timeout: 20_000 }
const head = (menu: GitMenuHarness): string => menu.git('rev-parse', 'HEAD').trim()
const parents = (menu: GitMenuHarness): string[] => menu.git('show', '-s', '--format=%P', 'HEAD').trim().split(/\s+/).filter(Boolean)
const localRef = (menu: GitMenuHarness, name: string): string => menu.git('for-each-ref', '--format=%(objectname)', `refs/heads/${name}`).trim()
const contents = (menu: GitMenuHarness, file: string): string => readFileSync(join(menu.repo, file), 'utf8')

async function prepareFork(menu: GitMenuHarness, conflicting: boolean): Promise<{ base: string; source: string; target: string; subject: string }> {
  await menu.idle()
  const base = head(menu)
  const subject = conflicting ? 'menu conflicting source' : 'menu clean source'
  menu.git('switch', '-c', 'menu-source')
  const source = menu.commit(conflicting ? 'tracked.txt' : 'source.txt', 'source payload\n', subject)
  menu.git('switch', 'main')
  const target = menu.commit(conflicting ? 'tracked.txt' : 'target.txt', 'target payload\n', 'menu target commit')
  await menu.refresh()
  await expect(menu.panel.locator('.git-branchbar__name')).toHaveText('main')
  return { base, source: source.trim(), target: target.trim(), subject }
}

async function pickBranchOperation(menu: GitMenuHarness, item: string): Promise<void> {
  await menu.action('分支', item)
  await menu.pick('menu-source')
}

async function showAllHistory(menu: GitMenuHarness, subject: string): Promise<void> {
  const history = menu.panel.locator('.git-panel__history')
  if (!(await history.isVisible())) {
    await menu.panel.locator('.git-panel__group-head').filter({ hasText: '提交历史' }).click()
  }
  await expect(history).toBeVisible()
  await history.getByRole('button', { name: '分支', exact: true }).click()
  await menu.page.getByRole('menuitem', { name: '全部分支', exact: true }).click()
  await expect(history.locator('.git-panel__commit-subject').filter({ hasText: subject })).toHaveCount(1)
  await menu.idle()
}

async function expectConflict(menu: GitMenuHarness): Promise<void> {
  await expect.poll(() => menu.git('ls-files', '--unmerged'), changed).not.toBe('')
  expect(contents(menu, 'tracked.txt')).toContain('<<<<<<<')
  await menu.idle()
  await expect(menu.panel.getByRole('alert')).toBeVisible()
}

async function expectAborted(menu: GitMenuHarness, original: string, source: string): Promise<void> {
  await expect.poll(() => menu.git('ls-files', '--unmerged'), changed).toBe('')
  await menu.idle()
  expect(head(menu)).toBe(original)
  expect(localRef(menu, 'main')).toBe(original)
  expect(localRef(menu, 'menu-source')).toBe(source)
  expect(menu.git('branch', '--show-current').trim()).toBe('main')
  expect(contents(menu, 'tracked.txt')).toBe('target payload\n')
  expect(menu.git('status', '--porcelain=v1')).toBe('')
  await expect(menu.panel.getByRole('alert')).toHaveCount(0)
}

test.describe('Work Git 更多菜单：分支十二项', () => {
  test('新建分支：从当前 HEAD 创建并切换', async ({ menu }) => {
    const original = head(menu)
    await menu.action('分支', '新建分支…')
    await menu.prompt('menu-created')
    await expect.poll(() => menu.git('branch', '--show-current').trim(), changed).toBe('menu-created')
    await menu.idle()
    expect(localRef(menu, 'menu-created')).toBe(original)
    expect(localRef(menu, 'main')).toBe(original)
    expect(contents(menu, 'tracked.txt')).toBe('baseline\n')
    expect(menu.git('status', '--porcelain=v1')).toBe('')
  })

  test('基于其他分支/提交新建：采用指定提交而非当前 HEAD', async ({ menu }) => {
    const base = head(menu)
    const latest = menu.commit('newer.txt', 'newer commit\n', 'menu newer commit').trim()
    await menu.refresh()
    await menu.action('分支', '基于其他分支/提交新建…')
    await menu.prompt(base)
    await menu.prompt('menu-from-base')
    await expect.poll(() => menu.git('branch', '--show-current').trim(), changed).toBe('menu-from-base')
    await menu.idle()
    expect(head(menu)).toBe(base)
    expect(localRef(menu, 'main')).toBe(latest)
    expect(existsSync(join(menu.repo, 'newer.txt'))).toBe(false)
    expect(menu.git('status', '--porcelain=v1')).toBe('')
  })

  test('合并分支：保留两个父提交并落盘双方文件', async ({ menu }) => {
    const fork = await prepareFork(menu, false)
    await pickBranchOperation(menu, '合并分支…')
    await expect.poll(() => parents(menu), changed).toEqual([fork.target, fork.source])
    await menu.idle()
    expect(contents(menu, 'source.txt')).toBe('source payload\n')
    expect(contents(menu, 'target.txt')).toBe('target payload\n')
    expect(localRef(menu, 'menu-source')).toBe(fork.source)
    expect(menu.git('status', '--porcelain=v1')).toBe('')
  })

  test('中止合并：真实合并冲突恢复原 HEAD 和工作树', async ({ menu }) => {
    const fork = await prepareFork(menu, true)
    await pickBranchOperation(menu, '合并分支…')
    await expectConflict(menu)
    expect(readFileSync(join(menu.repo, '.git', 'MERGE_HEAD'), 'utf8').trim()).toBe(fork.source)
    await menu.refresh()
    await menu.action('分支', '中止合并')
    await expect.poll(() => existsSync(join(menu.repo, '.git', 'MERGE_HEAD')), changed).toBe(false)
    await expectAborted(menu, fork.target, fork.source)
  })

  test('变基到分支：重写当前提交并以目标分支为父', async ({ menu }) => {
    const fork = await prepareFork(menu, false)
    await pickBranchOperation(menu, '变基到分支…')
    await expect.poll(() => parents(menu), changed).toEqual([fork.source])
    await menu.idle()
    expect(head(menu)).not.toBe(fork.target)
    expect(menu.git('show', '-s', '--format=%s', 'HEAD').trim()).toBe('menu target commit')
    expect(contents(menu, 'source.txt')).toBe('source payload\n')
    expect(contents(menu, 'target.txt')).toBe('target payload\n')
    expect(localRef(menu, 'menu-source')).toBe(fork.source)
    expect(menu.git('status', '--porcelain=v1')).toBe('')
  })

  test('中止变基：真实变基冲突恢复原分支和提交', async ({ menu }) => {
    const fork = await prepareFork(menu, true)
    await pickBranchOperation(menu, '变基到分支…')
    await expectConflict(menu)
    const rebaseDirectories = ['rebase-merge', 'rebase-apply'].map(name => join(menu.repo, '.git', name))
    expect(rebaseDirectories.some(existsSync)).toBe(true)
    await menu.action('分支', '中止变基')
    await expect.poll(() => rebaseDirectories.some(existsSync), changed).toBe(false)
    await expectAborted(menu, fork.target, fork.source)
  })

  test('拣选提交：通过全部分支历史选择旁支提交并生成新父链', async ({ menu }) => {
    const fork = await prepareFork(menu, false)
    await showAllHistory(menu, fork.subject)
    await menu.action('分支', '拣选提交（cherry-pick）…')
    await menu.pick(fork.subject)
    await expect.poll(() => parents(menu), changed).toEqual([fork.target])
    await menu.idle()
    expect(head(menu)).not.toBe(fork.source)
    expect(menu.git('show', '-s', '--format=%s', 'HEAD').trim()).toBe(fork.subject)
    expect(contents(menu, 'source.txt')).toBe('source payload\n')
    expect(contents(menu, 'target.txt')).toBe('target payload\n')
    expect(localRef(menu, 'menu-source')).toBe(fork.source)
    expect(menu.git('status', '--porcelain=v1')).toBe('')
  })

  test('中止拣选：真实拣选冲突移除状态并恢复原提交', async ({ menu }) => {
    const fork = await prepareFork(menu, true)
    await showAllHistory(menu, fork.subject)
    await menu.action('分支', '拣选提交（cherry-pick）…')
    await menu.pick(fork.subject)
    await expectConflict(menu)
    expect(readFileSync(join(menu.repo, '.git', 'CHERRY_PICK_HEAD'), 'utf8').trim()).toBe(fork.source)
    await menu.action('分支', '中止拣选')
    await expect.poll(() => existsSync(join(menu.repo, '.git', 'CHERRY_PICK_HEAD')), changed).toBe(false)
    await expectAborted(menu, fork.target, fork.source)
  })

  test('重命名当前分支：迁移本地引用并保留提交', async ({ menu }) => {
    const original = head(menu)
    await menu.action('分支', '重命名当前分支…')
    await menu.prompt('menu-renamed')
    await expect.poll(() => menu.git('branch', '--show-current').trim(), changed).toBe('menu-renamed')
    await menu.idle()
    expect(localRef(menu, 'main')).toBe('')
    expect(localRef(menu, 'menu-renamed')).toBe(original)
    expect(menu.git('status', '--porcelain=v1')).toBe('')
  })

  test('删除分支：确认后只移除选中的本地引用', async ({ menu }) => {
    const original = head(menu)
    menu.git('branch', 'menu-delete')
    menu.git('branch', 'menu-keep')
    await menu.refresh()
    await menu.action('分支', '删除分支…')
    await menu.pick('menu-delete')
    await menu.confirm('删除')
    await expect.poll(() => localRef(menu, 'menu-delete'), changed).toBe('')
    await menu.idle()
    expect(localRef(menu, 'menu-keep')).toBe(original)
    expect(localRef(menu, 'main')).toBe(original)
    expect(head(menu)).toBe(original)
  })

  test('删除远程分支：确认后移除 bare origin 的目标引用', async ({ menu }) => {
    const original = head(menu)
    menu.git('push', 'origin', 'HEAD:refs/heads/menu-delete-remote')
    menu.git('fetch', 'origin')
    await menu.refresh()
    const remoteRef = (branch: string) => menu.gitAt(menu.remote, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`).trim()
    expect(remoteRef('menu-delete-remote')).toBe(original)
    await menu.action('分支', '删除远程分支…')
    await menu.pick('origin/menu-delete-remote')
    await menu.confirm('删除')
    await expect.poll(() => remoteRef('menu-delete-remote'), changed).toBe('')
    await menu.idle()
    expect(remoteRef('main')).toBe(original)
    expect(head(menu)).toBe(original)
  })

  test('发布分支到 origin：无 upstream 的分支推送并建立跟踪关系', async ({ menu }) => {
    menu.git('switch', '-c', 'menu-publish', '--no-track')
    const published = menu.commit('publish.txt', 'published payload\n', 'menu publish commit').trim()
    await menu.refresh()
    expect(menu.git('for-each-ref', '--format=%(upstream:short)', 'refs/heads/menu-publish').trim()).toBe('')
    await menu.action('分支', '发布分支到 origin')
    await expect.poll(() => menu.gitAt(menu.remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/menu-publish').trim(), changed).toBe(published)
    await menu.idle()
    expect(menu.git('rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/menu-publish')
    expect(menu.gitAt(menu.remote, 'show', 'menu-publish:publish.txt')).toBe('published payload')
    expect(head(menu)).toBe(published)
    expect(menu.git('status', '--porcelain=v1')).toBe('')
  })
})

test.describe('Work Git 更多菜单：提交三项', () => {
  test('修补上次提交：保留父链和信息并纳入暂存内容', async ({ menu }) => {
    const base = head(menu)
    const previous = menu.commit('original.txt', 'original payload\n', 'menu amend subject').trim()
    menu.write('amended.txt', 'amended payload\n')
    menu.git('add', '--', 'amended.txt')
    await menu.refresh()
    await menu.action('提交', '修补上次提交（amend）')
    await expect.poll(() => head(menu), changed).not.toBe(previous)
    await menu.idle()
    expect(parents(menu)).toEqual([base])
    expect(menu.git('show', '-s', '--format=%s', 'HEAD').trim()).toBe('menu amend subject')
    expect(menu.git('show', 'HEAD:original.txt')).toBe('original payload')
    expect(menu.git('show', 'HEAD:amended.txt')).toBe('amended payload')
    expect(menu.git('diff', '--cached', '--name-only')).toBe('')
    expect(menu.git('status', '--porcelain=v1')).toBe('')
  })

  test('撤销上次提交：HEAD 回退但提交内容保留在暂存区', async ({ menu }) => {
    const base = head(menu)
    menu.commit('undo.txt', 'retained staged payload\n', 'menu undo commit')
    await menu.refresh()
    await menu.action('提交', '撤销上次提交')
    await expect.poll(() => head(menu), changed).toBe(base)
    await menu.idle()
    expect(menu.git('diff', '--cached', '--name-status').trim()).toBe('A\tundo.txt')
    expect(menu.git('show', ':undo.txt')).toBe('retained staged payload')
    expect(contents(menu, 'undo.txt')).toBe('retained staged payload\n')
    expect(menu.git('diff', '--name-only')).toBe('')
    expect(menu.git('ls-tree', '--name-only', 'HEAD', '--', 'undo.txt')).toBe('')
  })

  test('空提交：新建带信息的提交且保持树完全一致', async ({ menu }) => {
    const previous = head(menu)
    const originalTree = menu.git('rev-parse', 'HEAD^{tree}').trim()
    expect(menu.git('status', '--porcelain=v1')).toBe('')
    await menu.action('提交', '空提交')
    await menu.prompt('menu empty commit')
    await expect.poll(() => head(menu), changed).not.toBe(previous)
    await menu.idle()
    expect(parents(menu)).toEqual([previous])
    expect(menu.git('rev-parse', 'HEAD^{tree}').trim()).toBe(originalTree)
    expect(menu.git('show', '-s', '--format=%s', 'HEAD').trim()).toBe('menu empty commit')
    expect(menu.git('status', '--porcelain=v1')).toBe('')
  })
})
