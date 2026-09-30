/**
 * Git 服务（主进程）
 *
 * 移植自 wuzu-client 的 codeGit/gitService.ts（约 2900 行），直接 execFile 调 git，
 * 不依赖 simple-git。与 aether 旧版「直接抛错」风格不同，这里全部遵循
 * `{ success, error?, errorCode? }` 的 GitResult 信封（契约见 shared/git-types.ts），
 * 失败原因由 toFriendlyMessage 归一成中文文案 + errorCode 分类。
 *
 * 安全约束：
 * - cwd 必须先过工作区白名单校验（assertAllowed，与 fs 服务同一套边界）
 * - git 参数中所有用户输入（路径/分支名/提交信息）一律作为独立 argv 元素传递，
 *   不经 shell 拼接，无注入面
 */
import { execFile } from 'node:child_process'
import { readFile, appendFile, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  GitBlameLine,
  GitBlameResult,
  GitBranchInfo,
  GitBranchInfoResult,
  GitBranchListResult,
  GitChangeType,
  GitCommitFileChange,
  GitCommitInfoResult,
  GitCommitRef,
  GitDiffResult,
  GitDivergenceResult,
  GitFileChange,
  GitFileHistoryEntry,
  GitFileHistoryResult,
  GitHeadFileResult,
  GitHunk,
  GitIgnoreCheckResult,
  GitLogEntry,
  GitLogQuery,
  GitLogResult,
  GitRemoteBranchInfo,
  GitRemoteBranchListResult,
  GitRemoteListResult,
  GitResult,
  GitStashEntry,
  GitStashListResult,
  GitStatusResult,
  GitSuggestMessageResult,
  GitTagListResult,
  GitUserListResult,
  GitUserResult
} from '../../shared/git-types'
import { assertAllowed } from '../fs/file-service'
import { resolveGitExecutable } from './git-resolver'

const execFileAsync = promisify(execFile)

/** 单次 git 调用超时：远程操作卡住时要能失败，不能让界面一直等 */
const GIT_TIMEOUT_MS = 30_000
/** 输出上限：blame/log/status 在大仓库里可能很大，但没有大到需要流式 */
const GIT_MAX_BUFFER = 20 * 1024 * 1024
/** 未跟踪文件统计行数的体积上限：超过就不数了（读进内存不划算） */
const UNTRACKED_COUNT_LIMIT = 2 * 1024 * 1024
/** blame 文件体积上限：超过直接返回空（行内标注不是刚需） */
const BLAME_MAX_FILE_BYTES = 2 * 1024 * 1024

// ==================== 基础设施 ====================

/** 从 execFile 错误中提取最有信息量的文本：stderr 优先，其次 message */
function toMessage(error: unknown): string {
  const err = error as { stderr?: string; message?: string; killed?: boolean; cmd?: string } | null
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
  if (stderr) return stderr
  if (typeof err?.message === 'string' && err.message) return err.message
  return String(error)
}

/** 远程类命令（用于判定「超时杀死的远程操作可能是 SSH 口令阻塞」） */
const REMOTE_CMD = /git (pull|fetch|push|clone|ls-remote)/i

/** SSH 私钥口令阻塞的判定：被超时杀死且 stderr 为空（无 tty 挂起形态），或 stderr 明确提及口令/公钥 */
function isSshPassphraseFailure(error: unknown): boolean {
  const err = error as { killed?: boolean; stderr?: string; cmd?: string } | null
  if (err?.killed === true && !String(err?.stderr ?? '').trim() && REMOTE_CMD.test(String(err?.cmd ?? ''))) {
    return true
  }
  return /passphrase|Load key|Permission denied \(publickey\)|No supported authentication methods/i.test(
    toMessage(error)
  )
}

/** 本地与远端分叉的判定（pull 不加策略时的典型报错） */
function isDivergentFailure(error: unknown): boolean {
  const raw = toMessage(error)
  return (
    /divergent branches|need to specify how to reconcile|Not possible to fast-forward/i.test(raw) &&
    !/CONFLICT|Automatic merge failed|fix conflicts|error: could not apply/i.test(raw)
  )
}

const SSH_PASSPHRASE_HINT: Pick<GitResult, 'error' | 'errorCode'> = {
  error: '你的 SSH 私钥设有口令，客户端无法自动完成认证。请先在终端执行 ssh-add 加载私钥后重试。',
  errorCode: 'ssh-passphrase'
}

const DIVERGENT_HINT: Pick<GitResult, 'error' | 'errorCode'> = {
  error: '本地与远端各自都有新提交，Git 需要你选择如何合并。请在弹窗中选择合并方式。',
  errorCode: 'divergent'
}

/**
 * 把 git 的英文 stderr 归一成用户能行动的中文文案。
 * 顺序敏感：更具体的规则在前。
 */
function toFriendlyMessage(error: unknown): string {
  const raw = toMessage(error)
  const test = (pattern: RegExp): boolean => pattern.test(raw)

  if (test(/would be overwritten by (merge|checkout)/) || test(/Please commit your changes or stash them/)) {
    const affected = raw
      .split('\n')
      .filter((line) => line.startsWith('\t'))
      .map((line) => line.trim())
    const shown = affected.slice(0, 20)
    const more = affected.length > shown.length ? `\n…另有 ${affected.length - shown.length} 个文件` : ''
    return (
      '本地有未提交的改动，拉取会覆盖它们。\n' +
      (shown.length > 0 ? `受影响文件（${affected.length} 个）：\n${shown.map((f) => `  ${f}`).join('\n')}${more}\n` : '') +
      '请先提交或暂存这些改动，再重新拉取。'
    )
  }
  if (test(/CONFLICT|Automatic merge failed|fix conflicts/)) {
    const files = [...raw.matchAll(/Merge conflict in (.+)/g)].map((m) => m[1])
    const list =
      files.length > 3 ? `${files.slice(0, 3).join('、')} 等 ${files.length} 个文件` : files.join('、')
    return `合并时发生冲突${list ? `：${list}` : ''}。请解决冲突后再提交。`
  }
  if (test(/divergent branches|need to specify how to reconcile|Not possible to fast-forward/)) {
    return '本地与远端的提交历史不一致，无法直接合并。在弹窗中选择合并方式即可。'
  }
  if (test(/Authentication failed|could not read Username|Invalid username or password|authentication token/)) {
    return 'Git 认证失败：请检查账号密码或访问令牌是否正确、是否已过期。'
  }
  if (test(/passphrase|Load key|Permission denied \(publickey\)|No supported authentication methods/)) {
    return (
      'SSH 公钥认证未通过。\n' +
      '若你的私钥设有口令，请先在终端执行 ssh-add 加载私钥。\n' +
      '若仍然失败，说明该公钥未添加到 Git 平台，或当前账号没有这个仓库的权限。'
    )
  }
  if (test(/Permission denied/)) {
    return 'Git 权限不足：请确认当前账号对远端仓库有访问权限。'
  }
  if (test(/Updates were rejected|non-fast-forward|fetch first|tip of your current branch is behind/)) {
    return '推送被拒绝：远端有你本地没有的新提交，请先拉取合并后再推送。'
  }
  if (test(/Could not resolve host|Connection timed out|Connection refused|Network is unreachable|Failed to connect/)) {
    return '网络连接失败：无法访问远端仓库，请检查网络或 VPN/代理设置。'
  }
  if (test(/index\.lock|Another git process/)) {
    return '另一个 Git 操作正在进行（index.lock 被占用），请稍后重试。'
  }
  if (test(/not a git repository|not in a git directory/)) {
    return '当前目录不是 Git 仓库。'
  }
  if (test(/detached HEAD/)) {
    return '当前处于游离提交（detached HEAD）状态，请先切换到一个分支再操作。'
  }
  if (test(/has no upstream|no tracking information|no upstream configured/)) {
    return '当前分支没有关联远端分支，无法拉取或推送。'
  }
  if (test(/tell me who you are|empty ident|unable to auto-detect email/)) {
    return '未配置 Git 身份信息：请先设置 user.name 和 user.email 再提交。'
  }
  if (test(/nothing to commit/)) {
    return '没有可提交的改动。'
  }
  if (test(/are ignored by one of your \.gitignore files/)) {
    const files = raw
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('hint:'))
    return (
      '这些文件被 .gitignore 设置为忽略，无法加入暂存区：' +
      files.join('、') +
      '。如需提交，请先在 .gitignore 中删除对应的忽略规则。'
    )
  }
  if (test(/remote .* already exists/)) {
    return '同名远端已存在，无需重复添加。'
  }
  const pathspec = /pathspec '([^']+)' did not match/.exec(raw)
  if (pathspec) {
    return `文件路径不存在或不匹配：${pathspec[1]}`
  }
  if (test(/No local changes to save/)) {
    return '当前没有可存储的本地改动。'
  }
  if (test(/already exists/) && test(/tag/)) {
    return '同名标签已存在，请换一个名字。'
  }
  if (test(/is not merged/)) {
    return '该分支尚未合并到当前分支，直接删除会丢失提交。如确认删除请使用强制删除。'
  }
  if (test(/no stash entries found|No stash found/)) {
    return '当前没有存储记录。'
  }
  const err = error as { killed?: boolean; cmd?: string } | null
  if (err?.killed && REMOTE_CMD.test(String(err?.cmd ?? ''))) {
    return (
      '连接远端仓库无响应（已等待 30 秒）。\n' +
      '若是 SSH 私钥口令导致，请先在终端执行 ssh-add 加载私钥。\n' +
      '若非口令问题，请检查网络或 VPN/代理后重试。'
    )
  }
  if (err?.killed || test(/ETIMEDOUT|timed? ?out/)) {
    return 'Git 命令执行超时（30 秒），请稍后重试。'
  }
  if (test(/ENOENT|command not found/)) {
    return '未找到 git 命令：请安装 Git 并加入 PATH 后重试。'
  }
  // 兜底：取 stderr 前 5 行非空行
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.slice(0, 5).join('\n') || 'Git 操作失败'
}

/** 包装为失败信封 */
function fail(error: unknown): GitResult {
  return { success: false, error: toFriendlyMessage(error) }
}

/**
 * 运行一次 git，返回 stdout。非零退出抛错（错误上带 stderr），
 * 由调用方包成 GitResult 信封。
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync(
    resolveGitExecutable(),
    // core.quotePath=false：防止中文路径被八进制转义成 "\344\270\xx"
    ['-c', 'core.quotePath=false', ...args],
    {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }
  )
  return result.stdout ?? ''
}

/** 带 stdin 的 git 调用（目前仅 hunk 撤销的 apply 用） */
function runGitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      resolveGitExecutable(),
      ['-c', 'core.quotePath=false', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          rejectPromise(new Error((stderr || error.message || '').trim() || 'git apply 执行失败'))
          return
        }
        resolvePromise()
      }
    )
    child.stdin?.end(input)
  })
}

/** 校验 cwd 并收窄到工作区白名单内；越界直接抛错（由 IPC 层兜底成信封） */
function resolveCwd(cwd: string): string {
  return assertAllowed(cwd)
}

// ==================== 状态与 diff ====================

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** 初始化仓库；已是仓库时幂等成功 */
export async function init(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    if (await isGitRepo(root)) return { success: true }
    await runGit(root, ['init'])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** porcelain XY 状态码 → 变更类型 */
function mapChangeType(code: string | undefined): GitChangeType | null {
  switch (code) {
    case '.':
    case undefined:
      return null
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

/**
 * 读取工作区状态：`status --porcelain=v2 --untracked-files=all --renames`，
 * 再补 numstat（暂存区与工作区各一次）与合并状态（MERGE_HEAD/MERGE_MSG）。
 */
export async function status(cwd: string): Promise<GitStatusResult> {
  const root = resolveCwd(cwd)
  if (!(await isGitRepo(root))) {
    return { success: true, isRepo: false, files: [] }
  }
  try {
    const out = await runGit(root, ['status', '--porcelain=v2', '--untracked-files=all', '--renames'])
    const files: GitFileChange[] = []

    for (const line of out.split('\n')) {
      if (!line) continue
      const kind = line[0]
      if (kind === '1' || kind === '2') {
        // 普通条目 / 重命名条目。重命名行多一个 score 字段，路径起点不同，tab 后是原路径
        const parts = line.split(' ')
        const xy = parts[1] ?? '..'
        const tabParts = kind === '2' ? line.split('\t') : null
        const filePath = kind === '2' ? tabParts?.[0].split(' ').slice(9).join(' ') : parts.slice(8).join(' ')
        const oldPath = kind === '2' ? tabParts?.[1] : undefined
        if (!filePath) continue
        const stagedChange = mapChangeType(xy[0])
        const unstagedChange = mapChangeType(xy[1])
        files.push({
          path: filePath,
          oldPath,
          changeType: unstagedChange ?? stagedChange ?? 'modified',
          staged: stagedChange !== null,
          stagedChange,
          unstagedChange,
          binary: false,
          additions: 0,
          deletions: 0
        })
      } else if (kind === 'u') {
        // 未合并（冲突）行：XY 之后还有 submodule/mode 字段，路径从第 11 字段起
        const parts = line.split(' ')
        const xy = parts[1] ?? '..'
        const filePath = parts.slice(10).join(' ')
        if (!filePath) continue
        const stagedChange = mapChangeType(xy[0])
        const unstagedChange = mapChangeType(xy[1])
        files.push({
          path: filePath,
          changeType: stagedChange ?? unstagedChange ?? 'modified',
          staged: stagedChange !== null,
          stagedChange,
          unstagedChange,
          conflict: true,
          binary: false,
          additions: 0,
          deletions: 0
        })
      } else if (kind === '?') {
        const filePath = line.slice(2)
        if (!filePath) continue
        files.push({
          path: filePath,
          changeType: 'untracked',
          staged: false,
          stagedChange: null,
          unstagedChange: 'untracked',
          binary: false,
          additions: 0,
          deletions: 0
        })
      }
      // '#' 开头的是 branch 头信息，这里不需要（branchInfo 单独查）
    }

    await fillNumstat(root, files)
    const mergeState = await readMergeState(root)
    return { success: true, isRepo: true, files, ...mergeState }
  } catch (error) {
    return fail(error)
  }
}

/** 合并状态：MERGE_HEAD 存在即合并中，顺带读出 git 自动生成的 MERGE_MSG */
async function readMergeState(cwd: string): Promise<{ merging: boolean; mergeMessage?: string }> {
  try {
    await runGit(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  } catch {
    return { merging: false }
  }
  try {
    const msgPathRaw = (await runGit(cwd, ['rev-parse', '--git-path', 'MERGE_MSG'])).trim()
    const msgPath = path.isAbsolute(msgPathRaw) ? msgPathRaw : path.resolve(cwd, msgPathRaw)
    const content = await readFile(msgPath, 'utf8')
    const message = content
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
      .trimEnd()
    return { merging: true, mergeMessage: message || undefined }
  } catch {
    return { merging: true }
  }
}

/** 为状态列表补增删行数：分别跑 worktree vs index 与 index vs HEAD 的 numstat */
async function fillNumstat(cwd: string, files: GitFileChange[]): Promise<void> {
  const byPath = new Map(files.map((f) => [f.path, f]))

  const applyNumstat = async (args: string[], side: 'staged' | 'unstaged'): Promise<void> => {
    try {
      const out = await runGit(cwd, args)
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        const cols = line.split('\t')
        if (cols.length < 3) continue
        const [add, del] = cols
        // rename 行带旧路径列，取最后一列作为当前路径
        const filePath = cols[cols.length - 1]
        const file = byPath.get(filePath)
        if (!file) continue
        if (add === '-' || del === '-') {
          // numstat 对二进制输出 '-'
          file.binary = true
          continue
        }
        if (side === 'staged') {
          file.stagedAdditions = Number(add)
          file.stagedDeletions = Number(del)
        } else {
          file.unstagedAdditions = Number(add)
          file.unstagedDeletions = Number(del)
        }
      }
    } catch {
      // numstat 失败（比如空仓库无 HEAD）不影响状态本身
    }
  }

  await applyNumstat(['diff', '--numstat'], 'unstaged')
  await applyNumstat(['diff', '--numstat', '--cached'], 'staged')

  for (const file of files) {
    file.additions = (file.stagedAdditions ?? 0) + (file.unstagedAdditions ?? 0)
    file.deletions = (file.stagedDeletions ?? 0) + (file.unstagedDeletions ?? 0)
  }

  await fillUntrackedAdditions(cwd, files)
}

/** 未跟踪文件没有 numstat 可查，直接读文件数行（限体积；含 NUL 视为二进制） */
async function fillUntrackedAdditions(cwd: string, files: GitFileChange[]): Promise<void> {
  for (const file of files) {
    if (file.changeType !== 'untracked' || file.additions > 0) continue
    try {
      const fullPath = path.join(cwd, file.path)
      const info = await stat(fullPath)
      if (!info.isFile() || info.size > UNTRACKED_COUNT_LIMIT) continue
      const buffer = await readFile(fullPath)
      if (buffer.includes(0)) {
        file.binary = true
        continue
      }
      const text = buffer.toString('utf8')
      let lines = text.split('\n').length
      if (text.endsWith('\n')) lines -= 1
      file.additions = lines
    } catch {
      // 单个文件读失败不影响整体
    }
  }
}

// ---------- diff ----------

/** diff hunk 头：@@ -oldStart,oldLines +newStart,newLines @@ heading */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** 解析 unified diff 的 hunk 列表（行号从 hunk 头起算逐行推进） */
export function parseHunks(raw: string): GitHunk[] {
  const hunks: GitHunk[] = []
  let current: GitHunk | null = null
  let oldLine = 0
  let newLine = 0
  let index = 0

  for (const line of raw.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      current = {
        id: `h${index++}`,
        oldStart: oldLine,
        oldLines: header[2] ? Number(header[2]) : 1,
        newStart: newLine,
        newLines: header[4] ? Number(header[4]) : 1,
        heading: header[5]?.trim() || undefined,
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    const prefix = line[0]
    const content = line.slice(1)
    if (prefix === '+') {
      current.lines.push({ type: 'add', oldLineNumber: null, newLineNumber: newLine++, content })
    } else if (prefix === '-') {
      current.lines.push({ type: 'delete', oldLineNumber: oldLine++, newLineNumber: null, content })
    } else if (prefix === ' ') {
      current.lines.push({ type: 'context', oldLineNumber: oldLine++, newLineNumber: newLine++, content })
    }
    // '\ No newline at end of file' 以 \ 开头，自然忽略
  }
  return hunks
}

async function hasHead(cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/**
 * 构造 diff 参数：
 * - staged：index vs HEAD（--cached）
 * - 默认：worktree vs index（更改组视角）
 * - base='head'：worktree vs HEAD（编辑器 gutter / hunk 撤销的基准）
 */
async function buildDiffArgs(cwd: string, filePath: string, staged: boolean, base?: 'index' | 'head'): Promise<string[]> {
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (staged) {
    args.push('--cached')
  } else if (base === 'head' && (await hasHead(cwd))) {
    args.push('HEAD')
  }
  args.push('--', filePath)
  return args
}

/** 旧内容：未暂存视角优先取 index（:0:），取不到回退 HEAD；staged/head 基准优先 HEAD */
async function readOldContent(cwd: string, filePath: string, staged: boolean, base?: 'index' | 'head'): Promise<string> {
  const tryShow = async (ref: string): Promise<string | null> => {
    try {
      return await runGit(cwd, ['show', `${ref}:${filePath}`])
    } catch {
      return null
    }
  }
  if (!staged && base !== 'head') {
    return (await tryShow(':0')) ?? (await tryShow('HEAD')) ?? ''
  }
  return (await tryShow('HEAD')) ?? (await tryShow(':0')) ?? ''
}

/** 新内容：staged 取 index，否则读磁盘工作区文件 */
async function readNewContent(cwd: string, filePath: string, staged: boolean): Promise<string> {
  if (staged) {
    try {
      return await runGit(cwd, ['show', `:0:${filePath}`])
    } catch {
      return ''
    }
  }
  try {
    return await readFile(path.join(cwd, filePath), 'utf8')
  } catch {
    return ''
  }
}

export async function diff(cwd: string, filePath: string, staged: boolean, base?: 'index' | 'head'): Promise<GitDiffResult> {
  const root = resolveCwd(cwd)
  try {
    const raw = await runGit(root, await buildDiffArgs(root, filePath, staged, base))
    const binary = raw.includes('Binary files')
    const [oldContent, newContent] = await Promise.all([
      readOldContent(root, filePath, staged, base),
      readNewContent(root, filePath, staged)
    ])
    return {
      success: true,
      diff: {
        path: filePath,
        changeType: oldContent === '' ? 'added' : newContent === '' ? 'deleted' : 'modified',
        binary,
        oldContent,
        newContent,
        hunks: binary ? [] : parseHunks(raw)
      }
    }
  } catch (error) {
    return fail(error)
  }
}

// ==================== 分支信息 ====================

export async function branchInfo(cwd: string): Promise<GitBranchInfoResult> {
  const root = resolveCwd(cwd)
  if (!(await isGitRepo(root))) {
    return { success: true, isRepo: false }
  }
  try {
    const out = await runGit(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=no'])
    const info: GitBranchInfo = { branch: '', upstream: null, ahead: null, behind: null }
    for (const line of out.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        info.branch = line.slice('# branch.head '.length).trim()
      } else if (line.startsWith('# branch.upstream ')) {
        info.upstream = line.slice('# branch.upstream '.length).trim()
      } else if (line.startsWith('# branch.ab ')) {
        const match = /\+(\d+) -(\d+)/.exec(line)
        if (match) {
          info.ahead = Number(match[1])
          info.behind = Number(match[2])
        }
      }
    }
    return { success: true, isRepo: true, info }
  } catch (error) {
    return fail(error)
  }
}

// ==================== 暂存 / 撤销 ====================

/** 暂存单文件（-f：已跟踪文件位于被忽略目录下时不带 -f 会 exit 1 但实际已暂存） */
export async function stage(cwd: string, filePath: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['add', '-f', '--', filePath])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function unstage(cwd: string, filePath: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    try {
      await runGit(root, ['restore', '--staged', '--', filePath])
    } catch (error) {
      // `git restore --staged` resolves its default source from HEAD. An
      // unborn repository has no HEAD yet, so unstage the first file with
      // rm --cached while preserving the worktree bytes.
      if (/pathspec|did not match|unknown revision|does not have any commits|could not resolve ['"]?HEAD|invalid reference|ambiguous argument ['"]?HEAD/i.test(toMessage(error))) {
        await runGit(root, ['rm', '--cached', '--force', '--', filePath])
      } else {
        throw error
      }
    }
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** 把候选路径收窄到 git 认得的子集（已跟踪或未跟踪但未忽略），避免整批 add 因个别失效路径 fatal */
async function filterGitKnownPaths(cwd: string, paths: string[]): Promise<string[]> {
  const normalize = (value: string): string => {
    const relative = path.relative(cwd, path.resolve(cwd, value)).replace(/\\/g, '/')
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('只能暂存当前工作区内的文件')
    }
    return process.platform === 'win32' ? relative.toLowerCase() : relative
  }
  const candidates = [...new Set(paths)]
  const relativePaths = candidates.map(normalize)
  // ls-files always returns cwd-relative names, even for absolute input paths.
  // Literal pathspecs keep filenames containing [, *, or ? from selecting neighbours.
  const out = await runGit(cwd, ['--literal-pathspecs', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...candidates])
  const known = new Set(out.split('\0').filter(Boolean).map(normalize))
  return candidates.filter((_value, index) => known.has(relativePaths[index]))
}

/** 批量暂存：先收窄到 git 认得的子集，返回实际暂存的路径供调用方记账 */
export async function stageFiles(cwd: string, paths: string[]): Promise<GitResult> {
  const root = resolveCwd(cwd)
  if (!Array.isArray(paths) || paths.length === 0) return { success: true, stagedPaths: [] }
  try {
    const known = await filterGitKnownPaths(root, paths)
    if (known.length === 0) return { success: true, stagedPaths: [] }
    await runGit(root, ['--literal-pathspecs', 'add', '-f', '--', ...known])
    return { success: true, stagedPaths: known }
  } catch (error) {
    return fail(error)
  }
}

/** 批量查询路径是否被 .gitignore 忽略（exit 1 = 全部未忽略，不是错误） */
export async function checkIgnored(cwd: string, paths: string[]): Promise<GitIgnoreCheckResult> {
  const root = resolveCwd(cwd)
  if (!Array.isArray(paths) || paths.length === 0) return { success: true, ignored: {} }
  try {
    let out = ''
    try {
      out = await runGit(root, ['check-ignore', '--', ...paths])
    } catch (error) {
      // exit 1：没有路径被忽略；exit >= 128：真错误
      const err = error as { code?: number; stdout?: string }
      if (typeof err.code === 'number' && err.code >= 128) throw error
      out = typeof err.stdout === 'string' ? err.stdout : ''
    }
    const ignoredSet = new Set(
      out.split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/').toLowerCase())
    )
    const ignored: Record<string, boolean> = {}
    for (const p of paths) {
      ignored[p] = ignoredSet.has(p.replace(/\\/g, '/').toLowerCase())
    }
    return { success: true, ignored }
  } catch (error) {
    return fail(error)
  }
}

/** 批量取消暂存（reset -q 对未跟踪/无 HEAD 场景更宽容） */
export async function unstageFiles(cwd: string, paths: string[]): Promise<GitResult> {
  const root = resolveCwd(cwd)
  if (!Array.isArray(paths) || paths.length === 0) return { success: true }
  try {
    try {
      await runGit(root, ['reset', '-q', '--', ...paths])
    } catch (error) {
      // `git reset <paths>` also needs HEAD. For an unborn repository, remove
      // each candidate from the index; ignored/non-index paths are harmless.
      if (!/pathspec|did not match|unknown revision|does not have any commits|could not resolve ['"]?HEAD|invalid reference|ambiguous argument ['"]?HEAD/i.test(toMessage(error))) {
        throw error
      }
      for (const filePath of paths) {
        await runGit(root, ['rm', '--cached', '--force', '--', filePath]).catch(() => undefined)
      }
    }
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

async function isTrackedInHead(cwd: string, filePath: string): Promise<boolean> {
  try {
    await runGit(cwd, ['cat-file', '-e', `HEAD:${filePath}`])
    return true
  } catch {
    return false
  }
}

/**
 * 放弃单文件全部改动（暂存区 + 工作区都还原；HEAD 里不存在的文件直接删磁盘）。
 * 用于「放弃更改」的彻底语义。
 */
export async function discardFile(cwd: string, filePath: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    try {
      await runGit(root, ['restore', '--staged', '--', filePath])
    } catch (error) {
      // 无 HEAD（空仓库）或路径不在 index：退回 rm --cached
      if (/pathspec|did not match|unknown revision|does not have any commits|could not resolve ['"]?HEAD|invalid reference|ambiguous argument ['"]?HEAD/i.test(toMessage(error))) {
        await runGit(root, ['rm', '--cached', '--force', '--', filePath]).catch(() => undefined)
      } else {
        throw error
      }
    }
    try {
      await runGit(root, ['restore', '--worktree', '--', filePath])
    } catch (error) {
      if (!/pathspec|did not match/i.test(toMessage(error))) throw error
    }
    if (!(await isTrackedInHead(root, filePath))) {
      await rm(path.join(root, filePath), { force: true })
    }
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** 只放弃工作区改动（还原到 index 版本），暂存区保留 —— 「更改」组的放弃语义 */
export async function discardWorktree(cwd: string, filePath: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    try {
      await runGit(root, ['restore', '--worktree', '--', filePath])
    } catch (error) {
      // 未跟踪文件：restore 必然 pathspec 失败，直接删文件
      if (/pathspec|did not match/i.test(toMessage(error))) {
        await rm(path.join(root, filePath), { force: true })
        return { success: true }
      }
      throw error
    }
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function discardWorktreeFiles(cwd: string, paths: string[]): Promise<GitResult> {
  for (const p of paths) {
    const result = await discardWorktree(cwd, p)
    if (!result.success) return result
  }
  return { success: true }
}

export async function discardFiles(cwd: string, paths: string[]): Promise<GitResult> {
  for (const p of paths) {
    const result = await discardFile(cwd, p)
    if (!result.success) return result
  }
  return { success: true }
}

/**
 * hunk 级撤销：以 HEAD 为基准重新 diff（与编辑器 gutter 同基准），
 * 按 hunkId（h0/h1…）取出对应块，拼上文件头后 `git apply --reverse`。
 */
export async function discardHunk(cwd: string, filePath: string, hunkId: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const raw = await runGit(root, await buildDiffArgs(root, filePath, false, 'head'))
    const lines = raw.split('\n')
    const headerEnd = lines.findIndex((l) => l.startsWith('@@'))
    if (headerEnd < 0) return { success: false, error: '未找到可撤销的变更块。' }
    const fileHeader = lines.slice(0, headerEnd)
    const hunkBlocks: string[][] = []
    let block: string[] | null = null
    for (const line of lines.slice(headerEnd)) {
      if (line.startsWith('@@')) {
        block = [line]
        hunkBlocks.push(block)
      } else if (block) {
        block.push(line)
      }
    }
    const index = Number(hunkId.replace(/^h/, ''))
    const target = hunkBlocks[index]
    if (!target) return { success: false, error: '变更块已变化，请刷新后重试。' }
    const patch = [...fileHeader, ...target].join('\n') + '\n'
    await runGitWithInput(root, ['apply', '--reverse', '--unidiff-zero', '-'], patch)
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** 读取 HEAD 版本文件内容；文件不在 HEAD（未跟踪/新增）时返回空串而非错误 */
export async function headFile(cwd: string, filePath: string): Promise<GitHeadFileResult> {
  const root = resolveCwd(cwd)
  try {
    const content = await runGit(root, ['show', `HEAD:${filePath}`])
    return { success: true, content }
  } catch (error) {
    if (/does not exist|exists on disk|not in 'HEAD'|unknown revision|Needed a single revision/i.test(toMessage(error))) {
      return { success: true, content: '' }
    }
    return fail(error)
  }
}

/** 「打开文件（HEAD）」入口，语义同 headFile */
export const getHeadFile = headFile

// ==================== 提交 ====================

export async function commit(cwd: string, message: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  if (!message?.trim()) return { success: false, error: '请输入提交信息。' }
  try {
    await runGit(root, ['commit', '-m', message])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function stageAllAndCommit(cwd: string, message: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  if (!message?.trim()) return { success: false, error: '请输入提交信息。' }
  try {
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-m', message])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** 修补上一次提交（--amend --no-edit） */
export async function commitAmend(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['commit', '--amend', '--no-edit'])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function commitAmendWithMessage(cwd: string, message: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['commit', '--amend', '-m', message])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** 撤销上一次提交，改动回到暂存区（reset --soft HEAD~1） */
export async function undoCommit(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['reset', '--soft', 'HEAD~1'])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function commitEmpty(cwd: string, message: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const args = ['commit', '--allow-empty']
    if (message?.trim()) args.push('-m', message)
    else args.push('--allow-empty-message')
    await runGit(root, args)
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** 把路径追加到 .gitignore（幂等；目录不存在时先建） */
export async function appendGitignore(cwd: string, filePath: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const entry = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
    const ignorePath = path.join(root, '.gitignore')
    let existing = ''
    try {
      existing = await readFile(ignorePath, 'utf8')
    } catch {
      // 文件不存在：走创建分支
    }
    const entries = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean))
    if (entries.has(entry) || entries.has(`/${entry}`)) return { success: true }
    await mkdir(path.dirname(ignorePath), { recursive: true })
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    await appendFile(ignorePath, `${prefix}${entry}\n`, 'utf8')
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/**
 * 提交信息建议（本地启发式 + AI 上下文）。
 *
 * wuzu 原版走主进程 AI 网关（aigwChat），aether 改为两段式：
 * 这里始终产出本地启发式兜底文案，同时收集 numstat + 截断 diff 作为 aiContext
 * 返回给渲染层；渲染层在「轻任务模型」可用时调引擎 /utility/chat 生成更贴合的
 * 提交信息，失败/未配置时直接展示本地文案。
 */

/** 收集供 AI 参考的改动上下文：文件清单 + 截断的 unified diff 片段 */
async function collectAiContext(root: string, staged: boolean): Promise<string> {
  const args = staged ? ['diff', '--cached'] : ['diff']
  const [numstat, diff] = await Promise.all([
    runGit(root, [...args, '--stat']).catch(() => ''),
    runGit(root, args).catch(() => '')
  ])
  // diff 截断：单文件超长 diff 会让轻模型跑题，只保留头部约 6k 字符
  const truncated = diff.length > 6000 ? `${diff.slice(0, 6000)}\n...（diff 过长已截断）` : diff
  const sections = [numstat.trim(), truncated.trim()].filter(Boolean)
  return sections.join('\n\n')
}

export async function suggestCommitMessage(cwd: string): Promise<GitSuggestMessageResult> {
  const root = resolveCwd(cwd)
  try {
    interface Group {
      added: Set<string>
      modified: Set<string>
      deleted: Set<string>
    }
    const group: Group = { added: new Set(), modified: new Set(), deleted: new Set() }

    // 优先暂存区；为空回退工作区（worktree vs index + 未跟踪清单）
    let scopeOut = await runGit(root, ['diff', '--cached', '--name-status']).catch(() => '')
    let scope: 'staged' | 'worktree' = 'staged'
    if (!scopeOut.trim()) {
      scope = 'worktree'
      scopeOut = await runGit(root, ['diff', '--name-status']).catch(() => '')
      const untracked = await runGit(root, ['ls-files', '--others', '--exclude-standard']).catch(() => '')
      for (const line of untracked.split('\n')) {
        const p = line.trim()
        if (p) group.added.add(p)
      }
    }
    for (const line of scopeOut.split('\n')) {
      if (!line.trim()) continue
      const cols = line.split('\t')
      const code = cols[0] ?? ''
      const p = cols[cols.length - 1]?.trim()
      if (!p) continue
      if (code.startsWith('A')) group.added.add(p)
      else if (code.startsWith('D')) group.deleted.add(p)
      else group.modified.add(p)
    }

    const total = group.added.size + group.modified.size + group.deleted.size
    if (total === 0) {
      return { success: false, error: '暂存区与工作区都没有可总结的改动。' }
    }

    // 主要目录：出现频次最高的一级/二级目录
    const allPaths = [...group.added, ...group.modified, ...group.deleted]
    const dirCount = new Map<string, number>()
    for (const p of allPaths) {
      const parts = p.split('/')
      const key = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : ''
      dirCount.set(key, (dirCount.get(key) ?? 0) + 1)
    }
    const mainDir = [...dirCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''

    const parts: string[] = []
    if (group.added.size > 0) parts.push(`新增 ${group.added.size} 个文件`)
    if (group.modified.size > 0) parts.push(`更新 ${group.modified.size} 个文件`)
    if (group.deleted.size > 0) parts.push(`删除 ${group.deleted.size} 个文件`)
    const scopePrefix = scope === 'staged' ? '' : ''
    const where = mainDir ? `${mainDir} 相关` : ''
    const message = `${scopePrefix}chore: ${parts.join('，')}（${where || '工作区'}）`
    const aiContext = await collectAiContext(root, scope === 'staged')
    return { success: true, message, aiContext }
  } catch (error) {
    return fail(error)
  }
}

// ==================== 远程 ====================

/** 远程操作的统一错误归一：SSH 口令 → errorCode；其余 → 中文文案 */
function remoteFail(error: unknown): GitResult {
  if (isSshPassphraseFailure(error)) return { success: false, ...SSH_PASSPHRASE_HINT }
  return fail(error)
}

export async function fetchRemote(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['fetch', '--all', '--prune'])
    return { success: true }
  } catch (error) {
    return remoteFail(error)
  }
}

export async function pull(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['pull'])
    return { success: true }
  } catch (error) {
    if (isDivergentFailure(error)) return { success: false, ...DIVERGENT_HINT }
    return remoteFail(error)
  }
}

/** 本地与上游的分叉提交数（选择合并方式弹窗的差距展示） */
export async function divergence(cwd: string): Promise<GitDivergenceResult> {
  const root = resolveCwd(cwd)
  try {
    const out = await runGit(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
    const match = /(\d+)\s+(\d+)/.exec(out)
    return { success: true, ahead: Number(match?.[1] ?? 0), behind: Number(match?.[2] ?? 0) }
  } catch (error) {
    return remoteFail(error)
  }
}

/** pull 策略执行；remember 时把选择写进 pull.rebase 配置（失败仅忽略，不影响拉取） */
async function runPullWithStrategy(cwd: string, args: string[], remember: boolean, rebase: boolean): Promise<GitResult> {
  try {
    await runGit(cwd, args)
    if (remember) {
      await runGit(cwd, ['config', 'pull.rebase', rebase ? 'true' : 'false']).catch(() => undefined)
    }
    return { success: true }
  } catch (error) {
    if (isDivergentFailure(error)) return { success: false, ...DIVERGENT_HINT }
    return remoteFail(error)
  }
}

export async function pullMerge(cwd: string, remember: boolean): Promise<GitResult> {
  return runPullWithStrategy(resolveCwd(cwd), ['pull', '--no-rebase'], remember, false)
}

export async function pullRebaseWithChoice(cwd: string, remember: boolean): Promise<GitResult> {
  return runPullWithStrategy(resolveCwd(cwd), ['pull', '--rebase'], remember, true)
}

export async function pullRebase(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['pull', '--rebase'])
    return { success: true }
  } catch (error) {
    if (isDivergentFailure(error)) return { success: false, ...DIVERGENT_HINT }
    return remoteFail(error)
  }
}

export async function push(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    try {
      await runGit(root, ['push'])
    } catch (error) {
      // 无上游：自动 push -u origin <当前分支>
      if (/no upstream|has no upstream|set-upstream/i.test(toMessage(error))) {
        const branch = (await runGit(root, ['branch', '--show-current'])).trim()
        if (!branch) throw error
        await runGit(root, ['push', '-u', 'origin', branch])
      } else {
        throw error
      }
    }
    return { success: true }
  } catch (error) {
    return remoteFail(error)
  }
}

/** 同步：pull 后 push */
export async function sync(cwd: string): Promise<GitResult> {
  const pullResult = await pull(cwd)
  if (!pullResult.success) return pullResult
  return push(cwd)
}

export async function pushForce(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['push', '--force-with-lease'])
    return { success: true }
  } catch (error) {
    return remoteFail(error)
  }
}

export async function pushTags(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['push', '--tags'])
    return { success: true }
  } catch (error) {
    return remoteFail(error)
  }
}

export async function pushTag(cwd: string, name: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['push', 'origin', `refs/tags/${name}`])
    return { success: true }
  } catch (error) {
    return remoteFail(error)
  }
}

export async function pullFrom(cwd: string, remote: string, branch: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['pull', remote, branch])
    return { success: true }
  } catch (error) {
    if (isDivergentFailure(error)) return { success: false, ...DIVERGENT_HINT }
    return remoteFail(error)
  }
}

export async function pushTo(cwd: string, remote: string, branch?: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const target = branch?.trim() || (await runGit(root, ['branch', '--show-current'])).trim()
    if (!target) return { success: false, error: '当前不在任何分支上，无法推送。' }
    await runGit(root, ['push', remote, target])
    return { success: true }
  } catch (error) {
    return remoteFail(error)
  }
}

/** 解析 for-each-ref 的分支列表（tab 分隔；跳过 origin/HEAD 这类符号引用） */
function parseRefList(out: string, withHead: boolean): { branches: string[]; infos: GitRemoteBranchInfo[]; current?: string } {
  const branches: string[] = []
  const infos: GitRemoteBranchInfo[] = []
  let current: string | undefined
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    if (withHead) {
      const [head, name, hash, subject, author, date] = cols
      if (!name) continue
      if (head === '*') current = name
      branches.push(name)
      infos.push({ name, hash: hash ?? '', subject: subject ?? '', author: author ?? '', date: date ?? '' })
    } else {
      const [name, hash, subject, author, date] = cols
      if (!name || name.endsWith('/HEAD')) continue
      branches.push(name)
      infos.push({ name, hash: hash ?? '', subject: subject ?? '', author: author ?? '', date: date ?? '' })
    }
  }
  return { branches, infos, current }
}

const REF_FORMAT = '%(refname:short)%09%(objectname:short)%09%(subject)%09%(authorname)%09%(committerdate:iso-strict)'

export async function listBranches(cwd: string): Promise<GitBranchListResult> {
  const root = resolveCwd(cwd)
  try {
    const out = await runGit(root, [
      'for-each-ref',
      'refs/heads',
      `--format=%(HEAD)%09${REF_FORMAT}`,
      '--sort=-committerdate'
    ])
    const { branches, infos, current } = parseRefList(out, true)
    return { success: true, branches, current, infos }
  } catch (error) {
    return fail(error)
  }
}

export async function listRemoteBranches(cwd: string): Promise<GitRemoteBranchListResult> {
  const root = resolveCwd(cwd)
  try {
    const out = await runGit(root, [
      'for-each-ref',
      'refs/remotes',
      `--format=${REF_FORMAT}`,
      '--sort=-committerdate'
    ])
    const { branches, infos } = parseRefList(out, false)
    return { success: true, branches, infos }
  } catch (error) {
    return fail(error)
  }
}

export async function deleteRemoteBranch(cwd: string, remote: string, branch: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['push', remote, '--delete', branch])
    return { success: true }
  } catch (error) {
    return remoteFail(error)
  }
}

export async function deleteRemoteTag(cwd: string, name: string, remote?: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['push', remote?.trim() || 'origin', '--delete', 'tag', name])
    return { success: true }
  } catch (error) {
    return remoteFail(error)
  }
}

export async function listRemotes(cwd: string): Promise<GitRemoteListResult> {
  const root = resolveCwd(cwd)
  try {
    const out = await runGit(root, ['remote', '-v'])
    const remotes = new Map<string, string>()
    for (const line of out.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
      if (match && !remotes.has(match[1])) remotes.set(match[1], match[2])
    }
    return { success: true, remotes: [...remotes.entries()].map(([name, url]) => ({ name, url })) }
  } catch (error) {
    return fail(error)
  }
}

export async function addRemote(cwd: string, name: string, url: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['remote', 'add', name, url])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function removeRemote(cwd: string, name: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['remote', 'remove', name])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

// ==================== 分支操作 ====================

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(cwd, ['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

/**
 * 切换分支。origin/xxx 形式：本地没有同名分支时 `checkout --track`，
 * 已有则直接切本地分支。
 */
export async function checkout(cwd: string, branch: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    if (branch.includes('/') && (await refExists(root, `refs/remotes/${branch}`))) {
      const localName = branch.split('/').slice(1).join('/')
      if (await refExists(root, `refs/heads/${localName}`)) {
        await runGit(root, ['checkout', localName])
      } else {
        await runGit(root, ['checkout', '--track', branch])
      }
    } else {
      await runGit(root, ['checkout', branch])
    }
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function createBranch(cwd: string, name: string, startPoint?: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const args = ['checkout', '-b', name]
    if (startPoint?.trim()) args.push(startPoint.trim())
    await runGit(root, args)
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function deleteBranch(cwd: string, name: string, force?: boolean): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['branch', force ? '-D' : '-d', name])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function renameBranch(cwd: string, oldName: string, newName: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['branch', '-m', oldName, newName])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** 发布当前分支到 origin 并建立追踪（push -u） */
export async function publishBranch(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const branch = (await runGit(root, ['branch', '--show-current'])).trim()
    if (!branch) return { success: false, error: '当前不在任何分支上，无法发布。' }
    await runGit(root, ['push', '-u', 'origin', branch])
    return { success: true }
  } catch (error) {
    return remoteFail(error)
  }
}

// ==================== merge / rebase / cherry-pick / revert ====================

export async function merge(cwd: string, ref: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['merge', ref])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function mergeAbort(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['merge', '--abort'])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function rebase(cwd: string, ref: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['rebase', ref])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function rebaseAbort(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['rebase', '--abort'])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function cherryPick(cwd: string, hash: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['cherry-pick', hash])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function cherryPickAbort(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['cherry-pick', '--abort'])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function revertCommit(cwd: string, hash: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['revert', '--no-edit', hash])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

// ==================== 存储（Stash） ====================

export async function listStashes(cwd: string): Promise<GitStashListResult> {
  const root = resolveCwd(cwd)
  try {
    const out = await runGit(root, ['stash', 'list', '--format=%gd%x09%H%x09%gs%x09%aI'])
    const stashes: GitStashEntry[] = []
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const [ref, hash, subject, date] = line.split('\t')
      const indexMatch = /(\d+)/.exec(ref ?? '')
      if (!indexMatch) continue
      stashes.push({
        index: Number(indexMatch[1]),
        hash: hash ?? '',
        message: subject ?? '',
        date: date || undefined
      })
    }
    return { success: true, stashes }
  } catch (error) {
    return fail(error)
  }
}

export async function stashPush(cwd: string, message?: string, includeUntracked?: boolean): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const args = ['stash', 'push']
    if (includeUntracked) args.push('-u')
    if (message?.trim()) args.push('-m', message.trim())
    await runGit(root, args)
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** 仅储藏已暂存的改动（stash push --staged，需 git ≥ 2.35） */
export async function stashPushStaged(cwd: string, message?: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const args = ['stash', 'push', '--staged']
    if (message?.trim()) args.push('-m', message.trim())
    await runGit(root, args)
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function stashPop(cwd: string, index?: number): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const args = ['stash', 'pop']
    if (typeof index === 'number') args.push(`stash@{${index}}`)
    await runGit(root, args)
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function stashApply(cwd: string, index?: number): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const args = ['stash', 'apply']
    if (typeof index === 'number') args.push(`stash@{${index}}`)
    await runGit(root, args)
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function stashDrop(cwd: string, index: number): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['stash', 'drop', `stash@{${index}}`])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** 批量删除：按索引降序逐条 drop（大索引先删，避免重排位），失败不中断最后汇总 */
export async function stashDropBatch(cwd: string, indexes: number[]): Promise<GitResult> {
  const root = resolveCwd(cwd)
  const sorted = [...new Set(indexes)].sort((a, b) => b - a)
  const failed: number[] = []
  let lastError = ''
  for (const index of sorted) {
    try {
      await runGit(root, ['stash', 'drop', `stash@{${index}}`])
    } catch (error) {
      failed.push(index)
      lastError = toFriendlyMessage(error)
    }
  }
  if (failed.length > 0) {
    return {
      success: false,
      error: `部分删除失败（${failed.map((i) => `stash@{${i}}`).join('、')}）：${lastError}`
    }
  }
  return { success: true }
}

export async function stashClear(cwd: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['stash', 'clear'])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

/** 查看 stash 的完整 diff（git stash show -p） */
export async function stashShow(cwd: string, index: number): Promise<GitHeadFileResult> {
  const root = resolveCwd(cwd)
  try {
    const content = await runGit(root, ['stash', 'show', '-p', `stash@{${index}}`])
    return { success: true, content }
  } catch (error) {
    return fail(error)
  }
}

/** 查看 stash 涉及的文件清单（git stash show --name-only） */
export async function stashShowFiles(cwd: string, index: number): Promise<GitHeadFileResult> {
  const root = resolveCwd(cwd)
  try {
    const content = await runGit(root, ['stash', 'show', '--name-only', `stash@{${index}}`])
    return { success: true, content }
  } catch (error) {
    return fail(error)
  }
}

// ==================== 标记（Tag） ====================

export async function listTags(cwd: string): Promise<GitTagListResult> {
  const root = resolveCwd(cwd)
  try {
    const out = await runGit(root, ['tag', '--list'])
    const tags = out.split('\n').map((l) => l.trim()).filter(Boolean)
    return { success: true, tags }
  } catch (error) {
    return fail(error)
  }
}

export async function createTag(cwd: string, name: string, message?: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    const args = message?.trim() ? ['tag', '-a', name, '-m', message.trim()] : ['tag', name]
    await runGit(root, args)
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

export async function deleteTag(cwd: string, name: string): Promise<GitResult> {
  const root = resolveCwd(cwd)
  try {
    await runGit(root, ['tag', '-d', name])
    return { success: true }
  } catch (error) {
    return fail(error)
  }
}

// ==================== 提交历史 ====================

/**
 * log 输出格式：提交之间用 <--ENTRY--> 分隔，正文与文件清单之间用 <--AETHER-BE--> 分隔。
 * 字段用 tab（%x09）分隔：提交标题里什么字符都可能出现，唯独 tab/换行不会出现。
 */
const BODY_MARK = '<--AETHER-BE-->'
const LOG_FORMAT = `--format=<--ENTRY-->%H%x09%h%x09%s%x09%an%x09%ad%x09%P%x09%D%n%b%n${BODY_MARK}`

/** %D 装饰串 → 结构化 refs */
function parseRefs(refsRaw: string): GitCommitRef[] {
  return refsRaw
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => ({
      name: r.replace(/^HEAD ->\s*/, '').replace(/^tag:\s*/, ''),
      type: r.startsWith('tag:')
        ? ('tag' as const)
        : r.startsWith('HEAD ->')
          ? ('head' as const)
          : /\/[^/]+$/.test(r) && !r.includes('->')
            ? ('remote' as const)
            : ('branch' as const)
    }))
}

/** 解析 log --name-status 输出（与 LOG_FORMAT 配套） */
function parseLogOutput(out: string): GitLogEntry[] {
  const commits: GitLogEntry[] = []
  for (const block of out.split('<--ENTRY-->')) {
    if (!block.trim()) continue
    const markIdx = block.indexOf(BODY_MARK)
    const headAndBody = markIdx >= 0 ? block.slice(0, markIdx) : block
    const nlIdx = headAndBody.indexOf('\n')
    const headerLine = nlIdx >= 0 ? headAndBody.slice(0, nlIdx) : headAndBody
    const header = headerLine.split('\t')
    if (header.length < 6) continue
    const [hash, shortHash, subject, author, date, parents, refsRaw] = header
    if (!hash) continue
    const body = markIdx >= 0 && nlIdx >= 0 ? headAndBody.slice(nlIdx + 1).replace(/\n+$/, '') : ''

    // 文件清单在结束标记之后（无标记则紧跟 header 行之后）
    const filesRaw = markIdx >= 0 ? block.slice(markIdx + BODY_MARK.length) : headAndBody.slice(headerLine.length)
    const fileChanges: GitCommitFileChange[] = []
    for (const line of filesRaw.split('\n')) {
      if (!line.trim()) continue
      const fields = line.split('\t')
      const code = fields[0] ?? ''
      if (/^[RC]/.test(code) && fields.length >= 3) {
        // R100/C100：去掉相似度数字，取新路径
        fileChanges.push({ code: code.replace(/\d+$/, ''), path: fields[2] })
      } else if (/^[AMDUT]$/.test(code) && fields[1]) {
        fileChanges.push({ code, path: fields[1] })
      }
    }

    const refs = parseRefs(refsRaw ?? '')
    commits.push({
      hash,
      shortHash,
      subject,
      author,
      date,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      refs: refs.length > 0 ? refs : undefined,
      fileChanges: fileChanges.length > 0 ? fileChanges : undefined,
      ...(body ? { body } : {})
    })
  }
  return commits
}

function isEmptyHistoryError(error: unknown): boolean {
  return /does not have any commits|bad default revision|unknown revision/i.test(toMessage(error))
}

/** 最近提交历史（分页 + 过滤 + refs 装饰 + name-status 文件清单） */
export async function log(cwd: string, limit?: number, skip?: number, query?: GitLogQuery): Promise<GitLogResult> {
  const root = resolveCwd(cwd)
  const count = Math.max(1, Math.min(Math.floor(limit ?? 50) || 50, 500))
  try {
    const refArgs =
      query?.refs?.includes('all') ? ['--all'] : query?.refs && query.refs.length > 0 ? query.refs : ['HEAD']
    const args = ['log', `--max-count=${count}`]
    if (skip && skip > 0) args.push(`--skip=${Math.floor(skip)}`)
    if (query?.search?.trim()) args.push(`--grep=${query.search.trim()}`, '-i', '--fixed-strings')
    if (query?.author?.trim()) args.push(`--author=${query.author.trim()}`, '-i', '--fixed-strings')
    args.push('--date=iso-strict', LOG_FORMAT, '--name-status', ...refArgs)
    const out = await runGit(root, args)
    return { success: true, commits: parseLogOutput(out) }
  } catch (error) {
    if (isEmptyHistoryError(error)) return { success: true, commits: [] }
    return fail(error)
  }
}

/** 远端领先提交列表（@{u} 可达而 HEAD 不可达）；无上游 / detached 返回空列表 */
export async function incomingLog(cwd: string, limit?: number): Promise<GitLogResult> {
  const root = resolveCwd(cwd)
  const size = Math.max(1, Math.min(Math.floor(limit ?? 50) || 50, 500))
  try {
    await runGit(root, ['rev-parse', '--verify', '--quiet', '@{u}'])
  } catch {
    return { success: true, commits: [] }
  }
  try {
    const out = await runGit(root, [
      'log',
      `--max-count=${size + 1}`,
      '--date=iso-strict',
      LOG_FORMAT,
      '--name-status',
      'HEAD..@{u}'
    ])
    const commits = parseLogOutput(out)
    return { success: true, commits: commits.slice(0, size) }
  } catch (error) {
    if (isEmptyHistoryError(error)) return { success: true, commits: [] }
    return fail(error)
  }
}

/** 单条提交详情（正文 + numstat 统计 + 文件清单） */
export async function commitShow(cwd: string, hash: string): Promise<GitCommitInfoResult> {
  const root = resolveCwd(cwd)
  try {
    const out = await runGit(root, [
      'show',
      '--no-renames',
      '--date=iso-strict',
      `--format=%H%x09%h%x09%s%x09%an%x09%ad%x09%P%x09%D%n%b%n${BODY_MARK}`,
      '--numstat',
      hash
    ])
    const markIdx = out.indexOf(BODY_MARK)
    const headAndBody = markIdx >= 0 ? out.slice(0, markIdx) : out
    const nlIdx = headAndBody.indexOf('\n')
    const header = (nlIdx >= 0 ? headAndBody.slice(0, nlIdx) : headAndBody).split('\t')
    const [fullHash, shortHash, subject, author, date, parents, refsRaw] = header
    const body = markIdx >= 0 && nlIdx >= 0 ? headAndBody.slice(nlIdx + 1).replace(/\n+$/, '') : ''

    let additions = 0
    let deletions = 0
    const fileChanges: GitCommitFileChange[] = []
    const filesRaw = markIdx >= 0 ? out.slice(markIdx + BODY_MARK.length) : ''
    for (const line of filesRaw.split('\n')) {
      if (!line.trim()) continue
      const [add, del, p] = line.split('\t')
      if (!p) continue
      additions += add === '-' ? 0 : Number(add)
      deletions += del === '-' ? 0 : Number(del)
      fileChanges.push({ code: 'M', path: p })
    }

    const refs = parseRefs(refsRaw ?? '')
    return {
      success: true,
      commit: {
        hash: fullHash,
        shortHash,
        subject,
        author,
        date,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        body,
        additions,
        deletions,
        fileChanges,
        refs: refs.length > 0 ? refs : undefined
      }
    }
  } catch (error) {
    return fail(error)
  }
}

/** 读取指定提交版本的文件内容；文件在该提交不存在时返回空串 */
export async function showCommitFile(cwd: string, hash: string, filePath: string): Promise<GitHeadFileResult> {
  const root = resolveCwd(cwd)
  try {
    const content = await runGit(root, ['show', `${hash}:${filePath}`])
    return { success: true, content }
  } catch (error) {
    if (/does not exist in|exists on disk, but not in/i.test(toMessage(error))) {
      return { success: true, content: '' }
    }
    return fail(error)
  }
}

/**
 * 单文件提交历史（Timeline 数据源）：--follow 跨重命名追溯。
 * 分页用「上一页最后一条的哈希」作 cursor，多取一条判断 hasMore。
 * 重命名跟踪游标：每块内在 name-status 行里找当前路径，命中 R/C 时游标换成旧路径继续向上追。
 */
export async function fileHistory(cwd: string, filePath: string, limit?: number, cursor?: string): Promise<GitFileHistoryResult> {
  const root = resolveCwd(cwd)
  const rel = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  const size = Math.max(1, Math.min(Math.floor(limit ?? 50) || 50, 200))
  try {
    const out = await runGit(root, [
      'log',
      `--max-count=${size + 1}`,
      cursor?.trim() || 'HEAD',
      '--follow',
      '--date=iso-strict',
      `--format=<--ENTRY-->%H%x09%h%x09%s%x09%aN%x09%cd%x09%P%x09%D%n%b%n${BODY_MARK}`,
      '--name-status',
      '--',
      rel
    ])

    let trailKey = rel.toLowerCase()
    const entries: GitFileHistoryEntry[] = []
    for (const block of out.split('<--ENTRY-->')) {
      if (!block.trim()) continue
      const markIdx = block.indexOf(BODY_MARK)
      const headAndBody = markIdx >= 0 ? block.slice(0, markIdx) : block
      const nlIdx = headAndBody.indexOf('\n')
      const header = (nlIdx >= 0 ? headAndBody.slice(0, nlIdx) : headAndBody).split('\t')
      if (header.length < 6) continue
      const [hash, shortHash, subject, author, date, parents, refsRaw] = header
      const body = markIdx >= 0 && nlIdx >= 0 ? headAndBody.slice(nlIdx + 1).replace(/\n+$/, '') : ''

      const filesRaw = markIdx >= 0 ? block.slice(markIdx + BODY_MARK.length) : headAndBody.slice(nlIdx + 1)
      const lines = filesRaw.split('\n').filter((l) => l.trim())
      let changeCode = 'M'
      let changePath = rel
      let matched = false
      for (const line of lines) {
        const fields = line.split('\t')
        const code = (fields[0] ?? '').replace(/\d+$/, '')
        if (/^[RC]/.test(code) && fields.length >= 3) {
          if (fields[2].replace(/\\/g, '/').toLowerCase() === trailKey) {
            changeCode = code
            changePath = fields[2]
            trailKey = fields[1].replace(/\\/g, '/').toLowerCase()
            matched = true
            break
          }
        } else if (fields[1] && fields[1].replace(/\\/g, '/').toLowerCase() === trailKey) {
          changeCode = code || 'M'
          changePath = fields[1]
          matched = true
          break
        }
      }
      // 兜底：该提交只动一个文件但没匹配上（大小写不一致等），直接用这一行
      if (!matched && lines.length === 1) {
        const fields = lines[0].split('\t')
        const code = (fields[0] ?? '').replace(/\d+$/, '')
        if (/^[RC]/.test(code) && fields.length >= 3) {
          changeCode = code
          changePath = fields[2]
          trailKey = fields[1].replace(/\\/g, '/').toLowerCase()
        } else if (fields[1]) {
          changeCode = code || 'M'
          changePath = fields[1]
        }
      }

      const refs = parseRefs(refsRaw ?? '')
      entries.push({
        hash,
        shortHash,
        subject,
        ...(body ? { body } : {}),
        author,
        date,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        changeCode,
        changePath,
        refs: refs.length > 0 ? refs : undefined
      })
    }

    const hasMore = entries.length > size
    return { success: true, entries: entries.slice(0, size), hasMore }
  } catch (error) {
    if (isEmptyHistoryError(error) || /does not exist|no such path/i.test(toMessage(error))) {
      return { success: true, entries: [], hasMore: false }
    }
    return fail(error)
  }
}

/** 解析 blame --line-porcelain：块尾是 tab 开头的内容行，此时落盘该行归属 */
function parseBlamePorcelain(out: string): GitBlameLine[] {
  const lines: GitBlameLine[] = []
  let pendingLine = 0
  let hash = ''
  let shortHash = ''
  let author = ''
  let date = ''
  let subject = ''
  let boundary = false

  const flush = (lineNo: number): void => {
    if (lineNo <= 0) return
    lines[lineNo - 1] = {
      hash,
      shortHash,
      author,
      date,
      subject,
      ...(boundary ? { boundary: true } : {})
    }
  }

  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line) continue
    if (line.startsWith('\t')) {
      flush(pendingLine)
      continue
    }
    const headerMatch = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line)
    if (headerMatch) {
      hash = headerMatch[1]
      shortHash = hash.slice(0, 8)
      author = ''
      date = ''
      subject = ''
      boundary = false
      pendingLine = Number(headerMatch[2])
      continue
    }
    if (line === 'boundary') {
      boundary = true
      continue
    }
    if (line.startsWith('previous ')) continue
    const sep = line.indexOf(' ')
    if (sep < 0) continue
    const key = line.slice(0, sep)
    const value = line.slice(sep + 1)
    if (key === 'author') author = value
    else if (key === 'summary') subject = value
    else if (key === 'author-time') date = new Date(Number(value) * 1000).toISOString()
    // 刻意不读 filename 字段，避免中文路径 C 引号转义问题
  }
  return lines
}

/** 整文件行级 blame；未跟踪 / 二进制 / 超大文件静默返回空（调用方不展示） */
export async function blame(cwd: string, filePath: string): Promise<GitBlameResult> {
  const root = resolveCwd(cwd)
  const rel = filePath.replace(/\\/g, '/')
  let head = ''
  try {
    head = (await runGit(root, ['rev-parse', 'HEAD'])).trim()
  } catch {
    return { success: true, lines: [] }
  }
  try {
    const sizeText = (await runGit(root, ['cat-file', '-s', `HEAD:${rel}`])).trim()
    if (Number(sizeText) > BLAME_MAX_FILE_BYTES) {
      return { success: true, head, lines: [] }
    }
  } catch {
    return { success: true, head, lines: [] }
  }
  try {
    const out = await runGit(root, ['blame', '--line-porcelain', 'HEAD', '--', rel])
    return { success: true, head, lines: parseBlamePorcelain(out) }
  } catch (error) {
    if (/no such path|does not have any commits|bad default revision|unknown revision|does not exist|is binary|fatal: empty ident/i.test(toMessage(error))) {
      return { success: true, head, lines: [] }
    }
    return fail(error)
  }
}

// ==================== 用户 ====================

export async function getUserName(cwd: string): Promise<GitUserResult> {
  const root = resolveCwd(cwd)
  const [name, email] = await Promise.all([
    runGit(root, ['config', 'user.name']).catch(() => ''),
    runGit(root, ['config', 'user.email']).catch(() => '')
  ])
  return {
    success: true,
    name: name.trim() || undefined,
    email: email.trim() || undefined
  }
}

/** 提交历史去重后的作者名（按提交频次降序 + 名称排序） */
export async function listAuthors(cwd: string): Promise<GitUserListResult> {
  const root = resolveCwd(cwd)
  try {
    const out = await runGit(root, ['log', 'HEAD', '--format=%an'])
    const counts = new Map<string, number>()
    for (const line of out.split('\n')) {
      const name = line.trim()
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const authors = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name)
    return { success: true, authors }
  } catch (error) {
    if (isEmptyHistoryError(error)) return { success: true, authors: [] }
    return fail(error)
  }
}

// ---------- 兼容旧通道（git:status/log 旧契约已废弃，保留导出避免误用） ----------
// 旧版 GitStatus/GitCommit 视图由渲染层用 status() + branchInfo() + log() 自行组装。
