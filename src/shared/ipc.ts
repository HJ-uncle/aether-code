/**
 * 主进程 ↔ 渲染进程 共享契约
 *
 * 这里是唯一的协议真相来源：IPC 通道名、载荷类型、引擎状态机。
 * 主进程与渲染进程都必须只依赖本文件，避免两侧类型漂移。
 */

// ==================== IPC 通道 ====================

export const IPC = {
  /** 渲染进程 → 主进程（invoke） */
  invoke: {
    engineGetSnapshot: 'engine:get-snapshot',
    engineStart: 'engine:start',
    engineStop: 'engine:stop',
    engineRestart: 'engine:restart',
    engineGetLocalRuntimes: 'engine:get-local-runtimes',
    engineImportLocalRuntime: 'engine:import-local-runtime',
    engineActivateLocalRuntime: 'engine:activate-local-runtime',
    engineDeleteLocalRuntime: 'engine:delete-local-runtime',
    engineRequest: 'engine:request',
    engineUpload: 'engine:upload',
    engineUploadAttachment: 'engine:upload-attachment',
    engineStreamStart: 'engine:stream:start',
    engineStreamAbort: 'engine:stream:abort',
    settingsGet: 'settings:get',
    settingsUpdate: 'settings:update',
    settingsRemoteTokenStatus: 'settings:remote-token-status',
    settingsSetRemoteToken: 'settings:set-remote-token',
    settingsClearRemoteToken: 'settings:clear-remote-token',
    settingsSaveEngine: 'settings:save-engine',
    /** 文件系统（IDE 本地实现） */
    fsPickFolder: 'fs:pick-folder',
    fsAllowRoot: 'fs:allow-root',
    fsReadDir: 'fs:read-dir',
    fsReadFile: 'fs:read-file',
    fsWriteFile: 'fs:write-file',
    fsCreateFile: 'fs:create-file',
    fsCreateFolder: 'fs:create-folder',
    fsRename: 'fs:rename',
    /** 复制文件/目录到新位置（资源管理器的「粘贴」用；目录需递归） */
    fsCopy: 'fs:copy',
    fsTrash: 'fs:trash',
    fsStat: 'fs:stat',
    fsReveal: 'fs:reveal',
    fsWatchDocuments: 'fs:watch-documents',
    /** 递归列出工作区全部文件（快速打开 Ctrl+P 用，跳过依赖/构建目录） */
    fsListAll: 'fs:list-all',
    /** 复制本地文件到工作区（聊天附件用：File 对象出于安全拿不到真实路径，只能走字节流） */
    fsCopyIntoWorkspace: 'fs:copy-into-workspace',
    /** 版本控制（IDE 自己跑 git；全部返回 { success, error? } 信封，见 git-types.ts） */
    gitInit: 'git:init',
    gitStatus: 'git:status',
    gitDiff: 'git:diff',
    gitBranchInfo: 'git:branch-info',
    gitStage: 'git:stage',
    gitUnstage: 'git:unstage',
    gitDiscardFile: 'git:discard-file',
    gitDiscardWorktree: 'git:discard-worktree',
    gitDiscardWorktreeFiles: 'git:discard-worktree-files',
    gitStageFiles: 'git:stage-files',
    gitCheckIgnored: 'git:check-ignored',
    gitUnstageFiles: 'git:unstage-files',
    gitDiscardFiles: 'git:discard-files',
    gitHeadFile: 'git:head-file',
    gitFetch: 'git:fetch',
    gitPull: 'git:pull',
    gitPush: 'git:push',
    gitDivergence: 'git:divergence',
    gitPullMerge: 'git:pull-merge',
    gitPullRebaseChoice: 'git:pull-rebase-choice',
    gitAddSshKey: 'git:add-ssh-key',
    gitBranches: 'git:branches',
    gitCheckout: 'git:checkout',
    gitCreateBranch: 'git:create-branch',
    gitDiscardHunk: 'git:discard-hunk',
    gitCommit: 'git:commit',
    gitStageAllAndCommit: 'git:stage-all-and-commit',
    gitHeadFileContent: 'git:head-file-content',
    gitAppendGitignore: 'git:append-gitignore',
    /** 提交信息建议（本地启发式，无网络调用） */
    gitSuggestMessage: 'git:suggest-message',
    gitCommitAmend: 'git:commit-amend',
    gitCommitAmendMessage: 'git:commit-amend-message',
    gitUndoCommit: 'git:undo-commit',
    gitCommitEmpty: 'git:commit-empty',
    gitSync: 'git:sync',
    gitPullRebase: 'git:pull-rebase',
    gitPushForce: 'git:push-force',
    gitPushTags: 'git:push-tags',
    gitPushTag: 'git:push-tag',
    gitPullFrom: 'git:pull-from',
    gitPushTo: 'git:push-to',
    gitRemoteBranches: 'git:remote-branches',
    gitDeleteRemoteBranch: 'git:delete-remote-branch',
    gitDeleteRemoteTag: 'git:delete-remote-tag',
    gitDeleteBranch: 'git:delete-branch',
    gitRenameBranch: 'git:rename-branch',
    gitPublishBranch: 'git:publish-branch',
    gitMerge: 'git:merge',
    gitMergeAbort: 'git:merge-abort',
    gitRebase: 'git:rebase',
    gitRebaseAbort: 'git:rebase-abort',
    gitCherryPick: 'git:cherry-pick',
    gitCherryPickAbort: 'git:cherry-pick-abort',
    gitRevertCommit: 'git:revert-commit',
    gitRemotes: 'git:remotes',
    gitAddRemote: 'git:add-remote',
    gitRemoveRemote: 'git:remove-remote',
    gitClone: 'git:clone',
    gitCloneCancel: 'git:clone-cancel',
    gitStashList: 'git:stash-list',
    gitStashPush: 'git:stash-push',
    gitStashPushStaged: 'git:stash-push-staged',
    gitStashPop: 'git:stash-pop',
    gitStashApply: 'git:stash-apply',
    gitStashDrop: 'git:stash-drop',
    gitStashDropBatch: 'git:stash-drop-batch',
    gitStashClear: 'git:stash-clear',
    gitStashShow: 'git:stash-show',
    gitStashShowFiles: 'git:stash-show-files',
    gitTags: 'git:tags',
    gitCreateTag: 'git:create-tag',
    gitDeleteTag: 'git:delete-tag',
    gitLog: 'git:log',
    gitIncoming: 'git:incoming',
    gitCommitShow: 'git:commit-show',
    gitShowCommitFile: 'git:show-commit-file',
    gitFileHistory: 'git:file-history',
    gitBlame: 'git:blame',
    gitUserName: 'git:user-name',
    gitListAuthors: 'git:list-authors',
    /** 全局搜索（git grep 优先，非仓库退回文件遍历） */
    searchQuery: 'search:query',
    /** 全局替换（按搜索条件对命中文件批量替换） */
    searchReplace: 'search:replace',
    /** 替换预览（执行全部替换前展示 before → after） */
    searchReplacePreview: 'search:replace-preview',
    /** 终端（node-pty，单实例） */
    terminalCreate: 'terminal:create',
    terminalWrite: 'terminal:write',
    terminalResize: 'terminal:resize',
    terminalDispose: 'terminal:dispose',
    /** TS 语言服务（typescript-language-server，单实例；spawn 在主进程） */
    lspStart: 'lsp:start',
    lspStop: 'lsp:stop',
    /** 渲染进程把 JSON-RPC 消息发给语言服务（didOpen/didChange/hover 等） */
    lspSend: 'lsp:send',
    /** 窗口控制（自绘标题栏：无边框窗口下由渲染层按钮驱动） */
    windowMinimize: 'window:minimize',
    windowToggleMaximize: 'window:toggle-maximize',
    windowClose: 'window:close',
    windowIsMaximized: 'window:is-maximized'
  },
  /** 主进程 → 渲染进程（send） */
  event: {
    fsDocumentsChanged: 'fs:documents-changed',
    engineSnapshot: 'engine:snapshot',
    engineLog: 'engine:log',
    engineImportProgress: 'engine:import-progress',
    streamEvent: 'engine:stream:event',
    terminalData: 'terminal:data',
    terminalExit: 'terminal:exit',
    /** git clone 进度（GitCloneProgressPayload） */
    gitCloneProgress: 'git:clone-progress',
    /** 语言服务 → 渲染进程：stdout 解出的 JSON-RPC 消息（publishDiagnostics / hover 响应等） */
    lspMessage: 'lsp:message',
    /** 语言服务进程退出（code/signal）；渲染端据此决定是否重启或降级 */
    lspExit: 'lsp:exit'
  }
} as const

// ==================== 终端 ====================

/** 创建终端的入参：cols/rows 来自前端 xterm 尺寸，cwd 为空时用用户主目录 */
export interface TerminalCreateInput {
  cwd?: string
  cols: number
  rows: number
  /** Endpoint-local conversation identity for remote PTY sessions. */
  sessionId?: string
}

export interface TerminalExitInfo {
  id: string
  exitCode: number
  /** Optional transport reason (remote disconnect/reconnect), not a PTY stderr line. */
  reason?: string
}

export interface TerminalDataEvent {
  id: string
  chunk: string
}

// ==================== 全局搜索 ====================

export interface SearchHit {
  /** 工作区内相对路径（统一 / 分隔） */
  path: string
  /** 1 起始行号 */
  line: number
  /** 命中行文本（原始行，未去缩进） */
  text: string
}

/** 搜索选项（与 VS Code 搜索视图的开关一一对应） */
export interface SearchOptions {
  /** 区分大小写（VS Code 的 Aa） */
  caseSensitive: boolean
  /** 全字匹配（VS Code 的 ab） */
  wholeWord: boolean
  /** 正则表达式（VS Code 的 .*） */
  useRegex: boolean
  /** 包含文件 glob，逗号分隔；空 = 全部 */
  include: string
  /** 排除文件 glob，逗号分隔 */
  exclude: string
}

export interface SearchOutcome {
  hits: SearchHit[]
  /** 命中数达到上限，结果不完整 */
  truncated: boolean
  /** 实际采用的搜索方式：git grep 或文件遍历（用于结果区提示） */
  strategy: 'git' | 'scan'
  /** 模式非法等用户可修复的错误（如正则语法错误）；有错误时 hits 为空 */
  error?: string
}

export interface ReplaceOutcome {
  /** 被修改文件的相对路径 */
  files: string[]
  /** 替换总次数 */
  replacements: number
  error?: string
}

/** 替换预览的单行变更（before → after） */
export interface ReplacePreviewLine {
  line: number
  before: string
  after: string
}

export interface ReplacePreviewFile {
  path: string
  lines: ReplacePreviewLine[]
}

/** 替换预览（照搬 VS Code Replace Preview：执行前确认每处变更） */
export interface ReplacePreviewOutcome {
  files: ReplacePreviewFile[]
  /** 真实替换总数（预览行数有展示上限，两者可能不同） */
  total: number
  /** 预览展示是否被截断 */
  truncated: boolean
  error?: string
}

// ==================== 引擎状态 ====================

/** 引擎运行方式：本地子进程 / 远端服务 */
export type EngineMode = 'embedded' | 'remote'

/** 引擎生命周期阶段 */
export type EnginePhase =
  | 'idle' // 未启动
  | 'installing' // 正在安装运行时（解压/下载）
  | 'starting' // 进程已拉起，等待 /health
  | 'ready' // 可用
  | 'stopping' // 正在关闭
  | 'error' // 启动失败或异常退出

export interface EngineSnapshot {
  mode: EngineMode
  phase: EnginePhase
  /** 可用时的引擎地址，如 http://127.0.0.1:12323 */
  baseUrl: string
  port: number | null
  /** 引擎子进程 PID（远端模式或复用已运行引擎时为 null） */
  pid: number | null
  /**
   * 是否为「复用已有引擎」：
   * 首选端口上已存在健康引擎时不再另起一个（避免两个引擎同时打开同一个
   * SQLite 文件），此时该进程不由本应用启动，stop() 只能断开连接。
   */
  adopted: boolean
  /** 运行时入口脚本路径（embedded 模式） */
  entryPath: string | null
  /** embedded 引擎的实际运行时来源。 */
  runtimeSource: 'env' | 'bundled' | 'imported' | 'dev-sibling' | null
  version: string | null
  buildId?: string | null
  protocolVersion?: number | null
  instanceId?: string | null
  /** 数据目录（SQLite 文件路径） */
  dataDir: string | null
  error: string | null
  updatedAt: number
}

export interface EngineLogEntry {
  level: 'info' | 'warn' | 'error'
  line: string
  ts: number
}

// ==================== 设置 ====================

/**
 * 界面外观。
 *
 * 'system' 表示跟随操作系统：由渲染层用 prefers-color-scheme 判定，
 * 并把结果落到 <html data-appearance>。之所以不在主进程判定，
 * 是因为主进程读不到渲染层的媒体查询状态，且系统主题在运行中可能变化。
 */
export type Appearance = 'system' | 'dark' | 'light'

/** 强调色。取值对应 tokens.css 里的 [data-accent='*'] 覆盖块。 */
export type AccentColor = 'blue' | 'purple' | 'pink' | 'orange' | 'green' | 'graphite'

/**
 * 文件排除表：glob 模式 → 是否隐藏。
 *
 * 照搬 VS Code 的 `files.exclude` 语义：
 *   - 键是 glob（形如 `.git`、`*.log` 的写法，星号表示跨层级通配），值为 true=隐藏；
 *   - 值为 false 表示「显式不隐藏」，用来在内层覆盖外层的同名规则；
 *   - 匹配的是「相对工作区根的路径」+ 文件名（basename），二者任一命中即隐藏；
 *   - 目录被命中时整棵子树一并隐藏（父级隐藏向下传播）。
 */
export type FilesExclude = Record<string, boolean>

/**
 * `files.exclude` 的出厂默认值，与 VS Code 保持一致：
 * 只挡版本控制元数据与操作系统垃圾文件，不含 node_modules
 * （VS Code 把 node_modules 放在 search.exclude 而非 files.exclude ——
 * 资源管理器里应当看得见它，全文搜索才默认跳过）。
 */
export const DEFAULT_FILES_EXCLUDE: FilesExclude = {
  '**/.git': true,
  '**/.svn': true,
  '**/.hg': true,
  '**/.jj': true,
  '**/.DS_Store': true,
  '**/Thumbs.db': true
}

/**
 * `search.exclude` 的出厂默认值，与 VS Code 保持一致：
 * 只挡依赖目录与索引目录 —— 它们在资源管理器里应当看得见（那是 files.exclude 的事），
 * 但全文搜索没有理由去翻。
 */
export const DEFAULT_SEARCH_EXCLUDE: FilesExclude = {
  '**/node_modules': true,
  '**/bower_components': true,
  '**/*.code-search': true
}

export interface AppSettings {
  /** 引擎运行方式 */
  engineMode: EngineMode
  /** embedded 模式首选端口，冲突时自动递增 */
  preferredPort: number
  /** remote 模式远端地址 */
  remoteBaseUrl: string
  /** 新远端会话的服务端目录；空值使用服务端会话沙箱，已有会话沿用运行记录。 */
  remoteWorkspaceRoot: string
  /** 应用启动时是否自动拉起引擎 */
  autoStartEngine: boolean
  /** 上次使用的会话 ID */
  lastSessionId: string
  /** 上次使用的 Agent ID（空表示不指定） */
  lastAgentId: string
  /** 上次选中的模型 modelId（空表示用引擎默认） */
  lastModelId: string
  /**
   * 子代理专用模型 modelId（空 = 跟随主对话模型）。
   * 子代理跑的常是范围明确的子任务，可以指派更便宜的模型省 token。
   */
  subagentModelId: string
  /**
   * 轻任务专用模型 modelId（空 = 跟随主对话模型 / 引擎环境变量）。
   * 承载图片理解等旁路调用——不需要强推理，适合快而便宜的模型。
   */
  utilityModelId: string
  /**
   * 思考档位偏好（会话无关，跨会话沿用）。
   *
   * 档位映射到引擎 thinkingMode：
   *  - 'off'  → false：强制关闭思考
   *  - 'low'  → 'low'：几乎不思考（最低 effort）
   *  - 'high' → 不传：交给引擎按模型能力判断（默认档）
   *  - 'max'  → 'high'：强制开启并指定高 effort
   * 引擎侧已支持 thinkingMode 接收 'low' | 'medium' | 'high' 档位字符串。
   */
  thinkingMode: 'off' | 'low' | 'high' | 'max'
  /** 上次打开的工作区文件夹（空表示未打开） */
  lastFolder: string
  /** 界面明暗外观 */
  appearance: Appearance
  /** 界面强调色 */
  accent: AccentColor
  /**
   * 资源管理器与搜索的文件排除规则（glob → 是否隐藏）。
   *
   * 整表存盘而非逐条：用户会整体增删改，逐条 patch 反而要在渲染层做键级合并，
   * 容易和默认值缠在一起。空表表示「全部显示」。
   */
  filesExclude: FilesExclude
  /**
   * 全文搜索的额外排除规则（glob → 是否排除）。
   *
   * 照搬 VS Code 的 `search.exclude`：搜索结果 = filesExclude 与 searchExclude 的并集，
   * 同名键以本表为准 —— 这样默认被排除的 node_modules 可以在这里写成 false 放回来，
   * 而用户又不必为了搜索再抄一遍 filesExclude 里已有的规则。
   */
  searchExclude: FilesExclude
}

export type RemoteTokenSource = 'stored' | 'environment' | 'none'
export interface RemoteTokenStatus {
  configured: boolean
  source: RemoteTokenSource
}

export const DEFAULT_SETTINGS: AppSettings = {
  engineMode: 'embedded',
  preferredPort: 12323,
  remoteBaseUrl: '',
  remoteWorkspaceRoot: '',
  autoStartEngine: true,
  lastSessionId: '',
  lastAgentId: '',
  lastModelId: '',
  subagentModelId: '',
  utilityModelId: '',
  thinkingMode: 'high',
  lastFolder: '',
  appearance: 'system',
  accent: 'blue',
  filesExclude: { ...DEFAULT_FILES_EXCLUDE },
  searchExclude: { ...DEFAULT_SEARCH_EXCLUDE }
}

// ==================== 引擎 HTTP 契约 ====================

/**
 * 引擎统一响应体（见引擎侧 response.ts）。
 *
 * 注意：引擎对业务错误同样返回 HTTP 200，错误信息在 body.code 中，
 * 因此调用方**不能**依赖 HTTP 状态码判断成败。
 */
export interface StandardResponse<T = unknown> {
  code: number
  message: string
  data: T | null
  pagination?: {
    current: number
    pageSize: number
    total: number
    totalPages: number
  }
  metadata?: Record<string, unknown>
  timestamp: number
}

export interface EngineRequestInput {
  /** Reject delayed requests after the user changes the active engine. */
  expectedEngine?: Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId'>
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** 相对 /api/v1 的路径，如 '/agents'；以 /health、/models、/metrics 开头时按根路径处理 */
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

export interface RemoteAttachmentInput {
  expectedEngine: Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId'>
  sessionId: string
  fileName: string
  type: string
  data: Uint8Array
}

export interface RemoteAttachmentResult {
  remoteUploadId: string
  path: string
  name: string
  type: string
  size: number
}

/** Multipart upload to an engine route (skill/knowledge imports). */
export interface EngineUploadInput {
  expectedEngine: Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId'>
  path: string
  fileName: string
  type?: string
  data: Uint8Array
  fields?: Record<string, string>
}

export interface EngineRequestResult<T = unknown> {
  ok: boolean
  /** 引擎返回的 code（ok=false 时用于区分业务错误） */
  code: number
  message: string
  data: T | null
  pagination?: StandardResponse['pagination']
  metadata?: Record<string, unknown>
}

// ==================== SSE 流式契约 ====================

/**
 * 引擎会话待办项（todo 工具持久化的清单，见引擎 storage/todo）。
 * 随 `todo` SSE 帧整表下发，客户端据此渲染任务托盘。
 */
export interface EngineTodo {
  id: string
  title: string
  description?: string
  status: 'pending' | 'in_progress' | 'done' | 'cancelled'
  priority: 'low' | 'medium' | 'high'
  dueAt?: number
}

/**
 * 引擎 SSE 的 data 帧负载（见引擎侧 sse-sink.ts）。
 * 同一帧只会出现其中一个字段，用可选字段而非联合类型以便透传未知帧。
 */
export interface ChatSsePayload {
  userMessage?: unknown
  run?: import('./root-run').RootRun
  assistantMsgId?: string
  subagentEvent?: import('./subagent').SubagentEvent
  content?: string
  thinking?: string
  toolStart?: unknown
  toolArgs?: unknown
  toolEnd?: unknown
  toolCall?: unknown
  toolResult?: unknown
  ask_user?: unknown
  userMsgId?: string
  permissionRequest?: unknown
  messageBlock?: unknown
  flow?: unknown
  /** 会话待办清单快照（\x00__todo__ 控制帧） */
  todo?: { todos?: EngineTodo[] }
  /** 文件改动记录（\x00__file_change__ 控制帧，write_file/delete_file 后下发） */
  fileChange?: EngineFileChange
  usage?: unknown
}

/**
 * 引擎记录的单条文件改动（见引擎侧 storage/changes）。
 * 老内容/新内容用于渲染 git 风格 diff；内容过大或二进制时两者为 null（truncated=true）。
 */
export interface EngineFileChange {
  /** Net pending rows retain every source operation for keep/revert actions. */
  changeIds?: string[]
  projectionIssue?: 'discontinuous-history' | 'later-change' | 'disk-diverged' | 'path-changed' | 'snapshot-unavailable' | 'unreadable'
  turnId?: string
  runId?: string
  id: string
  /** Stable server operation order and byte versions; absent on legacy records. */
  seq?: number
  oldHash?: string | null
  newHash?: string | null
  /** 引擎工作区视角的绝对路径 */
  path: string
  kind: 'write' | 'delete'
  /** null = 写入前文件不存在（新建）或内容未存档 */
  oldContent: string | null
  /** null = 文件被删除或内容未存档 */
  newContent: string | null
  /** 任一侧内容超限未入库，此时无法自动撤回 */
  truncated: boolean
  status: 'pending' | 'kept' | 'reverted'
  createdAt: number
  /** 工具入参里的原始路径（展示用，可能与绝对路径不同） */
  displayPath?: string
  /** true = 本次写入创建了新文件 */
  isNew?: boolean
  /** 关联的工具调用 ID（fileChange 帧附带，用于把改动挂到对应工具卡片） */
  toolCallId?: string
}

/** 主进程转发给渲染进程的流式事件 */
export type StreamEvent = { streamId: string; eventId?: string } & (
  | { type: 'payload'; payload: ChatSsePayload }
  | { type: 'done' }
  | { type: 'snapshot-required' }
  | { type: 'error'; message: string; status?: number; code?: number }
)

export interface StreamStartInput {
  expectedEngine?: Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId'>
  streamId: string
  path: string
  body: unknown
  /** HTTP 方法，默认 POST；续传 /chat/stream 用 GET */
  method?: 'GET' | 'POST'
  /** GET 请求的查询参数（续传时传 sessionId / lastEventId） */
  query?: Record<string, string>
}

// ==================== TS 语言服务（LSP） ====================

/**
 * 渲染进程与语言服务之间传的是**原始 JSON-RPC 对象**（vscode-jsonrpc 协议），
 * 不在 IPC 层做类型收窄 —— LSP 方法几十个，收窄会把协议真相复制一份进 IPC 层，
 * 违背「IPC 只搬字节」的原则。这里只声明「是个对象」。
 */
export type LspMessage = Record<string, unknown>

/** lsp:start 的入参：rootUri 让服务器定位 tsconfig / node_modules */
export interface LspStartInput {
  /** 工作区根（file:// URI），服务器据此发现工程配置 */
  rootUri: string
  /** 服务器入口绝对路径（require.resolve('typescript-language-server/lib/cli.mjs')） */
  serverEntry: string
  /** Packaged installations may provide their bundled Node executable. */
  nodePath?: string
}

export interface LspStartResult {
  ok: boolean
  error?: string
}

export interface LspExitInfo {
  code: number | null
  signal: string | null
}

// ==================== 文件系统契约 ====================

/**
 * 文件系统传输按引擎模式选择：本地模式由主进程直接访问真实文件系统，
 * 远端模式由 renderer 通过引擎的 /workspace API 访问会话沙箱。
 * 两种模式都保持这份 FsEntry/FsFileContent/FsStat 形状，让 Explorer、Monaco
 * 和文件操作不感知传输差异；远端请求只发送 sessionId 与工作区内相对路径。
 */

export interface FsEntry {
  name: string
  /** 绝对路径 */
  path: string
  isDirectory: boolean
  size: number
  mtimeMs: number
  /**
   * 被工作区根目录下的 .gitignore 忽略（资源管理器据此置灰）。
   * 判定失败 / 不在 git 仓库内时为 undefined，按未忽略处理 —— 只影响视觉，不影响可操作性。
   */
  gitignored?: boolean
}

export interface FsFileContent {
  path: string
  /** 文本文件为原文；二进制文件为空（用 base64 字段） */
  content: string
  /** 二进制文件的内容（base64） */
  base64?: string
  isBinary: boolean
  size: number
  /** 文本超过阈值被截断 */
  truncated: boolean
  /**
   * 二进制文件超过预览上限，未读取内容（base64 为空）。
   *
   * 存在的理由：base64 会把整份文件驻留内存并膨胀 4/3，一个 2 GB 的视频
   * 足以让主进程 OOM。因此超限时明确拒绝预览，而不是硬读。
   */
  tooLarge?: boolean
}

export interface FsStat {
  path: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

/**
 * 复制本地文件到工作区的入参。
 *
 * File 对象出于浏览器安全拿不到真实磁盘路径，因此只能把字节流传过来。
 * `fileName` 只用于命名；落盘位置固定在 `root/.aether/attachments/`，
 * 避免污染用户项目。
 */
export interface CopyIntoWorkspaceInput {
  /** 目标工作区根目录（须为已授权根） */
  root: string
  /** 原始文件名（用于取扩展名 + 命名） */
  fileName: string
  /** 文件字节（Uint8Array，经 structured clone 传输） */
  data: Uint8Array
}

export interface CopyIntoWorkspaceResult {
  /** 落盘的绝对路径 */
  path: string
  /** 相对工作区根的路径 —— 引擎的 attachments[].name 用的就是这个 */
  relativePath: string
  size: number
}

// ==================== 版本控制契约 ====================

/**
 * 版本控制由 IDE 自己实现（主进程直接调用 git），不走引擎。
 *
 * 原因：引擎只有通用的 cmd 工具，而 git 状态是「编辑器视角」的信息，
 * 让 Agent 去跑命令既没必要也不可靠。IDE 直接跑 git 最快也最准。
 *
 * 完整的 git 面板类型契约（GitFileChange / GitResult / GitLogEntry 等）
 * 统一定义在 ./git-types.ts（移植自 wuzu-client 的 codeGit.ts），这里只做
 * re-export，保持「shared/ipc.ts 是唯一协议真相来源」的引用习惯。
 */

export * from './git-types'
import type { GitFileChange } from './git-types'

// ---------- 旧版兼容类型 ----------
// 早期只读面板的类型残留：GitStatus/GitCommit 不在 wuzu 契约里，
// 但渲染层 git-store / GitView 仍在用。为控制破坏面，这里以新契约为底
// 保留这两个别名结构；新版 GitFileChange 已直接替代旧版（字段更名：
// indexStatus/workTreeStatus → stagedChange/unstagedChange + changeType）。

/** 状态栏/旧版 GitView 使用的分支概览（等价 branchInfo + status 的合集） */
export interface GitStatus {
  /** 不是 git 仓库时为 false，其余字段无意义 */
  isRepo: boolean
  /** 当前分支名；分离头指针时 git 会给出 HEAD */
  branch: string
  /** 相对上游的领先提交数；没有上游时为 null */
  ahead: number | null
  /** 相对上游的落后提交数；没有上游时为 null */
  behind: number | null
  changes: GitFileChange[]
}

/** 旧版提交记录（等价 GitLogEntry，但 refs 是原始装饰字符串） */
export interface GitCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  /** ISO 8601 时间（git 原样输出，展示时再格式化） */
  date: string
  /** 引用装饰（分支/标签），空串表示没有 */
  refs: string
}
