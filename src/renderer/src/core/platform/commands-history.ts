/**
 * 命令面板最近使用（MRU，照搬 VS Code CommandsHistory）
 *
 * 从命令面板执行的命令记入 LRU（上限 50，与 VS Code 默认一致），
 * localStorage 持久化；面板无输入时 MRU 置顶并以「最近使用」分组展示。
 * 只记录面板内执行：键位/菜单触发的命令不算「使用过」（与 VS Code 一致）。
 */
const STORAGE_KEY = 'aether.commandMru'
const MAX_ENTRIES = 50

function load(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

let mru: string[] = load()

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mru))
  } catch {
    // 存储不可用只影响跨会话历史，不影响功能
  }
}

/** 命令面板内执行时调用：提到最前，去重，截断上限 */
export function recordCommandRun(id: string): void {
  const next = [id, ...mru.filter((item) => item !== id)].slice(0, MAX_ENTRIES)
  if (next.length === mru.length && next.every((item, i) => item === mru[i])) return
  mru = next
  persist()
}

export function getCommandMru(): string[] {
  return mru
}
