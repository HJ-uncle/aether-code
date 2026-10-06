import type { FilesExclude, ReplaceOutcome, ReplacePreviewOutcome, SearchOptions, SearchOutcome } from '@shared/ipc'

export interface RemoteWorkspaceItem {
  name: string
  type: 'file' | 'dir'
  path?: string
  size?: number
  children?: RemoteWorkspaceItem[]
}
export interface RemoteContent {
  content: string
  isBinary: boolean
  totalSize?: number
  originalLength?: number
}
export interface RemoteSearchTransport {
  assertCurrent(): void
  listFiles(): Promise<RemoteWorkspaceItem>
  readFile(path: string): Promise<RemoteContent>
  writeFile(path: string, content: string): Promise<void>
}

const MAX_HITS = 500
const MAX_LINE_CHARS = 240
const MAX_TEXT_SIZE = 500 * 1024

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function remoteSearchRegExp(query: string, options: SearchOptions, global = false): RegExp | null {
  const source = options.useRegex ? query : escapeRegExp(query)
  try { return new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, `${global ? 'g' : ''}${options.caseSensitive ? '' : 'i'}`) }
  catch { return null }
}

function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] === '*') {
      if (glob[i + 1] === '*') {
        source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
        i += glob[i + 2] === '/' ? 2 : 1
      } else source += '[^/]*'
    } else source += glob[i] === '?' ? '[^/]' : escapeRegExp(glob[i])
  }
  return new RegExp(glob.includes('/') ? `^${source}$` : `^(?:.*/)?${source}$`)
}

function matches(path: string, pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const regex = globToRegExp(normalized)
  // Matching a directory excludes all descendants, including globbed dirs.
  const parts = path.split('/')
  return parts.some((_, index) => regex.test(parts.slice(0, index + 1).join('/')))
}

function selected(path: string, options: SearchOptions, excludes: FilesExclude): boolean {
  const includes = options.include.split(',').map(value => value.trim()).filter(Boolean)
  const excluded = options.exclude.split(',').map(value => value.trim()).filter(Boolean)
  return (!includes.length || includes.some(pattern => matches(path, pattern))) &&
    !excluded.some(pattern => matches(path, pattern)) &&
    !Object.entries(excludes).some(([pattern, enabled]) => enabled && matches(path, pattern))
}

/** Ignore the root label; retain every directory level in relative API paths. */
export function flattenRemoteFiles(tree: RemoteWorkspaceItem): string[] {
  const files: string[] = []
  const visit = (node: RemoteWorkspaceItem, parent: string): void => {
    if (!node.name || node.name === '.' || node.name === '..' || /[/\\\u0000]/.test(node.name)) throw new Error('远端目录包含无效文件名')
    const path = parent ? `${parent}/${node.name}` : node.name
    if (node.type === 'file') files.push(path)
    else for (const child of node.children ?? []) visit(child, path)
  }
  for (const child of tree.children ?? []) visit(child, '')
  return [...new Set(files)]
}

function incomplete(content: RemoteContent): boolean {
  // The server appends a truncation notice, so originalLength > content.length
  // alone cannot detect files just above the 500 KB character cutoff.
  return (content.originalLength ?? 0) > MAX_TEXT_SIZE ||
    (typeof content.originalLength === 'number' && content.originalLength !== content.content.length)
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function issueSummary(issues: string[]): string | undefined {
  return issues.length ? `有 ${issues.length} 个文件未处理：${issues.slice(0, 3).join('；')}${issues.length > 3 ? '…' : ''}` : undefined
}

async function readSelected(transport: RemoteSearchTransport, path: string, issues: string[]): Promise<string | null> {
  transport.assertCurrent()
  try {
    const file = await transport.readFile(path)
    transport.assertCurrent()
    if (file.isBinary || file.content.includes('\0')) return null
    if (incomplete(file)) { issues.push(`${path}（内容被服务端截断）`); return null }
    return file.content
  } catch (error) {
    // A connection change must stop the scan, not become a recoverable file error.
    transport.assertCurrent()
    issues.push(`${path}（${message(error)}）`)
    return null
  }
}

async function filesFor(transport: RemoteSearchTransport, options: SearchOptions, excludes: FilesExclude): Promise<string[]> {
  transport.assertCurrent()
  const tree = await transport.listFiles()
  transport.assertCurrent()
  return flattenRemoteFiles(tree).filter(path => selected(path, options, excludes))
}

export async function searchRemoteWorkspace(transport: RemoteSearchTransport, query: string, options: SearchOptions, excludes: FilesExclude): Promise<SearchOutcome> {
  const regex = remoteSearchRegExp(query, options)
  if (!regex) return { hits: [], truncated: false, strategy: 'scan', error: '正则表达式无效' }
  const hits: SearchOutcome['hits'] = []
  const issues: string[] = []
  for (const path of await filesFor(transport, options, excludes)) {
    const content = await readSelected(transport, path, issues)
    if (content === null) continue
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) continue
      hits.push({ path, line: index + 1, text: lines[index].slice(0, MAX_LINE_CHARS) })
      if (hits.length >= MAX_HITS) return { hits, truncated: true, strategy: 'scan', error: issueSummary(issues) }
    }
  }
  return { hits, truncated: issues.length > 0, strategy: 'scan', error: issueSummary(issues) }
}

function replaced(content: string, regex: RegExp, replacement: string, literal: boolean): string {
  // A callback keeps dollar signs literal; string replacement would interpret
  // $&, $1, $` and $' even after a single replaceAll('$', '$$').
  return literal ? content.replace(regex, () => replacement) : content.replace(regex, replacement)
}

export async function previewRemoteReplace(transport: RemoteSearchTransport, query: string, options: SearchOptions, replacement: string, excludes: FilesExclude): Promise<ReplacePreviewOutcome> {
  const regex = remoteSearchRegExp(query, options, true)
  if (!regex) return { files: [], total: 0, truncated: false, error: '正则表达式无效' }
  const result: ReplacePreviewOutcome = { files: [], total: 0, truncated: false }
  const issues: string[] = []
  let rows = 0
  for (const path of await filesFor(transport, options, excludes)) {
    const content = await readSelected(transport, path, issues)
    if (content === null) continue
    const lines = content.split(/\r?\n/)
    const previews: ReplacePreviewOutcome['files'][number]['lines'] = []
    for (let index = 0; index < lines.length; index += 1) {
      const count = lines[index].match(regex)?.length ?? 0
      if (!count) continue
      const after = replaced(lines[index], regex, replacement, !options.useRegex)
      if (after === lines[index]) continue
      result.total += count
      if (rows++ < MAX_HITS) previews.push({ line: index + 1, before: lines[index].slice(0, MAX_LINE_CHARS), after: after.slice(0, MAX_LINE_CHARS) })
      else result.truncated = true
    }
    // The line-based preview cannot truthfully represent a cross-line match.
    if ((content.match(regex)?.length ?? 0) > lines.reduce((count, line) => count + (line.match(regex)?.length ?? 0), 0)) {
      issues.push(`${path}（跨行正则替换需要在编辑器中确认）`)
    }
    if (previews.length) result.files.push({ path, lines: previews })
  }
  result.truncated ||= issues.length > 0
  result.error = issueSummary(issues)
  return result
}

export async function replaceRemoteWorkspace(transport: RemoteSearchTransport, query: string, options: SearchOptions, replacement: string, excludes: FilesExclude): Promise<ReplaceOutcome> {
  const regex = remoteSearchRegExp(query, options, true)
  if (!regex) return { files: [], replacements: 0, error: '正则表达式无效' }
  const result: ReplaceOutcome = { files: [], replacements: 0 }
  const issues: string[] = []
  try {
    for (const path of await filesFor(transport, options, excludes)) {
      const content = await readSelected(transport, path, issues)
      if (content === null) continue
      const count = content.match(regex)?.length ?? 0
      if (!count) continue
      const updated = replaced(content, regex, replacement, !options.useRegex)
      if (updated === content) continue
      try {
        transport.assertCurrent()
        await transport.writeFile(path, updated)
        result.files.push(path)
        result.replacements += count
        transport.assertCurrent()
      } catch (error) {
        issues.push(`${path}（${message(error)}）`)
        transport.assertCurrent()
      }
    }
  } catch (error) {
    issues.push(message(error))
  }
  const detail = issueSummary(issues)
  if (detail) result.error = `已替换 ${result.replacements} 处（${result.files.length} 个文件）；${detail}`
  return result
}
