/** Real Work Git menu acceptance: every storage/tag entry uses its UI flow,
 * then verifies disposable worktree contents, stash objects or local bare refs. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type GitMenuHarness } from './helpers/work-git-menu'

function content(menu: GitMenuHarness, file: string): string {
  return readFileSync(join(menu.repo, file), 'utf8')
}

function stashes(menu: GitMenuHarness): string[] {
  return menu.git('stash', 'list', '--format=%H').split(/\r?\n/).filter(Boolean)
}

function tagRefs(menu: GitMenuHarness, cwd = menu.repo): string[] {
  return menu.gitAt(cwd, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/tags')
    .split(/\r?\n/).filter(Boolean).sort()
}

/** Distinct files make choosing the older stash observable on disk. */
async function seedTwoStashes(menu: GitMenuHarness): Promise<{ older: string; newest: string }> {
  menu.write('tracked.txt', 'older stored change\n')
  menu.git('stash', 'push', '-m', 'older checkpoint')
  const older = stashes(menu)[0]
  menu.write('other.txt', 'newest stored change\n')
  menu.git('stash', 'push', '-m', 'newest checkpoint')
  const newest = stashes(menu)[0]
  await menu.refresh()
  await expect(menu.panel.locator('.git-panel__group-head').filter({ hasText: '存储' }))
    .toContainText('2')
  return { older, newest }
}

test('存储 · 存储当前更改…保存跟踪文件并保留未跟踪文件', async ({ menu }) => {
  menu.write('tracked.txt', 'tracked storage payload\n')
  menu.write('keep-untracked.txt', 'untracked stays in worktree\n')
  await menu.refresh()
  await menu.action('存储', '存储当前更改…')
  await menu.prompt('tracked only checkpoint')
  await expect.poll(() => menu.git('stash', 'list', '--format=%s')).toContain('tracked only checkpoint')
  await menu.idle()
  expect(content(menu, 'tracked.txt')).toBe('baseline\n')
  expect(content(menu, 'keep-untracked.txt')).toBe('untracked stays in worktree\n')
  expect(menu.git('show', 'stash@{0}:tracked.txt')).toBe('tracked storage payload')
  expect(menu.git('stash', 'show', '--name-only', 'stash@{0}')).toBe('tracked.txt')
})

test('存储 · 存储当前更改（含未跟踪文件）…把新文件写入stash第三父节点', async ({ menu }) => {
  menu.write('tracked.txt', 'tracked with untracked\n')
  menu.write('new-folder/new.txt', 'new file storage payload\n')
  await menu.refresh()
  await menu.action('存储', '存储当前更改（含未跟踪文件）…')
  await menu.prompt('include untracked checkpoint')
  await expect.poll(() => menu.git('stash', 'list', '--format=%s')).toContain('include untracked checkpoint')
  await menu.idle()
  expect(content(menu, 'tracked.txt')).toBe('baseline\n')
  expect(existsSync(join(menu.repo, 'new-folder/new.txt'))).toBe(false)
  expect(menu.git('show', 'stash@{0}:tracked.txt')).toBe('tracked with untracked')
  expect(menu.git('show', 'stash@{0}^3:new-folder/new.txt')).toBe('new file storage payload')
})

test('存储 · 只存储已暂存的更改…保留未暂存文件内容', async ({ menu }) => {
  menu.write('tracked.txt', 'staged storage payload\n')
  menu.git('add', '--', 'tracked.txt')
  menu.write('other.txt', 'unstaged content survives\n')
  await menu.refresh()
  await menu.action('存储', '只存储已暂存的更改…')
  await menu.prompt('staged checkpoint')
  await expect.poll(() => menu.git('stash', 'list', '--format=%s')).toContain('staged checkpoint')
  await menu.idle()
  expect(content(menu, 'tracked.txt')).toBe('baseline\n')
  expect(content(menu, 'other.txt')).toBe('unstaged content survives\n')
  expect(menu.git('diff', '--cached', '--name-only')).toBe('')
  expect(menu.git('stash', 'show', '--name-only', 'stash@{0}')).toBe('tracked.txt')
  expect(menu.git('show', 'stash@{0}:tracked.txt')).toBe('staged storage payload')
})

test('存储 · 恢复最新一次存储的改动恢复最新内容并保留两条记录', async ({ menu }) => {
  const { older, newest } = await seedTwoStashes(menu)
  await menu.action('存储', '恢复最新一次存储的改动')
  await expect.poll(() => content(menu, 'other.txt')).toBe('newest stored change\n')
  await menu.idle()
  expect(content(menu, 'tracked.txt')).toBe('baseline\n')
  expect(stashes(menu)).toEqual([newest, older])
})

test('存储 · 恢复某次存储的改动…选择旧记录并保留它', async ({ menu }) => {
  const { older, newest } = await seedTwoStashes(menu)
  await menu.action('存储', '恢复某次存储的改动…')
  await menu.pick(/存储 1\s+older checkpoint/)
  await expect.poll(() => content(menu, 'tracked.txt')).toBe('older stored change\n')
  await menu.idle()
  expect(content(menu, 'other.txt')).toBe('second\n')
  expect(stashes(menu)).toEqual([newest, older])
})

test('存储 · 恢复最新一次并删除该存储仅移除最新记录', async ({ menu }) => {
  const { older } = await seedTwoStashes(menu)
  await menu.action('存储', '恢复最新一次并删除该存储')
  await expect.poll(() => stashes(menu)).toEqual([older])
  await menu.idle()
  expect(content(menu, 'other.txt')).toBe('newest stored change\n')
  expect(content(menu, 'tracked.txt')).toBe('baseline\n')
})

test('存储 · 恢复某次并删除…恢复旧记录且不删除最新记录', async ({ menu }) => {
  const { newest } = await seedTwoStashes(menu)
  await menu.action('存储', '恢复某次并删除…')
  await menu.pick(/存储 1\s+older checkpoint/)
  await expect.poll(() => stashes(menu)).toEqual([newest])
  await menu.idle()
  expect(content(menu, 'tracked.txt')).toBe('older stored change\n')
  expect(content(menu, 'other.txt')).toBe('second\n')
})

test('存储 · 删除某次存储…只删除所选记录且不应用其文件', async ({ menu }) => {
  const { newest } = await seedTwoStashes(menu)
  await menu.action('存储', '删除某次存储…')
  await menu.pick(/存储 1\s+older checkpoint/)
  await menu.confirm('删除')
  await expect.poll(() => stashes(menu)).toEqual([newest])
  await menu.idle()
  expect(content(menu, 'tracked.txt')).toBe('baseline\n')
  expect(content(menu, 'other.txt')).toBe('second\n')
})

test('存储 · 查看存储详情…显示所选记录的真实hash和文件且不修改仓库', async ({ menu }) => {
  const { older, newest } = await seedTwoStashes(menu)
  await menu.action('存储', '查看存储详情…')
  await menu.pick(/存储 1\s+older checkpoint/)
  const detail = menu.page.getByRole('dialog', { name: '存储 1 详情', exact: true })
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('older checkpoint')
  await expect(detail.locator('.git-panel__stash-hash')).toHaveText(older)
  await expect(detail.locator('.git-panel__stash-detail-file')).toHaveText(['tracked.txt'])
  expect(stashes(menu)).toEqual([newest, older])
  expect(content(menu, 'tracked.txt')).toBe('baseline\n')
  expect(content(menu, 'other.txt')).toBe('second\n')
  await detail.locator('.modal__footer').getByRole('button', { name: '关闭', exact: true }).click()
})

test('存储 · 清空全部存储删除所有记录且不恢复工作区内容', async ({ menu }) => {
  await seedTwoStashes(menu)
  await menu.action('存储', '清空全部存储')
  await menu.confirm('清空')
  await expect.poll(() => stashes(menu)).toEqual([])
  await menu.idle()
  expect(menu.git('for-each-ref', '--format=%(refname)', 'refs/stash')).toBe('')
  expect(content(menu, 'tracked.txt')).toBe('baseline\n')
  expect(content(menu, 'other.txt')).toBe('second\n')
})

test('标记 · 创建标签…创建指向当前HEAD且保存说明的附注标签', async ({ menu }) => {
  const head = menu.git('rev-parse', 'HEAD')
  await menu.action('标记', '创建标签…')
  await menu.prompt('menu-v1.0.0')
  await menu.prompt('release created from tag menu')
  await expect.poll(() => menu.git('tag', '--list', 'menu-v1.0.0')).toBe('menu-v1.0.0')
  await menu.idle()
  expect(menu.git('cat-file', '-t', 'refs/tags/menu-v1.0.0')).toBe('tag')
  expect(menu.git('rev-parse', 'refs/tags/menu-v1.0.0^{}')).toBe(head)
  expect(menu.git('for-each-ref', '--format=%(contents)', 'refs/tags/menu-v1.0.0')).toBe('release created from tag menu')
  expect(menu.git('rev-parse', 'HEAD')).toBe(head)
})

test('标记 · 删除标签…仅删除所选本地标签并保留远程标签', async ({ menu }) => {
  menu.git('tag', 'delete-local')
  menu.git('tag', 'keep-local')
  menu.git('push', 'origin', '--tags')
  const remoteBefore = tagRefs(menu, menu.remote)
  await menu.refresh()
  await menu.action('标记', '删除标签…')
  await menu.pick('delete-local')
  await menu.confirm('删除')
  await expect.poll(() => menu.git('tag', '--list')).toBe('keep-local')
  await menu.idle()
  expect(tagRefs(menu, menu.remote)).toEqual(remoteBefore)
})

test('标记 · 推送标签…只推送所选标签到origin', async ({ menu }) => {
  menu.git('tag', 'push-selected')
  menu.git('tag', 'keep-unpushed')
  const selected = menu.git('rev-parse', 'refs/tags/push-selected')
  await menu.refresh()
  await menu.action('标记', '推送标签…')
  await menu.pick('push-selected')
  await expect.poll(() => tagRefs(menu, menu.remote)).toEqual([`refs/tags/push-selected:${selected}`])
  await menu.idle()
  expect(menu.git('tag', '--list').split(/\r?\n/)).toEqual(['keep-unpushed', 'push-selected'])
})

test('标记 · 推送所有标签从标记分组推送所有本地标签', async ({ menu }) => {
  menu.git('tag', 'all-lightweight')
  menu.git('tag', '-a', 'all-annotated', '-m', 'annotated tag payload')
  const local = tagRefs(menu)
  expect(local).toHaveLength(2)
  expect(tagRefs(menu, menu.remote)).toEqual([])
  await menu.refresh()
  await menu.action('标记', '推送所有标签')
  await expect.poll(() => tagRefs(menu, menu.remote)).toEqual(local)
  await menu.idle()
  expect(tagRefs(menu)).toEqual(local)
})

test('标记 · 删除远程标签…删除origin所选标签并保留本地和其他远程标签', async ({ menu }) => {
  menu.git('tag', 'delete-remote')
  menu.git('tag', 'keep-remote')
  menu.git('push', 'origin', '--tags')
  const local = tagRefs(menu)
  const kept = menu.git('rev-parse', 'refs/tags/keep-remote')
  await menu.refresh()
  await menu.action('标记', '删除远程标签…')
  await menu.pick('delete-remote')
  await menu.confirm('删除')
  await expect.poll(() => tagRefs(menu, menu.remote)).toEqual([`refs/tags/keep-remote:${kept}`])
  await menu.idle()
  expect(tagRefs(menu)).toEqual(local)
})
