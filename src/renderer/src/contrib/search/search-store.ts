/**
 * 全局搜索状态（模块级 store）
 *
 * 状态放在这里而不是组件 useState：侧边栏切换视图会卸载组件，
 * 搜索条件与结果必须保留（VS Code 的搜索视图隐藏后再打开也不丢状态）。
 *
 * 前端持有一份与主进程同语义的匹配实现（literal/regex/全字/大小写），
 * 用于：点击结果时计算列号 → 编辑器选中高亮；以及结果行的片段着色。
 */
import { useSyncExternalStore } from 'react'
import type {
  FilesExclude,
  ReplacePreviewOutcome,
  SearchHit,
  SearchOptions,
  SearchOutcome
} from '@shared/ipc'
import { getAppSettings, onAppSettingsChanged } from '@renderer/core/app-context'
import { documentKey, openFile, reloadDocuments } from '@renderer/core/editor/editor-store'
import { setLayout } from '@renderer/core/platform/layout-state'
import { paths } from '@renderer/core/workspace/fs-client'

export interface SearchState {
  query: string
  replaceQuery: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  include: string
  exclude: string
  /** 是否套用设置里的排除规则（对应 VS Code 的 Use Exclude Settings and Ignore Files） */
  useExcludeSettings: boolean
  replaceVisible: boolean
  filtersVisible: boolean
  hits: SearchHit[]
  truncated: boolean
  strategy: 'git' | 'scan' | null
  errorMessage: string | null
  searching: boolean
  /** 折叠的文件（相对路径 → true） */
  collapsed: Record<string, boolean>
  /** 当前选中命中：`相对路径:行号` */
  selectedKey: string | null
  /** 搜索框输入历史（最近在前，最多 20 条） */
  history: string[]
  /** 自增计数：变化即要求搜索输入框夺回焦点 */
  focusSeq: number
  replaceBusy: boolean
  replaceMessage: string | null
  /** 替换预览（照搬 VS Code Replace Preview：全部替换前确认） */
  previewVisible: boolean
  previewOutcome: ReplacePreviewOutcome | null
  previewBusy: boolean
}

interface SearchSnapshot extends SearchState {
  /** 供 memo 依赖的选项序列（引用稳定） */
  optionsKey: string
}

let state: SearchState = {
  query: '',
  replaceQuery: '',
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  include: '',
  exclude: '',
  useExcludeSettings: true,
  replaceVisible: false,
  filtersVisible: false,
  hits: [],
  truncated: false,
  strategy: null,
  errorMessage: null,
  searching: false,
  collapsed: {},
  selectedKey: null,
  history: [],
  focusSeq: 0,
  replaceBusy: false,
  replaceMessage: null,
  previewVisible: false,
  previewOutcome: null,
  previewBusy: false
}

const listeners = new Set<() => void>()

/** useSyncExternalStore 要求 getSnapshot 引用稳定：state 不变时必须返回同一对象 */
let snapshotCache: SearchSnapshot | null = null

function setState(patch: Partial<SearchState>): void {
  state = { ...state, ...patch }
  snapshotCache = null
  for (const listener of listeners) listener()
}

export function getSearchState(): SearchSnapshot {
  if (!snapshotCache) {
    const { query, caseSensitive, wholeWord, useRegex, include, exclude, useExcludeSettings } =
      state
    const optionsKey = JSON.stringify({
      query,
      caseSensitive,
      wholeWord,
      useRegex,
      include,
      exclude,
      useExcludeSettings,
      // 设置里的排除表也进 key：在设置页改完规则，回到搜索页应立刻按新规则重搜
      excludes: activeExcludes()
    })
    snapshotCache = { ...state, optionsKey }
  }
  return snapshotCache
}

export function onSearchChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSearch(): SearchSnapshot {
  return useSyncExternalStore(onSearchChanged, getSearchState)
}

export function patchSearch(patch: Partial<SearchState>): void {
  setState(patch)
}

/** Ctrl+Shift+F / 命令面板调用：确保搜索视图打开且输入框聚焦 */
export function requestSearchFocus(): void {
  setState({ focusSeq: state.focusSeq + 1 })
  setLayout({ activeView: 'search', sidebarVisible: true })
}

export function getSearchOptions(): SearchOptions {
  return {
    caseSensitive: state.caseSensitive,
    wholeWord: state.wholeWord,
    useRegex: state.useRegex,
    include: state.include,
    exclude: state.exclude
  }
}

/**
 * 传给主进程的递归排除表：settings 的 files.exclude 与 search.exclude 合并，
 * search 侧同名键覆盖 files 侧 —— 与 VS Code 的 search.exclude 语义一致。
 *
 * 渲染层读设置、随请求传参，而不是让主进程自己读：主进程保持无状态，
 * 且改完设置立刻生效，不必等主进程的缓存刷新。
 */
export function getSearchExcludes(): FilesExclude {
  const settings = getAppSettings()
  return { ...settings.filesExclude, ...settings.searchExclude }
}

/** 关掉「使用排除设置」时不带排除规则（用户的临时排除框仍然有效） */
function activeExcludes(): FilesExclude {
  return state.useExcludeSettings ? getSearchExcludes() : {}
}

/**
 * 设置一变就作废快照并广播。
 *
 * optionsKey 里含排除表，但它是在 getSearchState 里惰性算出来的 ——
 * 只有 snapshotCache 失效、订阅者被通知，React 才会重算 optionsKey，
 * SearchView 的 effect 才会按新规则重搜。改设置不碰 search-store 的 state，
 * 没有这条订阅就得等下次输入才生效。
 */
onAppSettingsChanged(() => {
  snapshotCache = null
  for (const listener of listeners) listener()
})

// ── 搜索执行 ──

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let runSeq = 0

/** 输入/选项变化后调度：300ms 防抖，清空立即生效 */
export function scheduleSearch(root: string | null): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (!state.query.trim() || !root) {
    setState({ hits: [], truncated: false, strategy: null, errorMessage: null, searching: false })
    return
  }
  // setState 放定时器内：避免 effect 同步触发级联渲染（react-compiler 约束）
  debounceTimer = setTimeout(() => {
    void runSearch(root)
  }, 300)
}

/** 立即搜索（防抖到期 / 刷新按钮 / 替换完成后） */
export async function runSearch(root: string): Promise<void> {
  const query = state.query.trim()
  if (!query) {
    setState({ hits: [], truncated: false, strategy: null, errorMessage: null, searching: false })
    return
  }

  const seq = runSeq + 1
  runSeq = seq
  setState({ searching: true })

  try {
    const outcome: SearchOutcome = await window.aether.search.query(
      root,
      query,
      getSearchOptions(),
      activeExcludes()
    )
    if (seq !== runSeq) return // 已有更新的搜索，丢弃过期响应
    setState({
      hits: outcome.hits,
      truncated: outcome.truncated,
      strategy: outcome.strategy,
      errorMessage: outcome.error ?? null,
      searching: false,
      collapsed: {},
      selectedKey: null
    })
    rememberHistory(query)
  } catch {
    if (seq !== runSeq) return
    setState({ searching: false, errorMessage: '搜索失败', hits: [], truncated: false })
  }
}

function rememberHistory(query: string): void {
  const next = [query, ...state.history.filter((item) => item !== query)].slice(0, 20)
  setState({ history: next })
}

/** 历史导航：返回上一条/下一条；没有则返回 null（保持现值） */
export function navigateHistory(direction: 1 | -1): string | null {
  const { history, query } = state
  if (history.length === 0) return null
  const index = history.indexOf(query)
  if (direction === -1) {
    // 向上翻更早的：当前不在历史里则从第 0 条开始
    const next = index < 0 ? 0 : Math.min(index + 1, history.length - 1)
    return history[next]
  }
  if (index <= 0) return index === 0 ? '' : null // 已是最新一条 → 清空回到输入态
  return history[index - 1]
}

export function clearSearch(): void {
  setState({
    query: '',
    hits: [],
    truncated: false,
    strategy: null,
    errorMessage: null,
    searching: false,
    selectedKey: null
  })
}

export function toggleCollapse(path: string): void {
  setState({ collapsed: { ...state.collapsed, [path]: !state.collapsed[path] } })
}

/**
 * 结果区键盘导航：按可视顺序（展开的文件组内命中行）上/下移动选中。
 * 返回移动后的选中 key；无法移动返回 null（保持现值）。
 */
export function moveSelection(
  groups: { path: string; hits: SearchHit[] }[],
  direction: 1 | -1
): string | null {
  const flat = groups.flatMap((group) => (state.collapsed[group.path] ? [] : group.hits))
  if (flat.length === 0) return null
  const index = flat.findIndex((hit) => `${hit.path}:${hit.line}` === state.selectedKey)
  const next =
    index < 0
      ? direction === 1
        ? 0
        : flat.length - 1
      : Math.min(Math.max(index + direction, 0), flat.length - 1)
  const target = flat[next]
  if (!target) return null
  const key = `${target.path}:${target.line}`
  if (key === state.selectedKey) return null
  setState({ selectedKey: key })
  return key
}

export function setAllCollapsed(paths: string[], collapsed: boolean): void {
  const next: Record<string, boolean> = {}
  if (collapsed) for (const path of paths) next[path] = true
  setState({ collapsed: next })
}

// ── 命中匹配（与主进程 buildRegExp 同语义）──

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compileMatchRegExp(query: string, options: SearchOptions): RegExp | null {
  const source = options.useRegex ? query : escapeRegExp(query)
  const wrapped = options.wholeWord ? `\\b(?:${source})\\b` : source
  try {
    return new RegExp(wrapped, options.caseSensitive ? '' : 'i')
  } catch {
    return null
  }
}

/** 在命中行文本上算出匹配位置（编辑器跳转高亮用）；算不出返回 null（退化为行首） */
export function matchOnLine(
  text: string,
  query: string,
  options: SearchOptions
): { index: number; length: number } | null {
  const regex = compileMatchRegExp(query, options)
  if (!regex) return null
  const found = regex.exec(text)
  if (!found || found[0].length === 0) return null
  return { index: found.index, length: found[0].length }
}

// ── 结果导航 ──

export function selectHit(root: string, hit: SearchHit): void {
  const query = state.query.trim()
  setState({ selectedKey: `${hit.path}:${hit.line}` })

  const match = query ? matchOnLine(hit.text, query, getSearchOptions()) : null
  const filePath = paths.join(root, hit.path)
  // 列号从 1 起（Monaco 列号语义）
  void openFile(filePath, hit.line, match ? match.index + 1 : undefined, match?.length)
  setLayout({ activeEditorView: documentKey(filePath) })
}

// ── 替换预览与执行 ──

/** 「全部替换」入口：先出预览确认（VS Code 的 Replace Preview 流程） */
export async function openReplacePreview(root: string): Promise<void> {
  const query = state.query.trim()
  if (!query || state.previewBusy) return
  setState({ previewVisible: true, previewBusy: true, previewOutcome: null })

  try {
    const outcome = await window.aether.search.preview(
      root,
      query,
      getSearchOptions(),
      state.replaceQuery,
      activeExcludes()
    )
    setState({ previewBusy: false, previewOutcome: outcome })
  } catch {
    setState({
      previewBusy: false,
      previewOutcome: { files: [], total: 0, truncated: false, error: '生成预览失败' }
    })
  }
}

export function closeReplacePreview(): void {
  setState({ previewVisible: false, previewOutcome: null })
}

/** 预览确认后真正执行替换 */
export async function confirmReplacePreview(root: string): Promise<void> {
  closeReplacePreview()
  await replaceAll(root)
}

// ── 全局替换 ──

export async function replaceAll(root: string): Promise<void> {
  const query = state.query.trim()
  if (!query || state.replaceBusy) return
  // 结果被 MAX_HITS 截断时禁止全部替换：替换走主进程重新全量扫，
  // 会改掉用户在结果里没看到的文件 —— 所见与所改范围不一致
  if (state.truncated) {
    setState({ replaceMessage: '结果已达上限、不完整，无法安全地全部替换。请缩小搜索范围后重试' })
    return
  }
  setState({ replaceBusy: true, replaceMessage: null })

  try {
    const outcome = await window.aether.search.replace(
      root,
      query,
      getSearchOptions(),
      state.replaceQuery,
      activeExcludes()
    )
    if (outcome.error) {
      setState({ replaceBusy: false, replaceMessage: outcome.error })
      return
    }
    // 已打开的文档重读磁盘（有未保存修改的文档会被跳过，避免盖掉用户编辑）
    await reloadDocuments(outcome.files.map((rel) => paths.join(root, rel)))
    setState({
      replaceBusy: false,
      replaceMessage: `已替换 ${outcome.replacements} 处（${outcome.files.length} 个文件）`
    })
    await runSearch(root) // 替换后结果已变化，立即刷新
  } catch {
    setState({ replaceBusy: false, replaceMessage: '替换失败' })
  }
}
