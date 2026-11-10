import type { GitLogEntry, GitRemote, GitRemoteBranchInfo, GitStashEntry } from '@shared/git-types'
import type { GitPickItem } from './GitPickDialog'

export interface GitPickOption extends Omit<GitPickItem, 'id'> { value: string }

export function gitRelativeTime(iso?: string, now = Date.now()): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  const elapsed = Math.max(0, now - time)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Names remain authoritative: older engines can return only some metadata. */
export function branchPickOptions(names: string[], infos: GitRemoteBranchInfo[], exclude?: string): GitPickOption[] {
  const byName = new Map(infos.map(info => [info.name, info]))
  const timestamp = (name: string): number => Date.parse(byName.get(name)?.date ?? '') || 0
  return [...new Set(names)].filter(name => name !== exclude)
    .sort((a, b) => timestamp(b) - timestamp(a))
    .map(name => {
      const info = byName.get(name)
      return {
        value: name,
        icon: 'source-branch',
        hint: info ? [info.hash, gitRelativeTime(info.date)].filter(Boolean).join(' · ') : undefined,
        description: info ? [info.subject, info.author && `@${info.author}`].filter(Boolean).join('  ') : undefined
      }
    })
}

export function remotePickOptions(remotes: GitRemote[]): GitPickOption[] {
  return remotes.map(remote => ({ value: remote.name, description: remote.url, icon: 'cloud-upload-outline' }))
}

export function remoteBranchPickOptions(names: string[], infos: GitRemoteBranchInfo[]): GitPickOption[] {
  // Git may shorten a remote's symbolic HEAD to just "origin". It is not a
  // remote/branch target and must not appear as an option that does nothing.
  return branchPickOptions(names.filter(name => {
    const slash = name.indexOf('/')
    return slash > 0 && slash < name.length - 1 && !name.endsWith('/HEAD')
  }), infos)
}

export function commitPickOptions(commits: GitLogEntry[]): GitPickOption[] {
  return commits.map(commit => ({ value: commit.hash, label: commit.subject || commit.shortHash,
    hint: commit.shortHash, description: [commit.author && `@${commit.author}`, gitRelativeTime(commit.date)].filter(Boolean).join(' · '),
    icon: 'circle-dot' }))
}

export function stashPickOptions(stashes: GitStashEntry[]): GitPickOption[] {
  return stashes.map(stash => {
    const match = /^(?:On|WIP on) ([^:]+):\s*/.exec(stash.message)
    const message = (match ? stash.message.slice(match[0].length) : stash.message).trim()
    return { value: String(stash.index), label: `存储 ${stash.index}${match ? ` · ${match[1]}` : ''}`,
      hint: [stash.hash.slice(0, 7), gitRelativeTime(stash.date)].filter(Boolean).join(' · '),
      description: message || '（无说明）', icon: 'package-variant-closed' }
  })
}

export function tagPickOptions(tags: string[]): GitPickOption[] {
  return tags.map(value => ({ value, icon: 'tag-outline' }))
}
