import { getWorkspaceState } from '@renderer/core/workspace/workspace-store'

/**
 * 工具展示辅助：英文名 → 中文名 + 参数摘要
 *
 * 引擎侧每个工具都有自己的 displayName，但 SSE 帧里只带 name（英文），
 * 这里在渲染层做静态映射，工具改名/新增时只需补这张表。
 */

const TOOL_NAMES: Record<string, string> = {
  // 文件
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  list_files: '列出文件',
  delete_file: '删除文件',
  create_dir: '创建目录',
  // 检索 / 命令
  grep_search: '搜索内容',
  glob_search: '查找文件',
  execute_cmd: '执行命令',
  command_output: '查看命令输出',
  cancel_command: '停止命令',
  http_request: 'HTTP 请求',
  web_fetch: '获取网页内容',
  // 待办
  todo_list: '列出待办',
  todo_create: '创建待办',
  todo_update: '更新待办',
  todo_delete: '删除待办',
  // 交互 / 子代理
  ask_user: '向用户提问',
  subagent: '子代理',
  // 代码 / 包管理
  code_diagnose: '代码诊断',
  codegraph: '代码图查询',
  install_package: '安装依赖包',
  list_packages: '列出已安装的包',
  // Agent 管理
  agent_list: '列出 Agent',
  agent_get: '查看 Agent',
  agent_create: '创建 Agent',
  agent_update: '更新 Agent',
  agent_delete: '删除 Agent',
  // 定时任务
  cron_create: '创建定时任务',
  cron_list: '列出定时任务',
  cron_update: '更新定时任务',
  cron_delete: '删除定时任务',
  // 后台任务
  task_list: '列出后台任务',
  task_cancel: '取消后台任务',
  task_status: '查看后台任务',
  // 技能 / 记忆 / 上下文
  list_skills: '查看可用技能',
  get_skill: '获取技能说明',
  run_skill_script: '运行技能脚本',
  get_current_context: '获取当前上下文',
  remember: '记录记忆',
  recall: '记忆检索',
  list_memories: '列出近期记忆'
}

/** 参数摘要优先取的键（按常见工具入参排序） */
const SUMMARY_KEYS = [
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'task',
  'question',
  'title',
  'skill',
  'name',
  'id'
]

/** 工具的中文显示名；映射表没有的原样返回（避免瞎编误导） */
export function toolDisplayName(name: string): string {
  if (!name) return '未命名工具'
  return TOOL_NAMES[name] ?? name
}

/**
 * 从工具参数 JSON 里提取文件路径（path / filePath / file），供「点击打开」使用。
 * 只认明确的文件路径键，command/url 等不会误判成文件。非法 JSON 返回 null。
 */
export function toolPathArg(argsJson: string): string | null {
  if (!argsJson) return null
  try {
    const args: unknown = JSON.parse(argsJson)
    if (!args || typeof args !== 'object') return null
    const record = args as Record<string, unknown>
    for (const key of ['path', 'filePath', 'file']) {
      const value = record[key]
      if (typeof value === 'string' && value) return value
    }
  } catch {
    // 截断中的流式参数不是合法 JSON：没有路径可点，静默跳过
  }
  return null
}

/**
 * 从工具参数 JSON 里提取一行人类可读的摘要（如文件路径 / 命令）。
 * args 不是合法 JSON（截断或格式化过）时退回原文首行。
 */
export function toolParamSummary(argsJson: string): string {
  if (!argsJson) return ''
  try {
    const args: unknown = JSON.parse(argsJson)
    if (args && typeof args === 'object') {
      const record = args as Record<string, unknown>
      for (const key of SUMMARY_KEYS) {
        const value = record[key]
        if (typeof value === 'string' && value) return condense(relativize(value))
        if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      }
      return ''
    }
    if (typeof args === 'string') return condense(args)
  } catch {
    // fallthrough
  }
  return condense(argsJson)
}

/** 压成单行并截断到 96 字符 */
function condense(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 96 ? `${oneLine.slice(0, 96)}…` : oneLine
}

/**
 * 绝对路径裁成相对工作区根的路径：参数里的 `D:\dev\aether-code\package.json`
 * 在摘要行显示为 `package.json`；不在工作区内的路径原样保留。
 * 分隔符与盘符大小写都归一后比较（Windows 不区分大小写、两向斜杠混用）。
 */
function relativize(value: string): string {
  const root = getWorkspaceState().root
  if (!root) return value
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const v = norm(value)
  const r = norm(root)
  if (v === r) return '.'
  if (v.startsWith(`${r}/`)) return value.replace(/\\/g, '/').replace(/\/+$/, '').slice(r.length + 1)
  return value
}
