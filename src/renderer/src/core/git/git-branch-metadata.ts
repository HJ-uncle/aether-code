import type { GitBranchListResult, GitLogEntry, GitLogResult, GitRemoteBranchInfo } from '@shared/git-types'

type BranchNamespace = 'heads' | 'remotes'
type ReadLog = (refs: string, limit: number) => Promise<GitLogResult>

function complete(info: GitRemoteBranchInfo): boolean {
  return Boolean(info.hash?.trim()) && Number.isFinite(Date.parse(info.date)) &&
    typeof info.subject === 'string' && typeof info.author === 'string'
}

function fromCommit(name: string, commit: GitLogEntry): GitRemoteBranchInfo {
  return { name, hash: commit.shortHash.trim(), subject: commit.subject, author: commit.author, date: commit.date }
}

/** Older engines omit branch metadata. Keep their authoritative branch list and
 * enrich only missing entries; a bounded history page avoids one request per
 * branch, while exact reads still cover tips outside that page. */
export async function withBranchMetadata<T extends GitBranchListResult>(
  result: T,
  namespace: BranchNamespace,
  readLog: ReadLog,
  readOtherBranches: () => Promise<GitBranchListResult>
): Promise<T & GitBranchListResult> {
  if (!result.success || !result.branches?.length) return result
  const names = new Set(result.branches)
  const infos = new Map((result.infos ?? []).filter(info => names.has(info.name) && complete(info)).map(info => [info.name, info]))
  const missing = [...names].filter(name => !infos.has(name))
  if (!missing.length) return result

  // Short log decorations can collide across local and remote namespaces. The
  // other tip may be outside the history page, so inspecting that page alone
  // cannot prove a short name is unambiguous.
  const ambiguous = new Set<string>()
  const legacyAlias = (name: string): boolean => result.infos === undefined && /^(?:refs\/)?(?:heads|remotes)\//.test(name)
  for (const name of missing) if (legacyAlias(name)) ambiguous.add(name)
  if (missing.some(name => name.includes('/'))) {
    const other = await readOtherBranches()
    if (!other.success) return { ...result, ...other, success: false, branches: result.branches }
    for (const name of other.branches ?? []) {
      ambiguous.add(name)
      // Legacy :short output grows a namespace prefix to disambiguate a ref.
      // Treat either spelling as ambiguous; false positives only cost a read.
      ambiguous.add(name.replace(/^(?:refs\/)?(?:heads|remotes)\//, ''))
    }
  }

  const history = await readLog('all', 500)
  if (!history.success) return { ...result, ...history, success: false }
  for (const commit of history.commits ?? []) {
    for (const ref of commit.refs ?? []) {
      if (ref.type === 'tag' || ref.name.startsWith('tag:')) continue
      const raw = ref.name.trim()
      const head = raw.startsWith('HEAD -> ')
      const full = raw.startsWith('refs/')
      if ((head && namespace !== 'heads') || (full && !raw.startsWith(`refs/${namespace}/`))) continue
      const name = head ? raw.slice('HEAD -> '.length) : full ? raw.slice(`refs/${namespace}/`.length) : raw
      if (!names.has(name) || infos.has(name) || legacyAlias(name) || (!head && !full && ambiguous.has(name))) continue
      const info = fromCommit(name, commit)
      if (complete(info)) infos.set(name, info)
    }
  }

  // Reads stay serial: the server leases the repository for each request. The
  // caller captures one task target for this whole operation, and binding or
  // transport failures must propagate rather than publish stale metadata.
  for (const name of missing) {
    if (infos.has(name)) continue
    // A legacy :short alias may already be "heads/x" or even a full ref. Git
    // produced that unambiguous spelling; adding another prefix changes its
    // target. The commit suffix also avoids ambiguity with a worktree path.
    const ref = legacyAlias(name) ? `${name}^{commit}` : `refs/${namespace}/${name}`
    const log = await readLog(ref, 1)
    if (!log.success) return { ...result, ...log, success: false }
    const commit = log.commits?.[0]
    if (commit) {
      const info = fromCommit(name, commit)
      if (complete(info)) infos.set(name, info)
    }
  }
  return { ...result, infos: [...names].flatMap(name => infos.has(name) ? [infos.get(name)!] : []) }
}
