export interface AgentToolIdentity {
  id: string
  source?: string
  unavailable?: boolean
}

export const AGENT_TOOL_CATEGORIES = [
  { id: 'files', label: '文件与搜索' },
  { id: 'office', label: '办公与预览' },
  { id: 'terminal', label: '终端命令' },
  { id: 'web', label: '网页与网络' },
  { id: 'code', label: '代码分析' },
  { id: 'collaboration', label: '协作' },
  { id: 'agent-management', label: 'Agent 管理' },
  { id: 'mcp-management', label: 'MCP 管理' },
  { id: 'memory', label: '记忆与历史' },
  { id: 'automation', label: '定时任务' },
  { id: 'tasks', label: '任务与待办' },
  { id: 'skills', label: '技能工具' },
  { id: 'mcp', label: 'MCP 工具' },
  { id: 'other', label: '其它工具' }
] as const

export type AgentToolCategory = (typeof AGENT_TOOL_CATEGORIES)[number]['id']

// Match engine registry identities, not translated labels or descriptions.
// Legacy names only affect presentation here; permission values stay intact.
const builtinGroups: ReadonlyArray<readonly [AgentToolCategory, readonly string[]]> = [
  [
    'files',
    [
      'read_file',
      'write_file',
      'edit_file',
      'list_files',
      'delete_file',
      'create_dir',
      'glob',
      'grep',
      'search_files',
      'smart_read'
    ]
  ],
  [
    'office',
    [
      'office_document',
      'office_inspect',
      'office_environment',
      'workbench_context',
      'workbench_open',
      'workbench_render',
      'deliver_files'
    ]
  ],
  ['terminal', ['execute_cmd', 'command_output', 'cancel_command', 'run_command', 'exec_command']],
  [
    'web',
    [
      'web_fetch',
      'http_request',
      'browser_tabs',
      'browser_open',
      'browser_navigate',
      'browser_snapshot',
      'browser_screenshot',
      'browser_save_screenshot',
      'browser_click',
      'browser_fill',
      'browser_scroll',
      'browser_press_key',
      'browser_wait',
      'browser_console',
      'browser_network',
      'browser_network_request',
      'browser_set_viewport',
      'browser_close'
    ]
  ],
  ['code', ['code_diagnose', 'codegraph']],
  [
    'collaboration',
    [
      'ask_user',
      'subagent',
      'subagent_start',
      'subagent_send',
      'subagent_wait',
      'subagent_cancel',
      'subagent_participants',
      'subagent_inbox',
      'subagent_directory',
      'subagent_followup',
      'subagent_request_input',
      'subagent_read_result',
      'report_artifacts'
    ]
  ],
  ['agent-management', ['agent_list', 'agent_get', 'agent_create', 'agent_update', 'agent_delete']],
  ['mcp-management', ['mcp_server_list', 'mcp_server_get', 'mcp_server_create', 'mcp_server_update', 'mcp_server_set_enabled', 'mcp_server_delete', 'mcp_server_test']],
  [
    'memory',
    [
      'remember',
      'recall',
      'search_memory',
      'list_memories',
      'forget',
      'link_memories',
      'search_history'
    ]
  ],
  ['automation', ['cron_list', 'cron_preview', 'cron_create', 'cron_update', 'cron_delete']],
  [
    'tasks',
    [
      'task_list',
      'task_status',
      'task_cancel',
      'todo_list',
      'todo_create',
      'todo_update',
      'todo_delete'
    ]
  ],
  ['skills', ['list_skills', 'get_skill', 'run_skill_script']]
]
const builtinCategories = new Map<string, AgentToolCategory>(
  builtinGroups.flatMap(([category, names]) => names.map((name) => [name, category] as const))
)

export function agentToolCategory(tool: AgentToolIdentity): AgentToolCategory {
  if (tool.unavailable) return 'other'
  if ((!tool.source || tool.source === 'builtin') && builtinCategories.get(tool.id) === 'mcp-management') return 'mcp-management'
  if (tool.source === 'mcp' || tool.id.startsWith('mcp_')) return 'mcp'
  if (tool.source === 'skill') return 'skills'
  // A new source cannot accidentally look like a built-in permission just
  // because it reuses its name. Unknown catalogue entries remain selectable.
  if (tool.source && tool.source !== 'builtin') return 'other'
  return builtinCategories.get(tool.id) ?? 'other'
}

export function groupAgentTools<T extends AgentToolIdentity>(
  tools: readonly T[]
): Array<{ id: AgentToolCategory; label: string; options: T[] }> {
  const grouped = new Map<AgentToolCategory, T[]>()
  for (const tool of tools) {
    const category = agentToolCategory(tool)
    const items = grouped.get(category) ?? []
    items.push(tool)
    grouped.set(category, items)
  }
  return AGENT_TOOL_CATEGORIES.flatMap((category) => {
    const options = grouped.get(category.id)
    return options?.length ? [{ ...category, options }] : []
  })
}

/** Bulk selection changes only its visible scope, including under filters. */
export function selectAgentToolGroup(
  selected: readonly string[],
  ids: readonly string[],
  checked: boolean
): string[] {
  if (checked) return [...new Set([...selected, ...ids])]
  const removed = new Set(ids)
  return selected.filter((id) => !removed.has(id))
}
