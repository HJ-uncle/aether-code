/**
 * 命令注册表
 *
 * 所有可触发动作（按钮点击、快捷键、菜单项）都收敛为命令 ID。
 * UI 只声明"调用哪个命令"，不直接持有回调 —— 这是快捷键/菜单/命令面板
 * 能零成本覆盖全部功能的前提。
 */
import { evaluateWhen } from './context-keys'

export interface CommandDefinition {
  id: string
  title: string
  category?: string
  /** 条件表达式，不满足时命令不可执行（见 context-keys） */
  when?: string
  run: () => void | Promise<void>
}

export interface CommandEntry extends CommandDefinition {
  id: string
}

const registry = new Map<string, CommandEntry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function registerCommand(definition: CommandDefinition): () => void {
  if (registry.has(definition.id)) {
    console.warn(`[commands] 重复注册命令，后者覆盖前者: ${definition.id}`)
  }
  registry.set(definition.id, { ...definition })
  notify()

  return () => {
    if (registry.get(definition.id) === undefined) return
    registry.delete(definition.id)
    notify()
  }
}

export function registerCommands(definitions: CommandDefinition[]): () => void {
  const disposers = definitions.map(registerCommand)
  return () => disposers.forEach((dispose) => dispose())
}

export function getCommand(id: string): CommandEntry | undefined {
  return registry.get(id)
}

export function getAllCommands(): CommandEntry[] {
  return [...registry.values()].sort((a, b) => a.title.localeCompare(b.title))
}

/** 命令当前是否可执行（when 条件满足） */
export function isCommandEnabled(id: string): boolean {
  const entry = registry.get(id)
  return !!entry && evaluateWhen(entry.when)
}

/**
 * 执行命令。
 *
 * 不做静默吞异常：命令是功能入口，失败必须可见，
 * 否则用户只会看到"点了没反应"。
 */
export async function executeCommand(id: string): Promise<void> {
  const entry = registry.get(id)
  if (!entry) {
    console.warn(`[commands] 未注册的命令: ${id}`)
    return
  }
  if (!evaluateWhen(entry.when)) return

  try {
    await entry.run()
  } catch (err) {
    console.error(`[commands] 命令执行失败: ${id}`, err)
  }
}

export function onCommandsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
