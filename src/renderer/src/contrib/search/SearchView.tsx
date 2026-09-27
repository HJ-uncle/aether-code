import {
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import type { SearchHit } from '@shared/ipc'
import { Icon } from '@renderer/workbench/icons'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { openAppSettings } from '@renderer/contrib/settings/app-settings-navigation'
import {
  clearSearch,
  closeReplacePreview,
  confirmReplacePreview,
  moveSelection,
  navigateHistory,
  openReplacePreview,
  patchSearch,
  runSearch,
  scheduleSearch,
  selectHit,
  setAllCollapsed,
  toggleCollapse,
  useSearch
} from './search-store'

interface FileGroup {
  path: string
  hits: SearchHit[]
}

/**
 * 全局搜索视图（侧边栏，形态照搬 VS Code）
 *
 * 选项开关：大小写 Aa / 全字 ab / 正则 .*；替换条（默认收起）；
 * 包含/排除文件过滤（默认收起）；结果树按文件分组可折叠。
 * 「使用排除设置」控制是否套用设置里的 files.exclude + search.exclude。
 * 全部状态在 search-store，切换视图后不丢；点击结果跳编辑器并高亮匹配。
 */
export function SearchView(): JSX.Element {
  const workspace = useWorkspace()
  const root = workspace.root
  const search = useSearch()

  const inputRef = useRef<HTMLInputElement>(null)
  const lastFocusSeq = useRef(0)

  // 打开视图即聚焦输入框（VS Code 行为）；Ctrl+Shift+F 重复触发时夺回焦点
  useEffect(() => {
    if (search.focusSeq !== lastFocusSeq.current) {
      lastFocusSeq.current = search.focusSeq
    }
    const timer = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(timer)
  }, [search.focusSeq])

  // 输入或任一选项变化 → 防抖重搜
  useEffect(() => {
    scheduleSearch(root)
  }, [root, search.optionsKey])

  const groups = useMemo<FileGroup[]>(() => {
    const byPath = new Map<string, SearchHit[]>()
    for (const hit of search.hits) {
      const list = byPath.get(hit.path)
      if (list) list.push(hit)
      else byPath.set(hit.path, [hit])
    }
    return [...byPath.entries()].map(([path, hits]) => ({ path, hits }))
  }, [search.hits])

  const allPaths = useMemo(() => groups.map((group) => group.path), [groups])
  const allCollapsed = allPaths.length > 0 && allPaths.every((path) => search.collapsed[path])

  // 键盘选中项跟随滚动（ref 操作，无状态更新）
  const resultsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    resultsRef.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [search.selectedKey])

  /** 结果区键盘导航：↑↓ 移动选中，Enter 打开（焦点保持在结果区） */
  const onResultsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(groups, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' && root) {
      event.preventDefault()
      const hit = search.hits.find((item) => `${item.path}:${item.line}` === search.selectedKey)
      if (hit) selectHit(root, hit)
    }
  }

  return (
    <div className="search-view" aria-label="搜索">
      <div className="search-view__widget">
        {/* ── 搜索行 ── */}
        <div className="search-view__row">
          <button
            type="button"
            className={`search-view__reveal${search.replaceVisible ? ' is-open' : ''}`}
            aria-label={search.replaceVisible ? '隐藏替换' : '显示替换'}
            title={search.replaceVisible ? '隐藏替换' : '显示替换'}
            onClick={() => patchSearch({ replaceVisible: !search.replaceVisible })}
          >
            <Icon name="chevron-right" size={12} />
          </button>
          <div className="search-view__field">
            <input
              ref={inputRef}
              className="search-view__input"
              type="text"
              placeholder="搜索"
              aria-label="搜索内容"
              spellCheck={false}
              value={search.query}
              onChange={(event) => patchSearch({ query: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  const value = navigateHistory(event.key === 'ArrowUp' ? -1 : 1)
                  if (value !== null) {
                    event.preventDefault()
                    patchSearch({ query: value })
                  }
                } else if (event.key === 'Enter' && root) {
                  void runSearch(root)
                }
              }}
            />
            {search.query ? (
              <button
                type="button"
                className="search-view__btn"
                aria-label="清空搜索"
                title="清空"
                onClick={() => clearSearch()}
              >
                <Icon name="close" size={12} />
              </button>
            ) : null}
            <button
              type="button"
              className={`search-view__toggle${search.caseSensitive ? ' is-on' : ''}`}
              aria-label="区分大小写"
              aria-pressed={search.caseSensitive}
              title="区分大小写"
              onClick={() => patchSearch({ caseSensitive: !search.caseSensitive })}
            >
              Aa
            </button>
            <button
              type="button"
              className={`search-view__toggle${search.wholeWord ? ' is-on' : ''}`}
              aria-label="全字匹配"
              aria-pressed={search.wholeWord}
              title="全字匹配"
              onClick={() => patchSearch({ wholeWord: !search.wholeWord })}
            >
              ab
            </button>
            <button
              type="button"
              className={`search-view__toggle${search.useRegex ? ' is-on' : ''}`}
              aria-label="使用正则表达式"
              aria-pressed={search.useRegex}
              title="使用正则表达式"
              onClick={() => patchSearch({ useRegex: !search.useRegex })}
            >
              .*
            </button>
          </div>
        </div>

        {/* ── 替换行 ── */}
        {search.replaceVisible ? (
          <div className="search-view__row">
            <span className="search-view__row-spacer" />
            <div className="search-view__field">
              <input
                className="search-view__input"
                type="text"
                placeholder="替换为"
                aria-label="替换为"
                spellCheck={false}
                value={search.replaceQuery}
                onChange={(event) => patchSearch({ replaceQuery: event.target.value })}
              />
              <button
                type="button"
                className="search-view__btn search-view__replace-all"
                aria-label="全部替换"
                title="全部替换（先预览确认）"
                disabled={search.replaceBusy || !root || !search.query.trim()}
                onClick={() => root && void openReplacePreview(root)}
              >
                全部替换
              </button>
            </div>
          </div>
        ) : null}

        {/* ── 工具行：过滤开关 + 刷新 / 折叠 / 清空 ── */}
        <div className="search-view__row search-view__tools">
          <button
            type="button"
            className={`search-view__btn${search.filtersVisible ? ' is-on' : ''}`}
            aria-label="切换文件过滤"
            title="包含与排除文件"
            onClick={() => patchSearch({ filtersVisible: !search.filtersVisible })}
          >
            ⋯
          </button>
          <label className="search-view__check" title="取消后忽略设置里的文件排除 / 搜索排除规则">
            <input
              type="checkbox"
              checked={search.useExcludeSettings}
              onChange={(event) => patchSearch({ useExcludeSettings: event.target.checked })}
            />
            使用排除设置
          </label>
          <span className="search-view__tools-spacer" />
          <button
            type="button"
            className="search-view__btn"
            aria-label="刷新搜索"
            title="刷新"
            disabled={!root || !search.query.trim()}
            onClick={() => root && void runSearch(root)}
          >
            <Icon name="restart" size={12} />
          </button>
          <button
            type="button"
            className="search-view__btn"
            aria-label={allCollapsed ? '全部展开' : '全部折叠'}
            title={allCollapsed ? '全部展开' : '全部折叠'}
            disabled={allPaths.length === 0}
            onClick={() => setAllCollapsed(allPaths, !allCollapsed)}
          >
            <Icon name="collapse-all" size={12} />
          </button>
          <button
            type="button"
            className="search-view__btn"
            aria-label="清空搜索结果"
            title="清空"
            disabled={!search.query.trim()}
            onClick={() => clearSearch()}
          >
            <Icon name="close" size={12} />
          </button>
        </div>

        {/* ── 包含 / 排除过滤 ── */}
        {search.filtersVisible ? (
          <div className="search-view__filters">
            <label className="search-view__filter">
              <span>包含</span>
              <input
                className="search-view__filter-input"
                type="text"
                placeholder="例如：src, *.ts"
                spellCheck={false}
                value={search.include}
                onChange={(event) => patchSearch({ include: event.target.value })}
              />
            </label>
            <label className="search-view__filter">
              <span>排除</span>
              <input
                className="search-view__filter-input"
                type="text"
                placeholder="例如：dist, **/*.min.js"
                spellCheck={false}
                value={search.exclude}
                onChange={(event) => patchSearch({ exclude: event.target.value })}
              />
            </label>
            <button
              type="button"
              className="search-view__filter-link"
              title="编辑设置里的搜索排除规则（search.exclude）"
              onClick={() => openAppSettings('search')}
            >
              编辑搜索排除设置…
            </button>
          </div>
        ) : null}
      </div>

      {/* ── 结果区 ── */}
      {!root ? (
        <div className="notice">尚未打开文件夹。</div>
      ) : !search.query.trim() ? (
        <div className="search-view__hint">输入关键词，在工作区内搜索文件内容。</div>
      ) : (
        <div
          className="search-view__results"
          ref={resultsRef}
          tabIndex={0}
          aria-label="搜索结果"
          onKeyDown={onResultsKeyDown}
        >
          <div className="search-view__summary">
            {search.errorMessage ? (
              <span className="search-view__error">{search.errorMessage}</span>
            ) : search.searching ? (
              '搜索中…'
            ) : (
              <>
                {groups.length} 个文件 {search.hits.length} 处命中
                {search.strategy === 'scan' ? '（非 git 仓库，遍历搜索）' : ''}
                {search.truncated ? '，结果已达上限' : ''}
                {search.replaceMessage ? (
                  <span className="search-view__replace-note">{search.replaceMessage}</span>
                ) : null}
              </>
            )}
          </div>

          {groups.map((group) => {
            const collapsed = Boolean(search.collapsed[group.path])
            return (
              <div key={group.path} className="search-view__group">
                <button
                  type="button"
                  className={`search-view__file${collapsed ? ' is-collapsed' : ''}`}
                  title={group.path}
                  onClick={() => toggleCollapse(group.path)}
                >
                  <Icon name={collapsed ? 'chevron-right' : 'chevron'} size={11} />
                  <span className="search-view__file-name">{group.path.split('/').pop()}</span>
                  <span className="search-view__file-dir">
                    {group.path.split('/').slice(0, -1).join('/')}
                  </span>
                  <span className="search-view__file-count">{group.hits.length}</span>
                </button>
                {!collapsed
                  ? group.hits.map((hit) => {
                      const key = `${hit.path}:${hit.line}`
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`search-view__hit${search.selectedKey === key ? ' is-selected' : ''}`}
                          title={`第 ${hit.line} 行`}
                          onClick={() => root && selectHit(root, hit)}
                        >
                          <span className="search-view__hit-line">{hit.line}</span>
                          <Highlighted
                            text={hit.text}
                            query={search.query.trim()}
                            caseSensitive={search.caseSensitive}
                            wholeWord={search.wholeWord}
                            useRegex={search.useRegex}
                          />
                        </button>
                      )
                    })
                  : null}
              </div>
            )
          })}
        </div>
      )}

      {/* ── 替换预览（照搬 VS Code Replace Preview：确认后才真正写盘）── */}
      {search.previewVisible ? (
        <div className="replace-preview-overlay" onMouseDown={closeReplacePreview}>
          <div
            className="replace-preview"
            role="dialog"
            aria-label="替换预览"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="replace-preview__header">
              <span>
                {search.previewBusy
                  ? '正在生成替换预览…'
                  : search.previewOutcome?.error
                    ? search.previewOutcome.error
                    : `将替换 ${search.previewOutcome?.total ?? 0} 处（${search.previewOutcome?.files.length ?? 0} 个文件）${
                        search.previewOutcome?.truncated ? '，预览已截断' : ''
                      }`}
              </span>
              <span className="replace-preview__spacer" />
              <button
                type="button"
                className="replace-preview__apply"
                disabled={
                  search.previewBusy || !search.previewOutcome || search.previewOutcome.total === 0
                }
                onClick={() => root && void confirmReplacePreview(root)}
              >
                应用替换
              </button>
              <button
                type="button"
                className="replace-preview__cancel"
                onClick={closeReplacePreview}
              >
                取消
              </button>
            </div>
            <div className="replace-preview__body">
              {search.previewOutcome?.files.map((file) => (
                <div key={file.path} className="replace-preview__file">
                  <div className="replace-preview__file-name">{file.path}</div>
                  {file.lines.map((row) => (
                    <div key={`${file.path}:${row.line}`} className="replace-preview__row">
                      <span className="replace-preview__line">{row.line}</span>
                      <Highlighted
                        text={row.before}
                        query={search.query.trim()}
                        caseSensitive={search.caseSensitive}
                        wholeWord={search.wholeWord}
                        useRegex={search.useRegex}
                      />
                      <span className="replace-preview__arrow">→</span>
                      <span className="replace-preview__after">{row.after}</span>
                    </div>
                  ))}
                </div>
              ))}
              {!search.previewBusy && (search.previewOutcome?.files.length ?? 0) === 0 ? (
                <div className="replace-preview__empty">
                  没有可替换的内容（结果可能已过期，请刷新搜索）。
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 命中行内逐段着色：与搜索同一套匹配语义（正则/全字/大小写） */
function Highlighted({
  text,
  query,
  caseSensitive,
  wholeWord,
  useRegex
}: {
  text: string
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
}): JSX.Element {
  const parts = useMemo(() => {
    const source = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const wrapped = wholeWord ? `\\b(?:${source})\\b` : source
    let regex: RegExp | null = null
    try {
      regex = new RegExp(wrapped, caseSensitive ? 'g' : 'gi')
    } catch {
      regex = null
    }
    if (!regex) return [{ text, hit: false }]

    const segments: { text: string; hit: boolean }[] = []
    let cursor = 0
    for (let found = regex.exec(text); found; found = regex.exec(text)) {
      if (found.index > cursor) segments.push({ text: text.slice(cursor, found.index), hit: false })
      segments.push({ text: found[0], hit: true })
      cursor = found.index + found[0].length
      if (found[0].length === 0) regex.lastIndex += 1
      if (cursor >= text.length) break
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false })
    return segments
  }, [text, query, caseSensitive, wholeWord, useRegex])

  return (
    <span className="search-view__hit-text">
      {parts.map((part, i) =>
        part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>
      )}
    </span>
  )
}
