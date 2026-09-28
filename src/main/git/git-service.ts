/**
 * Git 服务（主进程）
 *
 * 只读：status + log。刻意不做 stage/commit —— 写操作的误操作成本高，
 * 而且终端里做更顺手，不在本批次范围内。
 *
 * 安全：cwd 必须先通过工作区白名单校验（与 fs 服务同一套边界），
 * git 参数全部是固定字面量、不接受任何用户输入，因此没有参数注入面。
 * 路径类数据（文件名、分支名、提交标题）只作为**输出**出现，不回流到命令行。
 */
import { execFile } from 'node:child_process'
import type { GitCommit, GitStatus } from '../../shared/ipc'
import { assertAllowed } from '../fs/file-service'
import { isNoCommitsError, isNotARepoError, parseGitLog, parseGitStatus } from './parsers'

/** 单次 git 调用的超时：卡住时要能失败，不能让界面一直等 */
const GIT_TIMEOUT_MS = 15_000

/** 输出上限：`git status` 在超大仓库里输出可能很大，但没有大到需要流式的程度 */
const GIT_MAX_BUFFER = 16 * 1024 * 1024

/** 历史默认取多少条 */
const DEFAULT_LOG_LIMIT = 50

interface GitRunResult {
  ok: boolean
  stdout: string
  /** stderr 优先，其次 error.message */
  message: string
}

/**
 * 运行一次 git。
 *
 * 非零退出不抛异常而是返回 ok=false：`git status` 在非仓库目录下必然失败，
 * 这属于**正常状态**而非异常，调用方需要区分「不是仓库」和「git 坏了」。
 */
function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        // git 输出是 UTF-8；显式指定避免 Windows 下按本地代码页解码成乱码
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ ok: false, stdout: '', message: '未找到 git 命令，请确认已安装并加入 PATH' })
          return
        }
        resolve({
          ok: !error,
          stdout: stdout ?? '',
          message: (stderr || error?.message || '').trim()
        })
      }
    )
  })
}

/** 读取工作区根目录的 git 状态；非仓库返回 isRepo=false（不抛错） */
export async function getStatus(root: string): Promise<GitStatus> {
  const cwd = assertAllowed(root)

  const result = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--branch'])

  if (!result.ok) {
    if (isNotARepoError(result.message)) {
      return { isRepo: false, branch: '', ahead: null, behind: null, changes: [] }
    }
    // git 不可用或其它故障：抛出，让界面显示真实原因
    throw new Error(result.message || 'git status 执行失败')
  }

  return parseGitStatus(result.stdout)
}

/** 读取最近提交历史；非仓库或无提交时返回空数组 */
export async function getLog(root: string, limit = DEFAULT_LOG_LIMIT): Promise<GitCommit[]> {  const cwd = assertAllowed(root)
  const count =
    Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : DEFAULT_LOG_LIMIT

  const result = await runGit(cwd, [
    'log',
    `--max-count=${count}`,
    '--date=iso-strict',
    // %x1f 是 git 的转义写法，输出即 US 分隔符（见 parsers.ts 的格式说明）
    '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s'
  ])

  if (!result.ok) {
    if (isNotARepoError(result.message) || isNoCommitsError(result.message)) return []
    throw new Error(result.message || 'git log 执行失败')
  }

  return parseGitLog(result.stdout)
}

/**
 * 暂存指定文件（git add）。「改动条」的「暂存」动作使用。
 * 只接受工作区内相对/绝对路径，逐条校验后一次 add，避免参数注入。
 * 非仓库视为失败（调用方应先判断 isRepo）。
 */
export async function stagePaths(root: string, paths: string[]): Promise<void> {
  const cwd = assertAllowed(root)
  if (!Array.isArray(paths) || paths.length === 0) return

  const result = await runGit(cwd, ['add', '--', ...paths])
  if (!result.ok) {
    throw new Error(result.message || 'git add 执行失败')
  }
}
