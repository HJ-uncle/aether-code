/**
 * Work Git 完整菜单：逐项点击 10 个拉取/推送入口与 2 个远程入口。
 * 每条用例独立仓库；origin、backup 和 peer 均位于 .e2e-tmp，绝不访问用户远程。
 * CLI 仅准备前置状态与读取结果，被验收的操作必须从真实 UI 发起。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, type GitMenuHarness } from './helpers/work-git-menu'

const syncGroup = '拉取，推送'

function ref(menu: GitMenuHarness, repository: string, name: string): string {
  return menu.gitAt(repository, 'rev-parse', '--verify', name).trim()
}

function optionalRef(menu: GitMenuHarness, repository: string, name: string): string {
  const records = menu.gitAt(repository, 'for-each-ref', '--format=%(refname)%09%(objectname)', name)
  const record = records.split(/\r?\n/).find(line => line.startsWith(`${name}\t`))
  return record?.slice(name.length + 1) ?? ''
}

function peerCommit(menu: GitMenuHarness, file: string, content: string, message: string): string {
  menu.gitAt(menu.peer, 'config', 'user.name', 'Git Menu Peer')
  menu.gitAt(menu.peer, 'config', 'user.email', 'git-menu-peer@example.invalid')
  writeFileSync(join(menu.peer, file), content, 'utf8')
  menu.gitAt(menu.peer, 'add', '--', file)
  menu.gitAt(menu.peer, 'commit', '-m', message)
  return ref(menu, menu.peer, 'HEAD')
}

function addBackup(menu: GitMenuHarness): string {
  const backup = join(menu.root, 'backup.git')
  menu.gitAt(menu.root, 'init', '--bare', '--initial-branch=main', backup)
  menu.git('remote', 'add', 'backup', backup)
  return backup
}

async function expectRemotePickerFits(picker: Locator, remotes: Array<{ name: string; url: string }>): Promise<void> {
  await expect(picker).toBeVisible()
  const list = picker.locator('.git-pickdlg__list')
  await expect(list).toBeVisible()
  for (const remote of remotes) {
    const label = picker.locator('.git-pickdlg__item-label').filter({ hasText: remote.name })
    await expect(label).toHaveText(remote.name)
    await expect(label).toBeVisible()
    await expect.poll(() => label.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      const list = element.closest('.git-pickdlg__list')!.getBoundingClientRect()
      return bounds.width > 0 && element.scrollWidth <= element.clientWidth + 1
        && bounds.left >= list.left - 1 && bounds.right <= list.right + 1
    })).toBe(true)
    const hint = label.locator('..').locator('.git-pickdlg__item-hint, .git-pickdlg__item-desc')
    await expect(hint).toHaveText(remote.url)
    await expect(hint).toHaveAttribute('title', remote.url)
  }
  await expect.poll(() => list.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await expect.poll(() => picker.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
}

test('拉取，推送 / 同步：合并双方提交并将完整历史推回 origin', async ({ menu }) => {
  const localHead = menu.commit('local-sync.txt', 'local sync\n', 'local sync change')
  const peerHead = peerCommit(menu, 'peer-sync.txt', 'peer sync\n', 'peer sync change')
  menu.gitAt(menu.peer, 'push', 'origin', 'main')
  // A divergent pull needs a repository policy; this case verifies the sync
  // operation itself, including both the pull and the subsequent push.
  menu.git('config', 'pull.rebase', 'false')
  await menu.refresh()

  await menu.action(syncGroup, '同步')

  await expect
    .poll(() => {
      const head = ref(menu, menu.repo, 'HEAD')
      return head !== localHead && ref(menu, menu.remote, 'refs/heads/main') === head
    })
    .toBe(true)
  const mergedHead = ref(menu, menu.repo, 'HEAD')
  expect(menu.git('show', '-s', '--format=%P', mergedHead).trim().split(' ')).toEqual([
    localHead,
    peerHead
  ])
  expect(readFileSync(join(menu.repo, 'peer-sync.txt'), 'utf8')).toBe('peer sync\n')
  expect(menu.gitAt(menu.remote, 'show', 'refs/heads/main:local-sync.txt').trim()).toBe('local sync')
  expect(menu.gitAt(menu.remote, 'show', 'refs/heads/main:peer-sync.txt').trim()).toBe('peer sync')
  expect(menu.git('status', '--porcelain')).toBe('')
  await menu.idle()
})

test('拉取，推送 / 拉取：将 origin 的提交和文件更新到当前分支', async ({ menu }) => {
  const peerHead = peerCommit(menu, 'tracked.txt', 'pulled from origin\n', 'incoming pull change')
  menu.gitAt(menu.peer, 'push', 'origin', 'main')
  expect(ref(menu, menu.repo, 'HEAD')).not.toBe(peerHead)
  await menu.refresh()

  await menu.action(syncGroup, '拉取')

  await expect.poll(() => ref(menu, menu.repo, 'HEAD')).toBe(peerHead)
  expect(readFileSync(join(menu.repo, 'tracked.txt'), 'utf8')).toBe('pulled from origin\n')
  expect(ref(menu, menu.remote, 'refs/heads/main')).toBe(peerHead)
  expect(menu.git('status', '--porcelain')).toBe('')
  await menu.idle()
})

test('拉取，推送 / 拉取（变基）：将本地提交重放到真实远端新提交之后', async ({ menu }) => {
  const localHead = menu.commit('local-rebase.txt', 'keep local change\n', 'local rebase change')
  const peerHead = peerCommit(menu, 'other.txt', 'remote rebase base\n', 'remote rebase change')
  menu.gitAt(menu.peer, 'push', 'origin', 'main')
  await menu.refresh()

  await menu.action(syncGroup, '拉取（变基）')

  await expect.poll(() => ref(menu, menu.repo, 'HEAD^')).toBe(peerHead)
  expect(ref(menu, menu.repo, 'HEAD')).not.toBe(localHead)
  expect(menu.git('show', '-s', '--format=%s', 'HEAD').trim()).toBe('local rebase change')
  expect(menu.git('rev-list', '--merges', `${peerHead}..HEAD`).trim()).toBe('')
  expect(readFileSync(join(menu.repo, 'local-rebase.txt'), 'utf8')).toBe('keep local change\n')
  expect(readFileSync(join(menu.repo, 'other.txt'), 'utf8')).toBe('remote rebase base\n')
  expect(ref(menu, menu.remote, 'refs/heads/main')).toBe(peerHead)
  expect(menu.git('status', '--porcelain')).toBe('')
  await menu.idle()
})

test('拉取，推送 / 拉取自…：从选定的 backup 分支拉取且保留现有上游', async ({ menu }) => {
  const base = ref(menu, menu.repo, 'HEAD')
  const backup = addBackup(menu)
  menu.gitAt(menu.peer, 'remote', 'add', 'backup', backup)
  menu.gitAt(menu.peer, 'checkout', '-b', 'release/incoming')
  const selectedHead = peerCommit(
    menu,
    'selected-source.txt',
    'selected remote branch\n',
    'selected source change'
  )
  menu.gitAt(menu.peer, 'push', 'backup', 'release/incoming')
  menu.git('fetch', 'backup')
  await menu.refresh()

  await menu.action(syncGroup, '拉取自…')
  await menu.pick('backup/release/incoming')

  await expect.poll(() => ref(menu, menu.repo, 'HEAD')).toBe(selectedHead)
  expect(readFileSync(join(menu.repo, 'selected-source.txt'), 'utf8')).toBe(
    'selected remote branch\n'
  )
  expect(menu.git('branch', '--show-current').trim()).toBe('main')
  expect(menu.git('rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/main')
  expect(ref(menu, menu.remote, 'refs/heads/main')).toBe(base)
  expect(ref(menu, backup, 'refs/heads/release/incoming')).toBe(selectedHead)
  await menu.idle()
})

test('拉取，推送 / 推送：将当前分支提交写入 origin/main', async ({ menu }) => {
  const head = menu.commit('pushed.txt', 'pushed from Work menu\n', 'push current branch')
  expect(ref(menu, menu.remote, 'refs/heads/main')).not.toBe(head)
  await menu.refresh()

  await menu.action(syncGroup, '推送')

  await expect.poll(() => ref(menu, menu.remote, 'refs/heads/main')).toBe(head)
  expect(menu.gitAt(menu.remote, 'show', 'refs/heads/main:pushed.txt').trim()).toBe(
    'pushed from Work menu'
  )
  expect(menu.git('rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/main')
  await menu.idle()
})

test('拉取，推送 / 推送到…：只更新选择的 backup 远程', async ({ menu }) => {
  const base = ref(menu, menu.remote, 'refs/heads/main')
  const backup = addBackup(menu)
  const head = menu.commit('selected-push.txt', 'backup only\n', 'push selected remote')
  expect(optionalRef(menu, backup, 'refs/heads/main')).toBe('')
  await menu.refresh()

  await menu.action(syncGroup, '推送到…')
  await expectRemotePickerFits(menu.page.getByRole('dialog', { name: '推送到…', exact: true }), [
    { name: 'origin', url: menu.remote }, { name: 'backup', url: backup }
  ])
  await menu.pick('backup')

  await expect.poll(() => optionalRef(menu, backup, 'refs/heads/main')).toBe(head)
  expect(menu.gitAt(backup, 'show', 'refs/heads/main:selected-push.txt').trim()).toBe('backup only')
  expect(ref(menu, menu.remote, 'refs/heads/main')).toBe(base)
  expect(menu.git('rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/main')
  await menu.idle()
})

test('拉取，推送 / 推送到其他分支…：只改选定远端引用，不切换本地分支', async ({ menu }) => {
  const base = ref(menu, menu.remote, 'refs/heads/main')
  menu.gitAt(menu.remote, 'update-ref', 'refs/heads/review/target', base)
  menu.git('fetch', 'origin')
  const head = menu.commit('review.txt', 'review branch payload\n', 'push review branch')
  await menu.refresh()

  await menu.action(syncGroup, '推送到其他分支…')
  await menu.pick('origin/review/target')
  await menu.confirm('推送')

  await expect.poll(() => ref(menu, menu.remote, 'refs/heads/review/target')).toBe(head)
  expect(menu.gitAt(menu.remote, 'show', 'refs/heads/review/target:review.txt').trim()).toBe(
    'review branch payload'
  )
  expect(ref(menu, menu.remote, 'refs/heads/main')).toBe(base)
  expect(menu.git('branch', '--show-current').trim()).toBe('main')
  expect(menu.git('rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/main')
  await menu.idle()
})

test('拉取，推送 / 推送到多个远程…：所选 origin 和 backup 均收到当前分支', async ({ menu }) => {
  const backup = addBackup(menu)
  const untouched = join(menu.root, 'untouched.git')
  menu.gitAt(menu.root, 'init', '--bare', '--initial-branch=main', untouched)
  menu.git('remote', 'add', 'untouched', untouched)
  const sentinel = ref(menu, menu.repo, 'HEAD')
  menu.git('push', 'untouched', 'HEAD:refs/tags/untouched-sentinel')
  expect(optionalRef(menu, untouched, 'refs/heads/main')).toBe('')
  const head = menu.commit('multi-push.txt', 'both remote destinations\n', 'push multiple remotes')
  await menu.refresh()

  await menu.action(syncGroup, '推送到多个远程…')
  const picker = menu.page.getByRole('dialog', { name: '推送到多个远程…', exact: true })
  await expectRemotePickerFits(picker, [
    { name: 'origin', url: menu.remote }, { name: 'backup', url: backup }, { name: 'untouched', url: untouched }
  ])
  await expect(picker.getByRole('button', { name: '确定（0）', exact: true })).toBeDisabled()
  await picker.getByRole('checkbox', { name: 'origin', exact: true }).check()
  await picker.getByRole('checkbox', { name: 'backup', exact: true }).check()
  await expect(picker.getByRole('checkbox', { name: 'untouched', exact: true })).not.toBeChecked()
  await expect(picker.getByRole('status')).toHaveText('已选 2 / 3')
  await picker.getByRole('button', { name: '确定（2）', exact: true }).click()

  const result = menu.page.getByRole('dialog', { name: '多远程推送完成', exact: true })
  await expect(result).toContainText('origin')
  await expect(result).toContainText('backup')
  await expect(result).not.toContainText('untouched')
  await expect.poll(() => ref(menu, menu.remote, 'refs/heads/main')).toBe(head)
  await expect.poll(() => optionalRef(menu, backup, 'refs/heads/main')).toBe(head)
  expect(menu.gitAt(backup, 'show', 'refs/heads/main:multi-push.txt').trim()).toBe(
    'both remote destinations'
  )
  expect(menu.gitAt(menu.remote, 'show', 'refs/heads/main:multi-push.txt').trim()).toBe(
    'both remote destinations'
  )
  expect(optionalRef(menu, untouched, 'refs/heads/main')).toBe('')
  expect(ref(menu, untouched, 'refs/tags/untouched-sentinel')).toBe(sentinel)
  expect(menu.gitAt(untouched, 'for-each-ref', '--format=%(refname)').trim()).toBe(
    'refs/tags/untouched-sentinel'
  )
})

test('拉取，推送 / 强制推送：已知远端状态允许 force-with-lease 更新重写历史', async ({ menu }) => {
  const published = menu.commit('rewrite.txt', 'published version\n', 'published original')
  menu.git('push', 'origin', 'main')
  menu.write('rewrite.txt', 'rewritten version\n')
  menu.git('add', '--', 'rewrite.txt')
  menu.git('commit', '--amend', '-m', 'rewritten local commit')
  const rewritten = ref(menu, menu.repo, 'HEAD')
  expect(rewritten).not.toBe(published)
  expect(ref(menu, menu.repo, 'refs/remotes/origin/main')).toBe(published)
  await menu.refresh()

  await menu.action(syncGroup, '强制推送（force-with-lease）')
  await menu.confirm('强制推送')

  await expect.poll(() => ref(menu, menu.remote, 'refs/heads/main')).toBe(rewritten)
  expect(menu.gitAt(menu.remote, 'show', 'refs/heads/main:rewrite.txt').trim()).toBe('rewritten version')
  expect(menu.gitAt(menu.remote, 'log', '--format=%H', 'main').trim().split(/\r?\n/)).not.toContain(
    published
  )
  await menu.idle()
})

test('拉取，推送 / 强制推送保护：远端被 peer 更新后拒绝覆盖未知提交', async ({ menu }) => {
  const published = menu.commit('rewrite.txt', 'published version\n', 'published before peer')
  menu.git('push', 'origin', 'main')
  menu.gitAt(menu.peer, 'pull', '--ff-only', 'origin', 'main')
  const peerHead = peerCommit(
    menu,
    'peer-protected.txt',
    'do not overwrite peer\n',
    'protected peer commit'
  )
  menu.gitAt(menu.peer, 'push', 'origin', 'main')
  menu.write('rewrite.txt', 'local rewritten version\n')
  menu.git('add', '--', 'rewrite.txt')
  menu.git('commit', '--amend', '-m', 'local rewrite after peer')
  const rewritten = ref(menu, menu.repo, 'HEAD')
  // The harness disables background fetch so the remote-tracking ref stays
  // stale: force-with-lease must reject the peer's previously unseen commit.
  expect(ref(menu, menu.repo, 'refs/remotes/origin/main')).toBe(published)
  await menu.refresh()
  expect(ref(menu, menu.repo, 'refs/remotes/origin/main')).toBe(published)

  await menu.action(syncGroup, '强制推送（force-with-lease）')
  await menu.confirm('强制推送')

  await expect(menu.panel.locator('[role="alert"]')).toContainText(
    /stale info|rejected|fetch first/i
  )
  await menu.idle()
  expect(ref(menu, menu.remote, 'refs/heads/main')).toBe(peerHead)
  expect(menu.gitAt(menu.remote, 'show', 'refs/heads/main:peer-protected.txt').trim()).toBe(
    'do not overwrite peer'
  )
  expect(ref(menu, menu.repo, 'HEAD')).toBe(rewritten)
  expect(ref(menu, menu.repo, 'refs/remotes/origin/main')).toBe(published)
})

test('拉取，推送 / 推送所有标签：轻量和附注标签均落到 origin，分支不随之推送', async ({ menu }) => {
  const base = ref(menu, menu.remote, 'refs/heads/main')
  menu.git('tag', 'menu-lightweight')
  const localHead = menu.commit('tagged.txt', 'annotated tag payload\n', 'tagged local commit')
  menu.git('tag', '-a', 'menu-annotated', '-m', 'Work menu annotation')
  const annotatedObject = ref(menu, menu.repo, 'refs/tags/menu-annotated')
  await menu.refresh()

  await menu.action(syncGroup, '推送所有标签')

  await expect.poll(() => optionalRef(menu, menu.remote, 'refs/tags/menu-lightweight')).toBe(base)
  await expect
    .poll(() => optionalRef(menu, menu.remote, 'refs/tags/menu-annotated'))
    .toBe(annotatedObject)
  expect(menu.gitAt(menu.remote, 'cat-file', '-t', 'refs/tags/menu-lightweight').trim()).toBe(
    'commit'
  )
  expect(menu.gitAt(menu.remote, 'cat-file', '-t', 'refs/tags/menu-annotated').trim()).toBe('tag')
  expect(ref(menu, menu.remote, 'refs/tags/menu-annotated^{}')).toBe(localHead)
  expect(ref(menu, menu.remote, 'refs/heads/main')).toBe(base)
  await menu.idle()
})

test('远程 / 添加远程仓库…：两次输入后保存指定名称、URL 与 fetch refspec', async ({ menu }) => {
  const backup = join(menu.root, 'added-backup.git')
  menu.gitAt(menu.root, 'init', '--bare', '--initial-branch=main', backup)
  const originUrl = menu.git('remote', 'get-url', 'origin').trim()
  expect(menu.git('remote').trim().split(/\r?\n/)).not.toContain('backup')

  await menu.action('远程', '添加远程仓库…')
  await menu.prompt('backup')
  await expect(menu.page.getByRole('dialog')).toContainText('仓库 URL')
  await menu.prompt(backup)

  await expect.poll(() => menu.git('remote').trim().split(/\r?\n/)).toContain('backup')
  expect(menu.git('remote', 'get-url', 'backup').trim()).toBe(backup)
  expect(menu.git('config', '--get', 'remote.backup.fetch').trim()).toBe(
    '+refs/heads/*:refs/remotes/backup/*'
  )
  expect(menu.git('remote', 'get-url', 'origin').trim()).toBe(originUrl)
  expect(existsSync(join(backup, 'HEAD'))).toBe(true)
  await menu.idle()
})

test('远程 / 删除远程仓库…：移除选定配置与跟踪引用，保留远端仓库及 origin', async ({ menu }) => {
  const backup = addBackup(menu)
  const head = ref(menu, menu.repo, 'HEAD')
  menu.git('push', 'backup', 'main')
  menu.git('fetch', 'backup')
  const originUrl = menu.git('remote', 'get-url', 'origin').trim()
  expect(ref(menu, menu.repo, 'refs/remotes/backup/main')).toBe(head)
  await menu.refresh()

  await menu.action('远程', '删除远程仓库…')
  await menu.pick('backup')
  await menu.confirm('删除')

  await expect.poll(() => menu.git('remote').trim().split(/\r?\n/)).not.toContain('backup')
  expect(menu.git('for-each-ref', '--format=%(refname)', 'refs/remotes/backup').trim()).toBe('')
  expect(menu.git('remote', 'get-url', 'origin').trim()).toBe(originUrl)
  expect(ref(menu, menu.remote, 'refs/heads/main')).toBe(head)
  expect(ref(menu, backup, 'refs/heads/main')).toBe(head)
  expect(existsSync(join(backup, 'HEAD'))).toBe(true)
  await menu.idle()
})
