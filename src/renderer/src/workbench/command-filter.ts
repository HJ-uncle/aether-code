/**
 * 命令列表过滤（命令面板与快速打开的 `>` 命令模式共用）
 *
 * 排序照搬 VS Code CommandsQuickAccess：无输入时 MRU 置顶并分
 * 「最近使用 / 其他命令」两组；有输入时按模糊得分排序。
 */
import type { CommandEntry } from '@renderer/core/platform/commands'
import { getAllCommands } from '@renderer/core/platform/commands'
import { getCommandMru } from '@renderer/core/platform/commands-history'
import { fuzzyMatch } from '@renderer/core/platform/fuzzy'

export interface CommandItem {
  entry: CommandEntry
  /** title 内模糊命中的字符下标（供高亮） */
  positions: number[]
}

export interface CommandGroup {
  /** 分组标签；null 表示不显示标签（单一列表） */
  label: string | null
  items: CommandItem[]
}

export function buildCommandItems(query: string): CommandGroup[] {
  const q = query.trim()
  const commands = getAllCommands()

  if (!q) {
    // 无输入：MRU 置顶，其余按 title 字母序（getAllCommands 已排好）
    const byId = new Map(commands.map((entry) => [entry.id, entry]))
    const recentItems = getCommandMru()
      .map((id) => byId.get(id))
      .filter((entry): entry is CommandEntry => entry !== undefined)
      .map((entry) => ({ entry, positions: [] }))
    const recentIds = new Set(recentItems.map((item) => item.entry.id))
    const otherItems = commands
      .filter((entry) => !recentIds.has(entry.id))
      .map((entry) => ({ entry, positions: [] }))
    if (recentItems.length === 0) return [{ label: null, items: otherItems }]
    return [
      { label: '最近使用', items: recentItems },
      { label: '其他命令', items: otherItems }
    ]
  }

  // 有输入：对「分类: 标题」整体模糊匹配，得分排序，平分按字母序
  const scored: { item: CommandItem; score: number }[] = []
  for (const entry of commands) {
    const target = entry.category ? `${entry.category}: ${entry.title}` : entry.title
    const matched = fuzzyMatch(q, target)
    if (!matched) continue
    const offset = entry.category ? entry.category.length + 2 : 0
    const positions = matched.positions.filter((p) => p >= offset).map((p) => p - offset)
    scored.push({ item: { entry, positions }, score: matched.score })
  }
  scored.sort((a, b) => b.score - a.score || a.item.entry.title.localeCompare(b.item.entry.title))
  return [{ label: null, items: scored.map(({ item }) => item) }]
}
