import type { GitCommitFileChange, GitFileDiff } from '@shared/git-types'
import type { ScopedGitClient } from './git-client'

type CommitDiffClient = Pick<ScopedGitClient, 'gitCommitShow' | 'gitShowCommitFile'>

/** Historical previews compare immutable commits; a failed read must never look like an empty file. */
export async function loadGitCommitDiff(
  client: CommitDiffClient,
  hash: string,
  file: GitCommitFileChange
): Promise<GitFileDiff> {
  if (!hash.trim() || !file.path.trim()) throw new Error('提交或文件路径无效')
  const detail = await client.gitCommitShow(hash)
  if (!detail.success) throw new Error(detail.error || '读取提交详情失败')
  if (!detail.commit || !Array.isArray(detail.commit.parents))
    throw new Error('提交详情缺少父提交信息')

  const parent = detail.commit.parents[0]
  const code = file.code.toUpperCase().charAt(0)
  const added = code === 'A' || !parent
  const deleted = code === 'D'
  const read = async (revision: string, path: string): Promise<string> => {
    const result = await client.gitShowCommitFile(revision, path)
    if (!result.success)
      throw new Error(result.error || `读取提交 ${revision.slice(0, 8)} 的文件失败`)
    if (typeof result.content !== 'string') throw new Error('历史文件内容缺失，请重新加载')
    return result.content
  }

  // Reads remain serial because a task engine can hold an exclusive Git lease.
  // Renames compare the parent-side name; older engines without oldPath retain
  // their supplied path instead of guessing one from a display string.
  const oldContent = added ? '' : await read(parent, file.oldPath || file.path)
  const newContent = deleted ? '' : await read(hash, file.path)
  return {
    path: file.path,
    oldPath: file.oldPath,
    changeType: deleted
      ? 'deleted'
      : added
        ? 'added'
        : code === 'R'
          ? 'renamed'
          : code === 'C'
            ? 'copied'
            : 'modified',
    binary: oldContent.includes('\0') || newContent.includes('\0'),
    oldContent,
    newContent,
    // Monaco computes the historical presentation; these are not actionable
    // worktree hunks and must not expose stage/discard operations.
    hunks: []
  }
}
