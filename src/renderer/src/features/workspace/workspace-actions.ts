import type { FsEntry } from '@shared/ipc'
import { paths } from '@renderer/core/workspace/fs-client'
import { fileTreePathKey } from '@renderer/core/workspace/file-tree-memory'

/** Names remain single entries so a typo cannot create or move another branch. */
export function validateSessionEntryName(name: string): string | null {
  if (!name.trim()) return '名称不能为空'
  if (/[\\/]/.test(name)) return '名称不能包含路径分隔符（/ 或 \\）'
  if (name === '.' || name === '..' || /[<>:"|?*\u0000-\u001f]/.test(name)) return '名称包含不可用的字符'
  if (/[. ]$/.test(name)) return '名称不能以空格或句点结尾'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return '此名称为系统保留名称'
  return null
}

/** An ancestor already owns its descendants; never mutate the same tree twice. */
export function sessionOperationPaths(input: readonly string[], root: string): string[] {
  const unique = [...new Map(input.filter(path => paths.contains(root, path) && fileTreePathKey(path) !== fileTreePathKey(root))
    .map(path => [fileTreePathKey(path), path])).values()]
  return unique.filter(path => !unique.some(parent => parent !== path && paths.contains(parent, path)))
}

export function sessionCopyName(name: string, isDirectory: boolean, entries: readonly FsEntry[]): string {
  const occupied = new Set(entries.map(entry => entry.name.toLocaleLowerCase()))
  if (!occupied.has(name.toLocaleLowerCase())) return name
  const dot = isDirectory ? -1 : name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name, suffix = dot > 0 ? name.slice(dot) : ''
  for (let index = 1; index < 10_000; index++) {
    const candidate = `${stem} 副本${index === 1 ? '' : ` ${index}`}${suffix}`
    if (!occupied.has(candidate.toLocaleLowerCase())) return candidate
  }
  throw new Error('副本名称过多，请重命名后再复制')
}
