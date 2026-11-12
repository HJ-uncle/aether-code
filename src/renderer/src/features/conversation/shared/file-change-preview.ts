import hljs from 'highlight.js'
import type { EngineFileChange } from '@shared/ipc'
import type { DiffRow } from './diff'

/** Keep the inline preview readable without making a single file fill the conversation. */
export const FILE_CHANGE_PREVIEW_ROWS = 60

export type FileChangePreviewRow = DiffRow | { type: 'gap'; count: number }

/** 快照用于统计和撤回，聊天预览只保留改动附近的上下文，避免从文件首行开始截断。 */
export function compactFileChangeRows(rows: readonly DiffRow[], contextLines = 3): FileChangePreviewRow[] {
  const context = Math.max(0, Math.floor(contextLines))
  const ranges: { start: number; end: number }[] = []
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].type === 'context') continue
    const start = Math.max(0, index - context)
    const end = Math.min(rows.length, index + context + 1)
    const previous = ranges.at(-1)
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end)
    else ranges.push({ start, end })
  }
  if (ranges.length === 0) return []

  const preview: FileChangePreviewRow[] = []
  let cursor = 0
  for (const { start, end } of ranges) {
    if (start > cursor) preview.push({ type: 'gap', count: start - cursor })
    for (let index = start; index < end; index++) preview.push(rows[index])
    cursor = end
  }
  if (cursor < rows.length) preview.push({ type: 'gap', count: rows.length - cursor })
  return preview
}

/** 省略提示不占代码行配额，也不能单独制造一个「更多差异」按钮。 */
export function takeFileChangePreviewRows(rows: readonly FileChangePreviewRow[], limit: number): FileChangePreviewRow[] {
  let count = 0
  let end = 0
  while (end < rows.length) {
    if (rows[end].type !== 'gap') {
      if (count >= limit) break
      count++
    }
    end++
  }
  return rows.slice(0, end)
}

export function fileChangeInitiallyCollapsed(change: Pick<EngineFileChange, 'kind'>): boolean {
  return change.kind === 'delete'
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', mdx: 'markdown', yaml: 'yaml', yml: 'yaml',
  py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  sql: 'sql', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
  toml: 'ini', ini: 'ini', conf: 'ini', dockerfile: 'dockerfile'
}

export function fileChangeLanguage(path: string): string | undefined {
  const name = path.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? ''
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  return LANGUAGE_BY_EXTENSION[name.split('.').at(-1) ?? '']
}

function escapeCode(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Only highlight known languages; guessing a large plain-text diff is costly and misleading. */
export function highlightFileChangeLine(text: string, language: string | undefined): string {
  if (!language || text.length > 8_000 || !hljs.getLanguage(language)) return escapeCode(text)
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value
  } catch {
    return escapeCode(text)
  }
}
