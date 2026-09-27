/**
 * 全局搜索（主进程）
 *
 * 两条路径：
 *   1. git 仓库内用 `git grep` —— 快、自动跳过忽略文件，--untracked
 *      让 Agent 刚新建的文件也能被搜到；
 *   2. 非 git 仓库退回 Node 遍历 —— 跳过依赖/构建目录，限制文件大小
 *      与命中数，保证大仓库不会拖死 UI。
 *
 * 选项对齐 VS Code 搜索视图：大小写（Aa）、全字（ab）、正则（.*）、
 * 包含/排除文件 glob。git grep 用 -F（字面量）/-E（扩展正则）+ pathspec；
 * 正则语法 git 不支持时（如后行断言）自动退回 JS RegExp 遍历，语义一致。
 *
 * 排除规则来自调用方（渲染层把设置里的 files.exclude + search.exclude 合并后传来）：
 * 两条路径都必须过滤，否则搜索结果会随仓库是否为 git 而变。
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  FilesExclude,
  ReplaceOutcome,
  ReplacePreviewFile,
  ReplacePreviewLine,
  ReplacePreviewOutcome,
  SearchHit,
  SearchOptions,
  SearchOutcome
} from '@shared/ipc'
import { compileSearchExclude, isSearchExcluded, toGitPathspec } from './exclude'

/**
 * 遍历兜底时无条件跳过的目录名。
 *
 * 这些是「不可能有人搜索」的目录，与用户设置无关：.git 里全是二进制对象，
 * 搜它只会拖慢速度。用户的 files.exclude / search.exclude 另行叠加。
 */
const SKIP_DIRS = new Set(['.git'])

const MAX_FILE_BYTES = 512 * 1024
const MAX_HITS = 500
const MAX_LINE_CHARS = 240
/** 替换预览的展示行数上限；total 仍统计真实替换数，不受影响 */
const MAX_PREVIEW_ROWS = 500

const EMPTY_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  include: '',
  exclude: ''
}

/** 把查询与选项编译成 JS RegExp（遍历搜索与替换共用，保证语义一致） */
function buildRegExp(query: string, options: SearchOptions, global: boolean): RegExp | null {
  const source = options.useRegex ? query : escapeRegExp(query)
  const wrapped = options.wholeWord ? `\\b(?:${source})\\b` : source
  try {
    return new RegExp(wrapped, `${options.caseSensitive ? '' : 'i'}${global ? 'g' : ''}`)
  } catch {
    return null
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 字面量替换时 $ 不能被解释成捕获组引用 */
function escapeReplacement(text: string): string {
  return text.replaceAll('$', '$$')
}

/** 逗号分隔的 glob 输入 → 去空白的 pattern 列表 */
function splitGlobs(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * 工作区全文搜索。
 *
 * @param excludes 递归排除表（settings 的 files.exclude 与 search.exclude 已由
 *                 调用方合并；searchExclude 的同名键覆盖 filesExclude）。
 *                 缺省表示不额外排除 —— 主进程不读设置，保持无状态。
 */
export function searchWorkspace(
  root: string,
  query: string,
  options: SearchOptions = EMPTY_OPTIONS,
  excludes: FilesExclude = {}
): Promise<SearchOutcome> {
  const trimmed = query.trim()
  if (!trimmed) return Promise.resolve({ hits: [], truncated: false, strategy: 'git' })

  return gitGrep(root, trimmed, options, excludes).catch(() =>
    walkScan(root, trimmed, options, excludes)
  )
}

/**
 * 按搜索条件对命中文件做「文件内全部替换」并写盘。
 * 文件清单来自同一套搜索逻辑；与 VS Code 一样替换作用于文件内所有命中
 * （不只是当前展示的结果行）。
 */
export async function replaceWorkspace(
  root: string,
  query: string,
  options: SearchOptions,
  replaceText: string,
  excludes: FilesExclude = {}
): Promise<ReplaceOutcome> {
  const trimmed = query.trim()
  if (!trimmed) return { files: [], replacements: 0 }

  const regex = buildRegExp(trimmed, options, true)
  if (!regex) return { files: [], replacements: 0, error: '正则表达式无效' }

  const outcome = await searchWorkspace(root, trimmed, options, excludes)
  if (outcome.error) return { files: [], replacements: 0, error: outcome.error }

  const replacement = options.useRegex ? replaceText : escapeReplacement(replaceText)
  const files: string[] = []
  let replacements = 0

  for (const rel of new Set(outcome.hits.map((hit) => hit.path))) {
    const abs = join(root, rel)
    let content: string
    try {
      const buffer = await readFile(abs)
      // 与搜索侧一致：过大文件不动；含 NUL 视为二进制，替换会损坏内容
      if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) continue
      content = buffer.toString('utf8')
    } catch {
      continue
    }

    const count = content.match(regex)?.length ?? 0
    if (count === 0) continue // 搜索结果与磁盘内容已不同步，跳过而不是盲目写

    const updated = content.replace(regex, replacement)
    if (updated === content) continue

    try {
      await writeFile(abs, updated, 'utf8')
    } catch {
      continue
    }
    files.push(rel)
    replacements += count
  }

  return { files, replacements }
}

/**
 * 生成替换预览（照搬 VS Code 的 Replace Preview：执行前逐行确认 before → after）。
 * 与 replaceWorkspace 同一套搜索/文件限制/替换语义，保证「看到的即替换的」。
 */
export async function previewReplaceWorkspace(
  root: string,
  query: string,
  options: SearchOptions,
  replaceText: string,
  excludes: FilesExclude = {}
): Promise<ReplacePreviewOutcome> {
  const trimmed = query.trim()
  if (!trimmed) return { files: [], total: 0, truncated: false }

  const regex = buildRegExp(trimmed, options, true)
  if (!regex) return { files: [], total: 0, truncated: false, error: '正则表达式无效' }

  const outcome = await searchWorkspace(root, trimmed, options, excludes)
  if (outcome.error) return { files: [], total: 0, truncated: false, error: outcome.error }

  const replacement = options.useRegex ? replaceText : escapeReplacement(replaceText)
  const files: ReplacePreviewFile[] = []
  let total = 0
  let rows = 0
  let truncated = false

  for (const rel of new Set(outcome.hits.map((hit) => hit.path))) {
    let content: string
    try {
      const buffer = await readFile(join(root, rel))
      if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) continue
      content = buffer.toString('utf8')
    } catch {
      continue
    }

    const lines: ReplacePreviewLine[] = []
    const split = content.split('\n')
    for (let i = 0; i < split.length; i += 1) {
      // match 带 /g 正则返回全部命中，不受 lastIndex 影响；null = 本行无命中
      const matches = split[i].match(regex)
      if (!matches) continue
      const after = split[i].replace(regex, replacement)
      if (after === split[i]) continue
      total += matches.length
      if (rows < MAX_PREVIEW_ROWS) {
        lines.push({
          line: i + 1,
          before: split[i].slice(0, MAX_LINE_CHARS),
          after: after.slice(0, MAX_LINE_CHARS)
        })
        rows += 1
      } else {
        truncated = true
      }
    }
    if (lines.length > 0) files.push({ path: rel, lines })
  }

  return { files, total, truncated }
}

/** git grep 输出 `相对路径:行号:文本`；仓库外/非仓库时进程失败走兜底 */
function gitGrep(
  root: string,
  query: string,
  options: SearchOptions,
  excludes: FilesExclude
): Promise<SearchOutcome> {
  return new Promise((resolve, reject) => {
    // -F 字面量 / -E 扩展正则；-i 大小写；-w 全字匹配（对整个 pattern 生效）
    const args = ['grep', '-n', '-I', '--untracked', options.useRegex ? '-E' : '-F']
    if (!options.caseSensitive) args.push('-i')
    if (options.wholeWord) args.push('-w')
    args.push('-e', query, '--')

    // 包含/排除走 pathspec：include 为空 = 全仓库；exclude 用 pathspec 魔法
    const includes = splitGlobs(options.include)
    const excludesFromBox = splitGlobs(options.exclude)
    if (includes.length > 0) args.push(...includes)
    else args.push('.')
    for (const pattern of excludesFromBox) args.push(`:(exclude)${pattern}`)

    // 设置里的排除表：同一套 glob 语义（无分隔符 = 任意层级），交给 git 时必须
    // 转成 pathspec 魔法，否则裸写只匹配顶层，结果与遍历兜底不一致
    for (const [pattern, on] of Object.entries(excludes)) {
      if (!on) continue
      args.push(...toGitPathspec(pattern))
    }

    execFile(
      'git',
      args,
      { cwd: root, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // exit 1 = 无匹配（正常返回空结果）；其他非零才是真的失败
        if (error && error.code !== 1) {
          reject(error)
          return
        }
        const hits: SearchHit[] = []
        for (const row of stdout.split('\n')) {
          if (row.length === 0) continue
          const first = row.indexOf(':')
          const second = row.indexOf(':', first + 1)
          if (first < 0 || second < 0) continue
          const line = Number(row.slice(first + 1, second))
          if (!Number.isInteger(line)) continue
          hits.push({
            path: row.slice(0, first).replaceAll('\\', '/'),
            line,
            text: row.slice(second + 1, second + 1 + MAX_LINE_CHARS)
          })
          if (hits.length >= MAX_HITS) break
        }
        resolve({ hits, truncated: hits.length >= MAX_HITS, strategy: 'git' })
      }
    )
  })
}

/** 单条 glob → 相对路径正则。** 跨目录，* 不跨目录；不带 / 的 pattern 匹配任意深度 */
function globToRegExp(glob: string): RegExp {
  const deep = !glob.includes('/')
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += glob[i + 2] === '/' ? (i === 0 ? '(?:.*/)?' : '.*') : '.*'
        i += glob[i + 2] === '/' ? 2 : 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegExp(char)
    }
  }
  return new RegExp(deep ? `^(?:.*/)?${source}$` : `^${source}$`)
}

interface PathFilter {
  raw: string
  regex: RegExp
}

function compileFilters(value: string): PathFilter[] {
  return splitGlobs(value).map((raw) => ({ raw, regex: globToRegExp(raw) }))
}

function pathMatches(rel: string, filters: PathFilter[]): boolean {
  return filters.some(
    ({ raw, regex }) => rel === raw || rel.startsWith(`${raw}/`) || regex.test(rel)
  )
}

async function walkScan(
  root: string,
  query: string,
  options: SearchOptions,
  excludes: FilesExclude
): Promise<SearchOutcome> {
  const regex = buildRegExp(query, options, false)
  if (!regex) {
    return { hits: [], truncated: false, strategy: 'scan', error: '正则表达式无效' }
  }
  const includes = compileFilters(options.include)
  const boxExcludes = compileFilters(options.exclude)
  const ruleExcludes = compileSearchExclude(excludes)
  const hits: SearchHit[] = []

  // 箭头函数常量（非提升的函数声明）：保证 TS 对 regex 判空后的类型收窄在闭包内生效
  const scanDir = async (relative: string): Promise<void> => {
    if (hits.length >= MAX_HITS) return
    const entries = await readdir(join(root, relative || '.'), { withFileTypes: true })
    for (const entry of entries) {
      if (hits.length >= MAX_HITS) return
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      // 目录命中即剪枝：连 readdir 都不做，这才是排除目录真正省时间的地方
      if (isSearchExcluded(ruleExcludes, rel, entry.name)) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await scanDir(rel)
        continue
      }
      if (!entry.isFile()) continue
      if (includes.length > 0 && !pathMatches(rel, includes)) continue
      if (boxExcludes.length > 0 && pathMatches(rel, boxExcludes)) continue

      let content: string
      try {
        const buffer = await readFile(join(root, rel))
        if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) continue
        content = buffer.toString('utf8')
      } catch {
        continue
      }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        regex.lastIndex = 0
        if (regex.test(lines[i])) {
          hits.push({ path: rel, line: i + 1, text: lines[i].slice(0, MAX_LINE_CHARS) })
          if (hits.length >= MAX_HITS) return
        }
      }
    }
  }

  await scanDir('')
  return { hits, truncated: hits.length >= MAX_HITS, strategy: 'scan' }
}
