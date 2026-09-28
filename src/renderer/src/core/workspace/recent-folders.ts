/**
 * 最近打开的项目目录（欢迎页「最近打开」区块的数据源）
 *
 * 与 recent-files.ts 同构：模块级数组 + localStorage 持久化，跨会话保留。
 * 上限 8 条 —— 欢迎页是「挑一个上次的项目继续」的入口，列太长反而难找。
 *
 * 记录时机是「成功打开」而非「用户点击打开」：启动时自动恢复的 lastFolder
 * 也算一次使用，下次仍应出现在列表最前。
 */
const STORAGE_KEY = 'aether.recentFolders'
const MAX_RECENT = 8

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
const listeners = new Set<() => void>()

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recent))
  } catch {
    // 存储不可用（隐私模式等）只影响跨会话历史，不影响功能
  }
}

export function onRecentFoldersChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 记录一次成功打开的目录（提到最前，去重） */
export function rememberRecentFolder(folder: string): void {
  const next = [folder, ...recent.filter((item) => item !== folder)].slice(0, MAX_RECENT)
  if (next.length === recent.length && next.every((item, i) => item === recent[i])) return
  recent = next
  persist()
  for (const listener of listeners) listener()
}

export function getRecentFolders(): string[] {
  return recent
}

/** 从列表移除（目录已删除等场景，避免用户反复点到打不开的项） */
export function forgetRecentFolder(folder: string): void {
  const next = recent.filter((item) => item !== folder)
  if (next.length === recent.length) return
  recent = next
  persist()
  for (const listener of listeners) listener()
}
