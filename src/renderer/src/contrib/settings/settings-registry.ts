/**
 * Settings metadata is deliberately separate from page components.
 *
 * VS Code can search every registered setting because the setting id, label,
 * description, aliases, and scope are data. Keeping the same small registry
 * here lets new settings pages be added without turning AppSettingsView into
 * another hand-maintained search switch statement.
 */

export type SettingsScope = 'user' | 'workspace' | 'both'

export interface SettingDefinition {
  key: string
  label: string
  description: string
  section: string
  category: string
  scope: SettingsScope
  keywords?: string[]
  tags?: string[]
}

export const SETTINGS_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'aether.account.profile', label: '个人账号与登录',
    description: '管理姓名、邮箱、简介、第三方账号绑定、恢复凭证和登录设备。',
    section: 'account', category: '个人账号', scope: 'user',
    keywords: ['account', 'profile', 'login', 'oauth', '个人资料', '登录', '账号', '姓名', '邮箱', '凭证', '备份']
  },
  {
    key: 'editor.fontFamily',
    label: '字体',
    description: '编辑器使用的等宽字体族。',
    section: 'editor',
    category: '文本编辑器 / 字体',
    scope: 'user',
    keywords: ['font', '字体', 'family']
  },
  {
    key: 'editor.fontSize',
    label: '字号',
    description: '编辑器文字的显示字号。',
    section: 'editor',
    category: '文本编辑器 / 字体',
    scope: 'user',
    keywords: ['font', '字体', 'size']
  },
  {
    key: 'editor.lineHeight',
    label: '行高',
    description: '编辑器每行的像素高度。',
    section: 'editor',
    category: '文本编辑器 / 字体',
    scope: 'user',
    keywords: ['line', 'height', '行距']
  },
  {
    key: 'editor.tabSize',
    label: '缩进空格数',
    description: '一个缩进使用的空格数量。',
    section: 'editor',
    category: '文本编辑器 / 格式化',
    scope: 'user',
    keywords: ['indent', 'tab', '缩进']
  },
  {
    key: 'editor.fontLigatures',
    label: '字体连字',
    description: '是否启用字体连字显示。',
    section: 'editor',
    category: '文本编辑器 / 字体',
    scope: 'user',
    keywords: ['ligatures', '连字']
  },
  {
    key: 'terminal.integrated.fontFamily',
    label: '终端字体',
    description: '集成终端使用的等宽字体族。',
    section: 'terminal',
    category: '文本编辑器 / 终端',
    scope: 'user',
    keywords: ['terminal', 'font', '字体', '终端']
  },
  {
    key: 'terminal.integrated.fontSize',
    label: '终端字号',
    description: '集成终端文字的显示字号。',
    section: 'terminal',
    category: '文本编辑器 / 终端',
    scope: 'user',
    keywords: ['terminal', 'font', 'size', '字号', '终端']
  },
  {
    key: 'terminal.integrated.lineHeight',
    label: '终端行高',
    description: '集成终端的行高倍率。',
    section: 'terminal',
    category: '文本编辑器 / 终端',
    scope: 'user',
    keywords: ['terminal', 'line', 'height', '行高', '终端']
  },
  {
    key: 'terminal.integrated.cursorBlinking',
    label: '终端光标闪烁',
    description: '终端获得焦点时显示闪烁光标。',
    section: 'terminal',
    category: '文本编辑器 / 终端',
    scope: 'user',
    keywords: ['terminal', 'cursor', 'blink', '光标', '闪烁']
  },
  {
    key: 'terminal.integrated.scrollback',
    label: '终端滚动缓冲',
    description: '终端保留的历史行数。',
    section: 'terminal',
    category: '文本编辑器 / 终端',
    scope: 'user',
    keywords: ['terminal', 'scrollback', 'history', '滚动', '终端']
  },
  {
    key: 'editor.wordWrap',
    label: '自动换行',
    description: '长行超出编辑器宽度时自动换行。',
    section: 'editor',
    category: '文本编辑器 / 格式化',
    scope: 'user',
    keywords: ['wrap', 'word', '换行']
  },
  {
    key: 'editor.minimap.enabled',
    label: '显示小地图',
    description: '在编辑器右侧显示代码缩略图。',
    section: 'editor',
    category: '文本编辑器 / 小地图',
    scope: 'user',
    keywords: ['minimap', '小地图', 'overview']
  },
  {
    key: 'files.exclude',
    label: '资源管理器排除规则',
    description: '控制哪些文件和目录不显示在资源管理器中。',
    section: 'files',
    category: '文件',
    scope: 'workspace',
    keywords: ['explorer', 'exclude', '文件', '排除']
  },
  {
    key: 'search.exclude',
    label: '搜索排除规则',
    description: '控制全文搜索跳过哪些文件和目录。',
    section: 'search',
    category: '搜索',
    scope: 'workspace',
    keywords: ['search', 'exclude', '搜索', '排除']
  },
  {
    key: 'aether.engine.mode',
    label: '引擎运行方式',
    description: '选择本地内置引擎或远程引擎连接。',
    section: 'general',
    category: '引擎管理',
    scope: 'user',
    keywords: ['engine', 'remote', 'embedded', '引擎', '远程']
  },
  {
    key: 'aether.engine.autoStart',
    label: '启动时自动连接引擎',
    description: '应用启动时自动启动或连接配置好的引擎。',
    section: 'general',
    category: '引擎管理',
    scope: 'user',
    keywords: ['engine', 'startup', '自动启动']
  },
  {
    key: 'aether.appearance.theme',
    label: '颜色主题',
    description: '选择浅色、深色或跟随系统外观。',
    section: 'appearance',
    category: '外观',
    scope: 'user',
    keywords: ['theme', 'dark', 'light', '主题', '深色', '浅色']
  },
  {
    key: 'aether.appearance.accent',
    label: '强调色',
    description: '选择预设或自定义颜色，设置选中态、焦点环和交互控件使用的强调色。',
    section: 'appearance',
    category: '外观',
    scope: 'user',
    keywords: ['accent', 'color', 'custom', 'hex', '强调色', '自定义颜色', '色值']
  },
  {
    key: 'aether.models.default',
    label: '默认模型',
    description: '设置新会话使用的默认模型。',
    section: 'models',
    category: '模型',
    scope: 'user',
    keywords: ['model', '模型', 'default', '默认']
  },
  {
    key: 'aether.security.mode',
    label: '安全模式',
    description: '控制引擎工具调用的权限策略。',
    section: 'security',
    category: '安全',
    scope: 'user',
    keywords: ['security', 'permission', '安全', '权限']
  },
  {
    key: 'aether.mcp.servers',
    label: 'MCP 服务',
    description: '管理可供智能体使用的 MCP 服务。',
    section: 'mcp',
    category: '扩展 / MCP',
    scope: 'user',
    keywords: ['mcp', 'server', 'extension', '服务', '扩展']
  },
  {
    key: 'aether.skills.registry',
    label: '技能注册表',
    description: '导入、创建和启用可复用的技能。',
    section: 'skills',
    category: '扩展 / 技能',
    scope: 'user',
    keywords: ['skill', 'extension', '技能', '扩展']
  },
  {
    key: 'aether.knowledge.bases',
    label: '知识库',
    description: '管理文档索引和检索知识库。',
    section: 'knowledge',
    category: '扩展 / 知识库',
    scope: 'user',
    keywords: ['knowledge', 'search', '知识库', '检索']
  },
  {
    key: 'aether.memory.scope',
    label: '记忆范围',
    description: '管理全局记忆和会话记忆的作用范围。',
    section: 'memory',
    category: '扩展 / 记忆',
    scope: 'user',
    keywords: ['memory', '记忆', 'session', '会话']
  },
  {
    key: 'aether.keybindings',
    label: '键盘快捷键',
    description: '查看和调整 Aether 的操作快捷键。',
    section: 'keybindings',
    category: '工作区',
    scope: 'user',
    keywords: ['keyboard', 'shortcut', 'keybinding', '键盘', '快捷键']
  },
  {
    key: 'git.autofetch',
    label: '自动获取远端更新',
    description: '按固定间隔在后台静默执行 git fetch。',
    section: 'git',
    category: '功能 / 源代码管理',
    scope: 'user',
    keywords: ['git', 'scm', 'fetch', '源代码管理', '同步']
  },
  {
    key: 'git.autofetchInterval',
    label: '自动获取间隔',
    description: '后台检查远端更新的时间间隔。',
    section: 'git',
    category: '功能 / 源代码管理',
    scope: 'user',
    keywords: ['git', 'scm', 'interval', '间隔', '同步']
  },
  {
    key: 'workbench.sidebar.visible',
    label: '显示侧边栏',
    description: '显示资源管理器、搜索和源代码管理等侧边栏视图。',
    section: 'workbench',
    category: '功能 / 工作台',
    scope: 'user',
    keywords: ['workbench', 'sidebar', 'activity', '侧边栏', '工作台']
  },
  {
    key: 'workbench.panel.visible',
    label: '显示底部面板',
    description: '显示终端、输出和问题等底部面板。',
    section: 'workbench',
    category: '功能 / 工作台',
    scope: 'user',
    keywords: ['workbench', 'panel', 'terminal', '面板', '工作台']
  },
  {
    key: 'workbench.chatPanel.visible',
    label: '显示对话面板',
    description: '显示 Aether 对话侧栏。',
    section: 'workbench',
    category: '功能 / 工作台',
    scope: 'user',
    keywords: ['workbench', 'chat', 'panel', '对话', '工作台']
  },
  {
    key: 'workbench.chatPanel.position',
    label: '对话面板位置',
    description: '选择对话面板位于编辑区左侧或右侧。',
    section: 'workbench',
    category: '功能 / 工作台',
    scope: 'user',
    keywords: ['workbench', 'chat', 'position', '对话', '位置']
  }
]

let registeredDefinitions: readonly SettingDefinition[] = SETTINGS_DEFINITIONS
const registryListeners = new Set<() => void>()

/** 扩展可以注册自己的设置元数据；读写行为仍由扩展页面或适配器负责。 */
export function registerSettings(definitions: SettingDefinition | readonly SettingDefinition[]): () => void {
  const additions = Array.isArray(definitions) ? definitions : [definitions]
  const keys = new Set(registeredDefinitions.map((setting) => setting.key))
  const accepted = additions.filter((setting) => !keys.has(setting.key))
  if (accepted.length === 0) return () => {}
  registeredDefinitions = [...registeredDefinitions, ...accepted]
  for (const listener of registryListeners) listener()
  return () => {
    const acceptedKeys = new Set(accepted.map((setting) => setting.key))
    registeredDefinitions = registeredDefinitions.filter((setting) => !acceptedKeys.has(setting.key))
    for (const listener of registryListeners) listener()
  }
}

export function getSettingsDefinitions(): readonly SettingDefinition[] {
  return registeredDefinitions
}

export function onSettingsRegistryChanged(listener: () => void): () => void {
  registryListeners.add(listener)
  return () => registryListeners.delete(listener)
}

export function searchSettings(query: string, scope?: 'user' | 'workspace', modifiedKeys?: ReadonlySet<string>): SettingDefinition[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  let effectiveScope = scope
  let modifiedOnly = false
  const textTerms: string[] = []
  let idTerm: string | undefined
  let tagTerm: string | undefined
  for (const term of terms) {
    if (term === '@modified') { modifiedOnly = true; continue }
    if (term === '@user') { effectiveScope = 'user'; continue }
    if (term === '@workspace') { effectiveScope = 'workspace'; continue }
    if (term.startsWith('@id:')) { idTerm = term.slice(4); continue }
    if (term.startsWith('@tag:')) { tagTerm = term.slice(5); continue }
    textTerms.push(term)
  }
  return registeredDefinitions.filter((setting) => {
    if (effectiveScope && setting.scope !== 'both' && setting.scope !== effectiveScope) return false
    if (modifiedOnly && !modifiedKeys?.has(setting.key)) return false
    if (idTerm && !setting.key.toLocaleLowerCase().includes(idTerm)) return false
    if (tagTerm && !(setting.tags ?? setting.keywords ?? []).some((tag) => tag.toLocaleLowerCase().includes(tagTerm!))) return false
    const haystack = [setting.key, setting.label, setting.description, setting.category, ...(setting.keywords ?? [])]
      .join(' ')
      .toLocaleLowerCase()
    return textTerms.every((term) => haystack.includes(term))
  })
}
