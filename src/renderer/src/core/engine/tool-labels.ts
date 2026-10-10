/**
 * UI-only tool labels. Keep protocol identifiers intact for requests, policies and exports' arguments.
 * This module has no renderer state so chat, approvals, settings and text exports share one mapping.
 */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  list_files: '列出文件',
  delete_file: '删除文件',
  create_dir: '创建目录',
  grep_search: '搜索内容',
  glob_search: '查找文件',
  execute_cmd: '执行命令',
  command_output: '查看命令输出',
  cancel_command: '停止命令',
  http_request: 'HTTP 请求',
  web_fetch: '获取网页内容',
  todo_list: '列出待办',
  todo_create: '创建待办',
  todo_update: '更新待办',
  todo_delete: '删除待办',
  ask_user: '向用户提问',
  subagent: '子代理',
  code_diagnose: '代码诊断',
  codegraph: '代码图查询',
  install_package: '安装依赖包',
  list_packages: '列出已安装的包',
  agent_list: '列出代理',
  agent_get: '查看代理',
  agent_create: '创建代理',
  agent_do_create: '执行创建代理',
  agent_update: '更新代理',
  agent_do_update: '执行更新代理',
  agent_delete: '删除代理',
  agent_do_delete: '执行删除代理',
  cron_create: '创建定时任务',
  cron_list: '列出定时任务',
  cron_update: '更新定时任务',
  cron_delete: '删除定时任务',
  task_list: '列出后台任务',
  task_cancel: '取消后台任务',
  task_status: '查看后台任务',
  list_skills: '查看可用技能',
  get_skill: '获取技能说明',
  run_skill_script: '运行技能脚本',
  get_current_context: '获取当前上下文',
  search_history: '检索会话原始历史',
  remember: '记录记忆',
  recall: '记忆检索',
  list_memories: '列出近期记忆',
  forget: '删除记忆',
  link_memories: '建立记忆关联',
  calculate: '计算器',
  get_time: '获取时间',
  browser_tabs: '浏览器标签',
  browser_open: '打开浏览器页面',
  browser_navigate: '浏览器导航',
  browser_snapshot: '读取浏览器页面',
  browser_screenshot: '浏览器截图',
  browser_click: '点击浏览器元素',
  browser_fill: '填写浏览器输入框',
  browser_scroll: '滚动浏览器页面',
  browser_press_key: '浏览器按键',
  browser_wait: '等待浏览器状态',
  browser_console: '读取浏览器控制台',
  browser_network: '筛选浏览器网络请求',
  browser_network_request: '读取浏览器请求详情',
  browser_set_viewport: '调整浏览器视口',
  browser_close: '关闭浏览器标签',
  // Persisted history may still use the engine's pre-profile aliases.
  run_command: '执行命令',
  glob: '查找文件',
  grep: '搜索内容',
  smart_read: '读取文件'
}

function knownLabel(name: string): string | undefined {
  return Object.hasOwn(TOOL_NAMES, name) ? TOOL_NAMES[name] : undefined
}

/** Unknown/custom names remain recognizable instead of guessing their meaning. */
export function toolDisplayName(name: string): string {
  if (!name) return '未命名工具'
  const label = knownLabel(name)
  if (label) return label
  const namespaced = /^mcp__([^]+?)__([^]+)$/.exec(name)
  if (namespaced) {
    const operation = knownLabel(namespaced[2])
    if (operation) return `${operation}（MCP · ${namespaced[1]}）`
  }
  return name
}

/** Only explicit server identity makes single-underscore MCP names unambiguous. */
export function mcpToolDisplayName(serverId: string, name: string): string {
  const prefix = `mcp_${serverId}_`
  const definitionName = name.startsWith(prefix) ? name.slice(prefix.length) : name
  return toolDisplayName(definitionName)
}
