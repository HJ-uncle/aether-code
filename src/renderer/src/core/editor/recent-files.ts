/**
 * 最近打开的文件（Ctrl+P 快速打开无输入时展示，对齐 VS Code 的编辑器历史）
 *
 * 任何途径打开成功的文件都记录（编辑器标签 / 搜索结果 / 快速打开）；
 * 上限 20 条，localStorage 持久化跨会话保留。历史里可能混有其他项目
 * 的路径，按当前工作区过滤是调用方（QuickOpen）的职责，这里只存取。
 */
const STORAGE_KEY = 'aether.recentFiles'
const MAX_RECENT = 20

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

let recent: string[] = load()

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recent))
  } catch {
    // 存储不可用（隐私模式等）只影响跨会话历史，不影响功能
  }
}

/** 记录一次成功打开（提到最前，去重） */
export function rememberRecent(filePath: string): void {
  const next = [filePath, ...recent.filter((item) => item !== filePath)].slice(0, MAX_RECENT)
  if (next.length === recent.length && next.every((item, i) => item === recent[i])) return
  recent = next
  persist()
}

export function getRecentFiles(): string[] {
  return recent
}
