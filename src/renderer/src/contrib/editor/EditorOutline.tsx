import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { languages } from 'monaco-editor'
import { getEditorState, onEditorChanged } from '@renderer/core/editor/editor-store'
import { fileIdentity } from '@renderer/core/editor/file-identity'
import { focusEditorGroup, useEditorGroups } from '@renderer/core/editor/editor-groups'
import { monaco } from '@renderer/core/editor/monaco-setup'
import { openWorkspaceResource } from '@renderer/core/editor/monaco-workspace'
import {
  invalidateDocumentSymbols,
  watchDocumentSymbols,
  type DocumentSymbolsSnapshot
} from '@renderer/core/editor/document-symbols'
import {
  documentSymbolKey,
  documentSymbolKindLabel,
  filterDocumentSymbols,
  findDocumentSymbolPath
} from '@renderer/core/editor/document-symbol-utils'
import { Icon } from '@renderer/workbench/icons'
import './editor-outline.css'

export interface EditorOutlineProps {
  filePath: string | null
  groupId?: string
  className?: string
}

const INITIAL: DocumentSymbolsSnapshot = { status: 'loading', symbols: [] }

export function EditorOutline({
  filePath,
  groupId,
  className = ''
}: EditorOutlineProps): JSX.Element {
  const { focusedGroupId } = useEditorGroups()
  const [expanded, setExpanded] = useState(true)
  const [followCursor, setFollowCursor] = useState(true)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [snapshot, setSnapshot] = useState<DocumentSymbolsSnapshot>(INITIAL)
  const [retry, setRetry] = useState(0)
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const cursor = useSyncExternalStore(onEditorChanged, () => getEditorState().cursor)

  useEffect(() => {
    setCollapsed(new Set())
    setNavigationError(null)
    if (!filePath) {
      setSnapshot(INITIAL)
      return
    }
    return watchDocumentSymbols(filePath, setSnapshot)
  }, [filePath, retry])

  const activePath = useMemo(() => {
    if (
      (groupId && groupId !== focusedGroupId) ||
      !filePath ||
      !cursor ||
      fileIdentity(cursor.filePath) !== fileIdentity(filePath)
    )
      return []
    return findDocumentSymbolPath(snapshot.symbols, {
      lineNumber: cursor.line,
      column: cursor.column
    })
  }, [filePath, groupId, focusedGroupId, cursor, snapshot.symbols])
  const activeKey = activePath.length ? documentSymbolKey(activePath[activePath.length - 1]) : null
  const filtered = useMemo(
    () => filterDocumentSymbols(snapshot.symbols, query),
    [snapshot.symbols, query]
  )

  useEffect(() => {
    if (!followCursor) return
    setCollapsed((previous) => {
      const next = new Set(previous)
      for (const symbol of activePath.slice(0, -1)) next.delete(documentSymbolKey(symbol))
      return next.size === previous.size ? previous : next
    })
  }, [activePath, followCursor])

  useEffect(() => {
    if (!followCursor || !expanded || !activeKey) return
    listRef.current
      ?.querySelector<HTMLElement>('[aria-current="location"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeKey, expanded, followCursor, collapsed])

  const toggleBranch = (key: string): void =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const collapseAll = (): void => {
    const keys = new Set<string>()
    const collect = (symbols: languages.DocumentSymbol[]): void => {
      for (const symbol of symbols) {
        if (symbol.children?.length) {
          keys.add(documentSymbolKey(symbol))
          collect(symbol.children)
        }
      }
    }
    collect(snapshot.symbols)
    setCollapsed(keys)
  }
  const navigate = async (symbol: languages.DocumentSymbol): Promise<void> => {
    if (!filePath) return
    if (groupId) focusEditorGroup(groupId)
    setNavigationError(null)
    try {
      await openWorkspaceResource(monaco.Uri.file(filePath), symbol.selectionRange)
    } catch (error) {
      setNavigationError(`无法跳转：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const renderSymbols = (symbols: languages.DocumentSymbol[], depth = 0): JSX.Element => (
    <ul className="editor-outline__list">
      {symbols.map((symbol) => {
        const key = documentSymbolKey(symbol)
        const hasChildren = Boolean(symbol.children?.length)
        const branchExpanded = Boolean(query.trim()) || !collapsed.has(key)
        return (
          <li key={key}>
            <div className="editor-outline__row" style={{ paddingLeft: `${depth * 12}px` }}>
              {hasChildren ? (
                <button
                  type="button"
                  className="editor-outline__branch"
                  aria-label={`${branchExpanded ? '折叠' : '展开'} ${symbol.name}`}
                  aria-expanded={branchExpanded}
                  onClick={() => toggleBranch(key)}
                  disabled={Boolean(query.trim())}
                >
                  <Icon name={branchExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
                </button>
              ) : (
                <span className="editor-outline__branch-spacer" />
              )}
              <button
                type="button"
                className="editor-outline__symbol"
                aria-current={activeKey === key ? 'location' : undefined}
                title={`${documentSymbolKindLabel(symbol.kind)} ${symbol.name}${symbol.detail ? ` — ${symbol.detail}` : ''}`}
                onClick={() => void navigate(symbol)}
              >
                <span className="editor-outline__kind" aria-hidden="true">
                  {documentSymbolKindLabel(symbol.kind)}
                </span>
                <span className="editor-outline__name">{symbol.name}</span>
                <span className="editor-outline__line" aria-hidden="true">
                  {symbol.selectionRange.startLineNumber}
                </span>
              </button>
            </div>
            {hasChildren && branchExpanded ? renderSymbols(symbol.children ?? [], depth + 1) : null}
          </li>
        )
      })}
    </ul>
  )

  return (
    <section className={`editor-outline ${className}`} aria-label="文件大纲">
      <header className="editor-outline__header">
        <button
          type="button"
          className="editor-outline__heading"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
          <span>大纲</span>
        </button>
        {expanded ? (
          <div className="editor-outline__actions">
            <button
              type="button"
              title="跟随光标"
              aria-label="跟随光标"
              aria-pressed={followCursor}
              onClick={() => setFollowCursor(!followCursor)}
            >
              <Icon name="locate" size={14} />
            </button>
            <button
              type="button"
              title="展开全部符号"
              aria-label="展开全部符号"
              onClick={() => setCollapsed(new Set())}
            >
              <Icon name="chevron-down" size={14} />
            </button>
            <button
              type="button"
              title="折叠全部符号"
              aria-label="折叠全部符号"
              onClick={collapseAll}
            >
              <Icon name="collapse-all" size={14} />
            </button>
            <button
              type="button"
              title="刷新大纲"
              aria-label="刷新大纲"
              disabled={!filePath || snapshot.status === 'loading'}
              onClick={() => {
                if (filePath) invalidateDocumentSymbols(filePath)
                setRetry((value) => value + 1)
              }}
            >
              <Icon name="restart" size={14} />
            </button>
          </div>
        ) : null}
      </header>
      {expanded ? (
        <>
          <input
            className="editor-outline__filter"
            aria-label="筛选大纲符号"
            placeholder="筛选符号…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="editor-outline__content" ref={listRef}>
            {!filePath ? (
              <p className="editor-outline__message">打开源文件以查看大纲</p>
            ) : snapshot.status !== 'ready' ? (
              <p
                className="editor-outline__message"
                role={snapshot.status === 'error' ? 'alert' : 'status'}
              >
                {snapshot.message ?? '正在加载大纲…'}
              </p>
            ) : filtered.length ? (
              renderSymbols(filtered)
            ) : (
              <p className="editor-outline__message">
                {query.trim() ? '没有匹配的符号' : '此文件没有可显示的符号'}
              </p>
            )}
            {navigationError ? (
              <p className="editor-outline__error" role="alert">
                {navigationError}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  )
}
