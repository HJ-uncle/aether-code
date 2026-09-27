/**
 * 用户自定义键位（对标 VS Code 的 keybindings.json）
 *
 * 规则格式与 VS Code 一致：{ key, command, when? }，其中 command 以 '-'
 * 开头的是「负规则」—— 删除该按键上的默认绑定（不执行任何命令）。
 *
 * 解析语义照搬 VS Code KeybindingResolver：
 *   - 用户规则永远优先于默认绑定；
 *   - 同一按键的规则，后定义的覆盖先定义的（匹配时按逆序找第一条命中）；
 *   - 负规则只负责屏蔽，落在默认绑定匹配阶段处理（见 keybindings.ts）。
 *
 * 持久化走 localStorage（与 recentFiles / commandMru 同一惯例），
 * 数组顺序即用户规则的定义顺序。
 */

export interface UserKeybindingRule {
  /** 形如 'ctrl+alt+o'，与 keybindings.ts 的 key 串同一写法 */
  key: string
  /** 命令 ID；以 '-' 开头表示删除绑定 */
  command: string
  when?: string
}

const STORAGE_KEY = 'aether.keybindings'

function load(): UserKeybindingRule[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is UserKeybindingRule =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as UserKeybindingRule).key === 'string' &&
        typeof (item as UserKeybindingRule).command === 'string'
    )
  } catch {
    return []
  }
}

let rules: UserKeybindingRule[] = load()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules))
  } catch {
    // 存储不可用（隐私模式等）只影响跨会话保留，不影响本次会话
  }
}

export function getUserKeybindingRules(): UserKeybindingRule[] {
  return rules
}

export function onUserKeybindingsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 该命令当前生效的用户正规则键位（逆序找第一条 = 后定义优先） */
export function getEffectiveUserBinding(command: string): string | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (rules[i].command === command) return rules[i].key
  }
  return undefined
}

/**
 * 为命令设置用户键位：移除该命令现有正规则后追加到末尾。
 * 追加到末尾保证「后定义优先」—— 新键位立即生效。
 */
export function setUserKeybinding(command: string, key: string): void {
  rules = [...rules.filter((rule) => rule.command !== command), { key, command }]
  persist()
  notify()
}

/**
 * 清除命令的键位（编辑器「清除键位」动作）：清空该命令全部规则，
 * 有默认绑定时补一条负规则屏蔽它，保证命令不再响应任何按键。
 */
export function clearCommandKeybinding(command: string, defaultKey?: string): void {
  const negative = `-${command}`
  const rest = rules.filter((rule) => rule.command !== command && rule.command !== negative)
  rules = defaultKey ? [...rest, { key: defaultKey, command: negative }] : rest
  persist()
  notify()
}

/** 重置命令的全部用户规则（正 + 负），恢复默认键位 */
export function resetCommandKeybindings(command: string): void {
  const negative = `-${command}`
  rules = rules.filter((rule) => rule.command !== command && rule.command !== negative)
  persist()
  notify()
}

/** 命令是否被任何用户规则（正/负）触及，用于编辑器判断「重置」是否可点 */
export function hasUserKeybindingRules(command: string): boolean {
  const negative = `-${command}`
  return rules.some((rule) => rule.command === command || rule.command === negative)
}
