import type { SearchOptions } from '@shared/ipc'
import { getSearchExcludes, matchOnLine, type SearchState } from './search-store'
import type { SearchPanelActions, SearchPanelSnapshot } from './SearchView'
import { previewRemoteReplace, replaceRemoteWorkspace, remoteSearchRegExp, type RemoteContent } from './remote-search'
import { paths, type SessionFileTarget } from '@renderer/core/workspace/fs-client'
import { requestSessionPreviews } from '@renderer/core/workbench/preview-request'
import type { TextPreviewReveal } from '@renderer/core/editor/TextPreview'
import { createSessionSearchTransport, sessionSearchFileTree } from './search-transport'
import { startSessionSearch } from './search-api'

const emptyState = (): SearchState => ({ query: '', replaceQuery: '', caseSensitive: false, wholeWord: false, useRegex: false,
  include: '', exclude: '', useExcludeSettings: true, replaceVisible: false, filtersVisible: false, hits: [], truncated: false,
  strategy: null, errorMessage: null, searching: false, collapsed: {}, selectedKey: null, history: [], focusSeq: 0,
  replaceBusy: false, replaceMessage: null, previewVisible: false, previewOutcome: null, previewBusy: false })
const optionFields: (keyof SearchState)[] = ['query', 'caseSensitive', 'wholeWord', 'useRegex', 'include', 'exclude', 'useExcludeSettings']
const errorMessage = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/** Each task has its own request generations and replacement plan. Neither a
 * hidden Code search nor a late response from another task can change them. */
export function createSessionSearchController(target: SessionFileTarget, current: () => boolean,
  open: (path: string, reveal: TextPreviewReveal) => void) {
  let state = emptyState()
  let snapshot: SearchPanelSnapshot
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let sequence = 0, previewSequence = 0, revision = 0
  let replacing = false
  let activeSearch: ReturnType<typeof startSessionSearch> | undefined
  let previewSearch: ReturnType<typeof startSessionSearch> | undefined
  let plan: { query: string; replacement: string; options: SearchOptions; originals: Map<string, RemoteContent>; paths: Set<string> } | undefined
  const options = (): SearchOptions => ({ caseSensitive: state.caseSensitive, wholeWord: state.wholeWord,
    useRegex: state.useRegex, include: state.include, exclude: state.exclude })
  const excludes = () => state.useExcludeSettings ? getSearchExcludes() : {}
  const optionsKey = (): string => JSON.stringify([state.query, options(), excludes(), state.useExcludeSettings])
  const publish = (patch: Partial<SearchState> = {}): void => {
    state = { ...state, ...patch }
    snapshot = { ...state, optionsKey: optionsKey() }
    for (const listener of listeners) listener()
  }
  const cancelSearch = (): void => { sequence++; clearTimeout(timer); timer = undefined; activeSearch?.cancel(); activeSearch = undefined }
  const clearPreview = (): void => { previewSequence++; previewSearch?.cancel(); previewSearch = undefined; plan = undefined; publish({ previewVisible: false, previewBusy: false, previewOutcome: null }) }
  const search = async (): Promise<void> => {
    cancelSearch()
    if (!current() || !state.query.trim()) return
    const request = sequence, query = state.query.trim(), config = options(), excluded = excludes()
    publish({ searching: true, hits: [], errorMessage: null, selectedKey: null })
    const owns = (): boolean => current() && request === sequence
    try {
      activeSearch = startSessionSearch(target, owns, query, config, excluded, state.useExcludeSettings)
      const result = await activeSearch.promise
      if (!owns()) return
      publish({ hits: result.hits, searching: false, truncated: result.truncated, strategy: result.strategy,
        errorMessage: result.error ?? null, collapsed: {}, history: [query, ...state.history.filter(value => value !== query)].slice(0, 20) })
    } catch (reason) { if (owns()) publish({ searching: false, hits: [], errorMessage: errorMessage(reason) }) }
    finally { if (owns()) activeSearch = undefined }
  }
  const actions: SearchPanelActions = {
    patchSearch(patch) {
      const changed = optionFields.some(field => field in patch && patch[field] !== state[field])
      if (changed) cancelSearch()
      if (changed || patch.replaceQuery !== undefined) clearPreview()
      publish({ ...patch, ...(changed ? { hits: [], selectedKey: null, searching: Boolean((patch.query ?? state.query).trim()), errorMessage: null, replaceMessage: null } : {}) })
    },
    scheduleSearch() {
      cancelSearch()
      if (!current() || !state.query.trim()) { publish({ hits: [], searching: false, truncated: false, errorMessage: null }); return }
      publish({ searching: true, hits: [], selectedKey: null })
      timer = setTimeout(() => { void search() }, 300)
    },
    runSearch: search,
    cancelSearch() { cancelSearch(); publish({ searching: false }) },
    clearSearch() { cancelSearch(); clearPreview(); publish({ query: '', hits: [], searching: false, truncated: false, strategy: null, selectedKey: null, errorMessage: null, replaceMessage: null }) },
    closeReplacePreview: clearPreview,
    async openReplacePreview() {
      if (!current() || !state.query.trim() || state.previewBusy || replacing) return
      cancelSearch()
      const request = ++previewSequence, query = state.query.trim(), config = options(), excluded = excludes(), replacement = state.replaceQuery
      const owns = (): boolean => current() && request === previewSequence
      publish({ searching: false, previewVisible: true, previewBusy: true, previewOutcome: null })
      const originals = new Map<string, RemoteContent>()
      const matcher = remoteSearchRegExp(query, config)
      try {
        previewSearch = startSessionSearch(target, owns, query, config, excluded, state.useExcludeSettings)
        const found = await previewSearch.promise
        if (!owns()) return
        previewSearch = undefined
        if (found.truncated || found.error) {
          publish({ previewBusy: false, previewOutcome: { files: [], total: 0, truncated: found.truncated,
            error: found.error ?? '搜索结果未完整返回，暂不能全部替换。请缩小关键词范围后重试。' } })
          return
        }
        // The expensive scan is performed once beside the workspace. Only
        // matched files cross the bridge for the explicit replacement preview.
        const transport = createSessionSearchTransport(target, owns, [...new Set(found.hits.map(hit => hit.path))])
        const result = await previewRemoteReplace({ ...transport, async readFile(path) {
          const file = await transport.readFile(path)
          // Unmatched files never participate in a replacement. Retaining the
          // entire workspace here would multiply preview memory needlessly.
          if (matcher && originals.size < 500 && file.content.split(/\r\n|\r|\n/).some(line => matcher.test(line))) originals.set(path, file)
          return file
        } }, query, config, replacement, excluded)
        if (!owns()) return
        plan = !result.truncated && !result.error ? { query, replacement, options: config, originals, paths: new Set(result.files.map(file => file.path)) } : undefined
        publish({ previewBusy: false, previewOutcome: result })
      } catch (reason) { if (owns()) publish({ previewBusy: false, previewOutcome: { files: [], total: 0, truncated: false, error: errorMessage(reason) } }) }
    },
    async confirmReplacePreview() {
      const approved = plan
      if (!approved || !current() || replacing) return
      replacing = true
      const request = previewSequence
      const owns = (): boolean => current() && request === previewSequence
      publish({ previewVisible: false, replaceBusy: true, replaceMessage: null })
      const transport = createSessionSearchTransport(target, owns, [...approved.paths])
      try {
        // Freeze the preview's file set and refuse files changed since it was
        // shown. Confirming a preview never expands to newly matching files.
        const result = await replaceRemoteWorkspace({ ...transport,
          async listFiles() { return sessionSearchFileTree([...approved.paths]) },
          async readFile(path) {
            const file = await transport.readFile(path)
            if (file.content !== approved.originals.get(path)?.content) throw new Error('文件在预览后已变化，请重新搜索并预览')
            return file
          }
        }, approved.query, { ...approved.options, include: '', exclude: '' }, approved.replacement, {})
        const changed = result.files.map(path => paths.join(target.root, path))
        if (changed.length) requestSessionPreviews(target.source, target.sessionId, changed, target.root)
        if (!owns()) return
        publish({ replaceBusy: false, replaceMessage: result.error ?? `已替换 ${result.replacements} 处（${result.files.length} 个文件）` })
        await search()
      } catch (reason) { if (owns()) publish({ replaceBusy: false, replaceMessage: errorMessage(reason) }) }
      finally { replacing = false; if (owns()) plan = undefined; publish({ replaceBusy: false }) }
    },
    selectHit(_root, hit) {
      if (!current() || state.searching || !state.hits.includes(hit)) return
      const match = matchOnLine(hit.text, state.query.trim(), options())
      publish({ selectedKey: `${hit.path}:${hit.line}` })
      open(paths.join(target.root, hit.path), { line: hit.line, column: hit.column ?? (match ? match.index + 1 : undefined), length: hit.length ?? match?.length, revision: ++revision })
    },
    navigateHistory(direction) {
      const index = state.history.indexOf(state.query)
      if (!state.history.length) return null
      return direction === -1 ? state.history[index < 0 ? 0 : Math.min(index + 1, state.history.length - 1)]
        : index <= 0 ? index === 0 ? '' : null : state.history[index - 1]
    },
    toggleCollapse(path) { publish({ collapsed: { ...state.collapsed, [path]: !state.collapsed[path] } }) },
    setAllCollapsed(files, collapsed) { publish({ collapsed: collapsed ? Object.fromEntries(files.map(path => [path, true])) : {} }) },
    moveSelection(groups, direction) {
      const hits = groups.flatMap(group => state.collapsed[group.path] ? [] : group.hits)
      if (!hits.length) return null
      const index = hits.findIndex(hit => `${hit.path}:${hit.line}` === state.selectedKey)
      const hit = hits[index < 0 ? direction > 0 ? 0 : hits.length - 1 : Math.min(hits.length - 1, Math.max(0, index + direction))]
      const key = `${hit.path}:${hit.line}`
      publish({ selectedKey: key }); return key
    }
  }
  publish()
  return { actions, getSnapshot: () => snapshot, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    settingsChanged() {
      if (snapshot.optionsKey === optionsKey()) return
      cancelSearch(); clearPreview(); publish({ hits: [], searching: false })
    },
    suspend() { cancelSearch(); clearPreview(); publish({ searching: false }) } }
}
