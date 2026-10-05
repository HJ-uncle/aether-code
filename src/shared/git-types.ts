/**
 * Git 面板共享类型契约（主进程 / preload / 渲染层三方共用）
 *
 * 移植自 wuzu-client 的 src/types/codeGit.ts：字段结构对齐真实
 * `git status --porcelain=v2` 与 unified diff 输出。
 *
 * 关键约束：
 * - 所有接口返回值遵循 `{ success, error?, errorCode? }` 标准信封，
 *   面板据此给用户出路（而不是靠解析中文文案）
 * - 本文件不得引入任何 electron / node 依赖，保证三个进程均可引用
 */

// ==================== 变更状态 ====================

/** 单个文件的变更类型（对齐 git porcelain 的 XY 状态码语义） */
export type GitChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked'

/** 变更文件条目 */
export interface GitFileChange {
  /** 相对工程根的 POSIX 风格路径 */
  path: string
  /** 重命名/复制场景下的原路径 */
  oldPath?: string
  /**
   * 变更类型（工作区视角优先）。
   * 便捷字段，仅用于按 path 取单值的装饰场景；
   * 分组（暂存 vs 更改）请用 stagedChange / unstagedChange 分别判断，
   * 一个文件可能同时具备两者（git 的 MM 状态）。
   */
  changeType: GitChangeType
  /** 是否已进入暂存区（暂存区有改动即为 true） */
  staged: boolean
  /** 暂存区变更类型（porcelain X 列），null/缺省表示暂存区无改动 */
  stagedChange?: GitChangeType | null
  /** 工作区变更类型（porcelain Y 列），null/缺省表示工作区无改动；未跟踪文件为 'untracked' */
  unstagedChange?: GitChangeType | null
  /** 是否为合并冲突状态（porcelain `u` 行，XY 为 UU/AA/DD/AU/UA/DU/UD） */
  conflict?: boolean
  /** 是否为二进制文件（二进制不提供 diff） */
  binary: boolean
  /** 新增行数（暂存 + 工作区合计） */
  additions: number
  /** 删除行数（暂存 + 工作区合计） */
  deletions: number
  /** 暂存区增删行数（index vs HEAD） */
  stagedAdditions?: number
  stagedDeletions?: number
  /** 工作区增删行数（worktree vs index） */
  unstagedAdditions?: number
  unstagedDeletions?: number
}

// ==================== Diff ====================

/** diff 行类型 */
export type GitDiffLineType = 'context' | 'add' | 'delete'

/** diff 单行 */
export interface GitDiffLine {
  type: GitDiffLineType
  /** 旧文件行号，新增行为 null */
  oldLineNumber: number | null
  /** 新文件行号，删除行为 null */
  newLineNumber: number | null
  /** 行内容（不含前导 +/-/空格） */
  content: string
}

/** diff 变更块 */
export interface GitHunk {
  /** 稳定标识，用于 hunk 级操作 */
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** 实时 diff 的原文末尾换行信息，供末尾变更撤销时恢复 */
  originalEndsWithEol?: boolean
  /** hunk 头部的上下文标注（如函数签名） */
  heading?: string
  lines: GitDiffLine[]
}

/** 单文件完整 diff */
export interface GitFileDiff {
  path: string
  oldPath?: string
  changeType: GitChangeType
  binary: boolean
  /** 修改前全文，新增文件为空串 */
  oldContent: string
  /** 修改后全文，删除文件为空串 */
  newContent: string
  hunks: GitHunk[]
}

// ==================== 分支 ====================

/** 分支与远端同步状态 */
export interface GitBranchInfo {
  branch: string
  /** 无上游分支时为 null */
  upstream: string | null
  /** 领先远端的提交数，无上游时为 null */
  ahead: number | null
  /** 落后远端的提交数，无上游时为 null */
  behind: number | null
}

// ==================== 接口返回 ====================

/** 失败归类：渲染层据此决定给用户哪条出路，不依赖中文文案做判断 */
export type GitErrorCode = 'ssh-passphrase' | 'divergent' | 'clone-cancelled'

/** 所有 Git 接口的公共返回字段 */
export interface GitResult {
  success: boolean
  error?: string
  /** 仅失败时可能有值 */
  errorCode?: GitErrorCode
  /**
   * 实际进入暂存区的路径（仅批量暂存返回）。
   *
   * `git add` 对匹配不到任何文件的 pathspec 会整批 fatal，调用方传入的候选路径
   * 可能含已不存在的临时文件，后端会先收窄到 git 认得的子集，
   * 这里回传收窄后的真实结果供调用方记账。
   */
  stagedPaths?: string[]
  /** 成功但部分步骤被跳过时的补充说明，调用方应展示给用户 */
  notice?: string
}

/** 本地与上游的分叉计数，供「选择合并方式」弹窗展示 */
export interface GitDivergenceResult extends GitResult {
  /** 本地有、远端没有的提交数 */
  ahead?: number
  /** 远端有、本地没有的提交数 */
  behind?: number
}

export interface GitStatusResult extends GitResult {
  /** 当前目录是否为 Git 仓库 */
  isRepo?: boolean
  files?: GitFileChange[]
  /** 是否处于合并中（.git/MERGE_HEAD 存在） */
  merging?: boolean
  /** 合并中时 git 自动写入的提交信息（.git/MERGE_MSG 正文，已去除 # 注释行） */
  mergeMessage?: string
}

/** 忽略状态查询结果 */
export interface GitIgnoreCheckResult extends GitResult {
  /**
   * 各路径是否被 .gitignore 忽略，key 为传入的相对路径原文。
   * 查询失败时缺省，调用方按「未忽略」处理。
   */
  ignored?: Record<string, boolean>
}

export interface GitDiffResult extends GitResult {
  diff?: GitFileDiff
}

export interface GitBranchInfoResult extends GitResult {
  isRepo?: boolean
  info?: GitBranchInfo
}

/** HEAD 文件内容查询结果（编辑器实时 diff 基准） */
export interface GitHeadFileResult extends GitResult {
  /** HEAD 版本内容；未跟踪文件为空串 */
  content?: string
}

/** 本地分支列表查询结果 */
export interface GitBranchListResult extends GitResult {
  branches?: string[]
  current?: string
  /** 各分支最新提交元信息，按最新提交时间倒序 */
  infos?: GitRemoteBranchInfo[]
}

/** 提交信息建议结果（AI 生成失败时回退本地启发式；aiContext 供渲染层再喂给 LLM） */
export interface GitSuggestMessageResult extends GitResult {
  message?: string
  /** 供 AI 生成提交信息的统计、完整文件清单和头尾 diff 片段；无改动时为空 */
  aiContext?: string
}

// ==================== 存储（Stash） ====================

/** 单条 stash 记录 */
export interface GitStashEntry {
  /** 序号（stash@{N} 中的 N） */
  index: number
  /** 提交哈希 */
  hash: string
  /** 描述信息（含 stash 时填的 message 或默认 WIP 文本） */
  message: string
  /** 创建时间（ISO 8601，来自 git 的 %aI） */
  date?: string
}

export interface GitStashListResult extends GitResult {
  stashes?: GitStashEntry[]
}

// ==================== 标记（Tag） ====================

export interface GitTagListResult extends GitResult {
  tags?: string[]
}

// ==================== 远程 ====================

/** 单个远程仓库 */
export interface GitRemote {
  name: string
  url: string
}

export interface GitRemoteListResult extends GitResult {
  remotes?: GitRemote[]
}

/** 远程分支最新提交元信息（选择列表展示用） */
export interface GitRemoteBranchInfo {
  /** 分支名（origin/xxx 形式） */
  name: string
  /** 最新提交短哈希 */
  hash: string
  /** 最新提交说明（首行） */
  subject: string
  /** 最新提交作者 */
  author: string
  /** 最新提交时间（ISO） */
  date: string
}

/** 远程分支（origin/xxx 形式） */
export interface GitRemoteBranchListResult extends GitResult {
  branches?: string[]
  /** 各分支最新提交元信息，按最新提交时间倒序 */
  infos?: GitRemoteBranchInfo[]
}

// ==================== 克隆（Clone） ====================

/** 克隆请求：url 为渲染层原始输入（容忍整条 `git clone <url>` 命令，主进程负责清洗） */
export interface GitCloneOptions {
  url: string
  /** 克隆目标父目录（系统目录选择框返回值） */
  parentDir: string
}

/** 克隆进度推送 payload（git:clone-progress 事件） */
export interface GitCloneProgressPayload {
  /** 活跃克隆标识，取消与进度过滤均按它匹配 */
  cloneId: string
  /** 0-100，只前进不回退（Counting/Compressing/Receiving/Resolving 加权合成） */
  percentage: number
  /** 最后一条原始进度行，如 Receiving objects: 55% (1100/2000) */
  message: string
}

export interface GitCloneResult extends GitResult {
  /** 实际克隆到的目录（重名已做 -1/-2 去重），成功时必有 */
  finalPath?: string
}

// ==================== 提交历史 ====================

/** 指向提交的引用（分支/标签/HEAD 装饰） */
export interface GitCommitRef {
  /** ref 名称（如 main、origin/dev、v1.0.0） */
  name: string
  /** head = 当前检出的本地分支；remote = 远程分支；tag = 标签；branch = 其他本地分支 */
  type: 'head' | 'remote' | 'tag' | 'branch'
}

/** 提交涉及的文件（--name-status） */
export interface GitCommitFileChange {
  /** A/M/D/R/C/U/T */
  code: string
  path: string
}

/** 单条提交记录 */
export interface GitLogEntry {
  hash: string
  shortHash: string
  /** 提交信息首行 */
  subject: string
  /** 提交正文（首行之后的部分，多行；无则为空） */
  body?: string
  author: string
  /** ISO 时间字符串 */
  date: string
  /** 父提交哈希（merge 有多个） */
  parents?: string[]
  /** 指向此提交的分支/标签装饰 */
  refs?: GitCommitRef[]
  /** 该提交涉及的文件（log --name-status 顺带返回） */
  fileChanges?: GitCommitFileChange[]
}

export interface GitLogResult extends GitResult {
  commits?: GitLogEntry[]
}

/** 提交历史过滤条件（对齐 VSCode scmHistory 的 filterText / author / refs） */
export interface GitLogQuery {
  /** 按提交信息首行模糊过滤（git --grep） */
  search?: string
  /** 按作者名称过滤（git --author） */
  author?: string
  /**
   * 要展示的引用（分支 / 远程分支 / 标签）。
   * 传 ['all'] 走 git --all；传具体 ref 名只展示该引用可达的提交；
   * 为空时默认仅当前检出分支（HEAD）。
   */
  refs?: string[]
}

/**
 * 时间线条目（资源管理器 Timeline）。
 *
 * 一条 = 一次改动了该文件的提交，额外带该提交对此文件的变更类型（A/M/D/R）。
 */
export interface GitFileHistoryEntry {
  hash: string
  shortHash: string
  /** 提交信息首行 */
  subject: string
  /** 提交正文（首行之后的多行部分，无则为空） */
  body?: string
  /** 作者名 */
  author: string
  /** ISO 时间字符串（commit date） */
  date: string
  /** 父提交哈希：用它取「上一版本」做 diff 左半边 */
  parents: string[]
  /** 该提交对此文件的变更类型码：A / M / D / R / C / T */
  changeCode: string
  /** 该提交时的文件路径（重命名场景与当前路径不同，用于 git show <hash>:<path>） */
  changePath: string
  /** 指向此提交的分支/标签装饰 */
  refs?: GitCommitRef[]
}

export interface GitFileHistoryResult extends GitResult {
  entries?: GitFileHistoryEntry[]
  /** 是否还有更早的历史（服务端按多取一条判断） */
  hasMore?: boolean
}

/**
 * 行级 blame 信息（编辑器行内标注）。
 *
 * 一次请求返回整文件所有行，前端按 `lines[row - 1]` 取光标所在行的归属。
 */
export interface GitBlameLine {
  /** 该行所属提交 */
  hash: string
  shortHash: string
  /** 作者名 */
  author: string
  /** ISO 时间字符串（author-time） */
  date: string
  /** 提交信息首行 */
  subject: string
  /** 该提交为边界提交（文件首次引入，无父可追溯） */
  boundary?: boolean
}

export interface GitBlameResult extends GitResult {
  /** blame 时的 HEAD，供渲染层判定缓存是否过期 */
  head?: string
  /** 按行号索引：lines[row - 1] 对应该行归属 */
  lines?: GitBlameLine[]
}

/** 当前 Git 用户身份（user.name / user.email） */
export interface GitUserResult extends GitResult {
  name?: string
  email?: string
}

/** 提交历史去重后的作者名列表（作者过滤下拉数据源） */
export interface GitUserListResult extends GitResult {
  authors?: string[]
}

/** 单条提交完整信息（详情弹窗用） */
export interface GitCommitInfo {
  hash: string
  shortHash: string
  subject: string
  author: string
  /** ISO 时间字符串 */
  date: string
  parents: string[]
  /** 提交正文（首行之后的部分） */
  body: string
  additions: number
  deletions: number
  fileChanges: GitCommitFileChange[]
  /** 指向此提交的分支/标签装饰 */
  refs?: GitCommitRef[]
}

export interface GitCommitInfoResult extends GitResult {
  commit?: GitCommitInfo
}
