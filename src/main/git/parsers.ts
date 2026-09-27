/**
 * git 输出解析（纯函数，无副作用，可直接单测）
 *
 * 把解析单独拆出来的理由：这是整条 git 链路上唯一有真实复杂度的部分，
 * 而它的输入格式（NUL 分隔、字段分隔符、分支行语法）细节多、容易写错。
 * 独立成纯函数后可以用真实 git 输出做样本测试，不需要真的起一个仓库。
 *
 * 实际格式（本机 git 2.55 实测）：
 *
 *   git status --porcelain=v1 -z --branch
 *     "## main...origin/main\0 M package-lock.json\0?? .tmp/\0"
 *     - 首段是分支行（以 "## " 开头）
 *     - 其余每段形如 `XY<空格>路径`，XY 恒为两个字符
 *     - 重命名/复制（X 为 R 或 C）会**紧跟一段原始路径**，需要跳过
 *
 *   git log --pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s
 *     字段用 US(\x1f) 分隔、提交之间用 \n 分隔。
 *     用 US 而不是 | 之类的可见字符：提交标题里什么字符都可能出现。
 */
import type { GitCommit, GitFileChange, GitStatus } from '../../shared/ipc'

/** git log 的字段分隔符（ASCII Unit Separator） */
const FIELD_SEP = '\u001f'

/** 分支行可能的形态：`main...origin/main [ahead 1, behind 2]` */
function parseBranchLine(line: string): Pick<GitStatus, 'branch' | 'ahead' | 'behind'> {
  // 去掉前导的 "## "
  let rest = line.slice(3).trim()
  let ahead: number | null = null
  let behind: number | null = null

  // 有上游时 git 会在末尾追加 [ahead N, behind M]，也可能只出现其中一个
  const bracket = rest.indexOf(' [')
  if (bracket >= 0) {
    const extra = rest.slice(bracket + 2, rest.endsWith(']') ? -1 : undefined)
    const aheadMatch = /ahead (\d+)/.exec(extra)
    const behindMatch = /behind (\d+)/.exec(extra)
    ahead = aheadMatch ? Number(aheadMatch[1]) : null
    behind = behindMatch ? Number(behindMatch[1]) : null
    rest = rest.slice(0, bracket)
  }

  // 空仓库：`No commits yet on main`
  if (rest.startsWith('No commits yet on ')) {
    return { branch: rest.slice('No commits yet on '.length), ahead, behind }
  }

  // 有上游：`main...origin/main`；无上游：`main`
  const branch = rest.includes('...') ? rest.split('...')[0] : rest
  // 分离头指针：git 给的是 `HEAD (no branch)`
  if (branch.startsWith('HEAD (no branch)')) {
    return { branch: 'HEAD', ahead, behind }
  }

  return { branch, ahead, behind }
}

/** 解析 `git status --porcelain=v1 -z --branch` 的输出 */
export function parseGitStatus(stdout: string): GitStatus {
  const tokens = stdout.split('\0')
  const status: GitStatus = { isRepo: true, branch: '', ahead: null, behind: null, changes: [] }

  let index = 0
  if (tokens[0]?.startsWith('## ')) {
    Object.assign(status, parseBranchLine(tokens[0]))
    index = 1
  }

  const changes: GitFileChange[] = []
  for (; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token) continue
    // XY 两字符 + 一个空格 + 路径；不足说明不是条目，跳过而不是猜
    if (token.length < 4) continue

    const indexStatus = token[0]
    const workTreeStatus = token[1]
    const path = token.slice(3)
    if (!path) continue

    // 重命名/复制：下一段是原始路径（形如 R  new\0old\0），消费掉它
    if (indexStatus === 'R' || indexStatus === 'C') index++

    changes.push({
      path,
      indexStatus,
      workTreeStatus,
      // 未跟踪（?）不属于"已暂存"，尽管它在暂存列上
      staged: indexStatus !== ' ' && indexStatus !== '?'
    })
  }

  status.changes = changes
  return status
}

/** 解析 `git log --pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s` 的输出 */
export function parseGitLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = []

  for (const line of stdout.split('\n')) {
    if (!line) continue
    const fields = line.split(FIELD_SEP)
    // 字段数不足说明这一行不符合格式（例如 git 的告警输出混入），跳过
    if (fields.length < 6) continue

    const [hash, shortHash, author, date, refs, subject] = fields
    if (!hash) continue

    commits.push({ hash, shortHash, author, date, refs: refs ?? '', subject })
  }

  return commits
}

/** 目录不是 git 仓库（git 的 stderr 文案） */
export function isNotARepoError(message: string): boolean {
  return /not a git repository/i.test(message)
}

/** 是仓库但还没有任何提交（此时 git log 会失败） */
export function isNoCommitsError(message: string): boolean {
  return /does not have any commits yet|unknown revision|bad revision/i.test(message)
}
